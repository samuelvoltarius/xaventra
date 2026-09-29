import { createServer, request } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const MAX_IMAGE = 16 * 1024 * 1024
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const digest = (image: Buffer) => createHash('sha256').update(image).digest('hex')
export class CaptureSessionLocked extends Error {
    constructor() { super('Desktop session is locked; unlock locally before capture') }
}
function checkImage(image: Buffer): void {
    if (image.length < 24 || image.length > MAX_IMAGE || !image.subarray(0, 8).equals(PNG)) throw Error('Invalid capture image')
}

/** Runs only inside the operator-enrolled desktop session. No client-supplied
 * executable, flags, destination, environment or display identity is accepted. */
export async function captureSessionDesktop(): Promise<Buffer> {
    if (process.platform !== 'linux' || !process.env.DISPLAY) throw Error('Desktop session unavailable')
    // Never unlock, wake, or bypass the session. Unknown lock state fails closed.
    const lock = await promisify(execFile)('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver',
        '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'], { timeout: 3000, maxBuffer: 4096 })
    if (lock.stdout.trim() === '(true,)') throw new CaptureSessionLocked()
    if (lock.stdout.trim() !== '(false,)') throw Error('Desktop lock state unavailable')
    const root = mkdtempSync(join(tmpdir(), 'xaventra-capture-'))
    try {
        const path = join(root, 'screen.png')
        await promisify(execFile)('/usr/bin/gnome-screenshot', ['--file', path], { timeout: 15_000, maxBuffer: 4096 })
        if (statSync(path).size > MAX_IMAGE) throw Error('Capture exceeds size limit')
        const image = readFileSync(path)
        checkImage(image)
        return image
    } finally {
        // Only this freshly created private temporary directory, never audit data.
        rmSync(root, { recursive: true, force: true })
    }
}

export function createCaptureAgent(token: string, capture = captureSessionDesktop) {
    if (token.length < 32) throw Error('Strong capture token required')
    let busy = false
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        const fail = (status: number, message: string) => { res.statusCode = status; res.end(message) }
        const auth = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${token}`)
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { req.resume(); return fail(401, 'Capture authentication required') }
        if (req.method !== 'POST' || req.url !== '/v1/capture') { req.resume(); return fail(404, 'Unsupported capture operation') }
        let locked = false
        try {
            let body = ''
            for await (const chunk of req) {
                body += chunk
                if (Buffer.byteLength(body) > 512) throw Error('Request exceeds limit')
            }
            const data = JSON.parse(body)
            if (!data || Object.keys(data).length !== 1 || typeof data.requestId !== 'string'
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.requestId)) return fail(400, 'Only a capture request ID is allowed')
            if (busy) return fail(409, 'Capture already in progress')
            busy = true; locked = true
            const image = await capture()
            checkImage(image)
            res.setHeader('Content-Type', 'image/png')
            res.setHeader('Content-Length', image.length)
            res.setHeader('X-Capture-Request', data.requestId)
            res.setHeader('X-Capture-SHA256', digest(image))
            res.end(image)
        } catch (error) {
            fail(error instanceof CaptureSessionLocked ? 423 : 503,
                error instanceof CaptureSessionLocked ? error.message : 'Desktop capture unavailable; no image delivered')
        } finally { if (locked) busy = false }
    })
    server.requestTimeout = 20_000
    server.headersTimeout = 5000
    server.maxHeadersCount = 12
    server.on('connection', socket => socket.setTimeout(25_000, () => socket.destroy()))
    return server
}

/** Local socket and token are operator configuration, never model arguments. */
export async function requestSessionCapture(socketPath: string, tokenFile: string): Promise<Buffer> {
    if (process.platform !== 'linux' || !socketPath.startsWith('/') || !tokenFile.startsWith('/')) throw Error('An enrolled local capture socket is required')
    const socket = statSync(socketPath), secret = statSync(tokenFile)
    if (!socket.isSocket() || (socket.mode & 0o007) || !secret.isFile() || (secret.mode & 0o077)) throw Error('Unsafe capture endpoint permissions')
    const token = readFileSync(tokenFile, 'utf8').trim()
    if (token.length < 32) throw Error('Invalid capture credential')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, method: 'POST', path: '/v1/capture', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
            const chunks: Buffer[] = []; let size = 0
            res.on('data', chunk => { size += chunk.length; if (size > MAX_IMAGE) req.destroy(Error('Capture response exceeds limit')); else chunks.push(chunk) })
            res.on('error', reject)
            res.on('end', () => {
                try {
                    if (res.statusCode === 423) throw new CaptureSessionLocked()
                    if (res.statusCode !== 200 || res.headers['content-type'] !== 'image/png' || res.headers['x-capture-request'] !== requestId) throw Error('Capture failed or receipt mismatch')
                    const image = Buffer.concat(chunks); checkImage(image)
                    if (digest(image) !== res.headers['x-capture-sha256']) throw Error('Capture hash mismatch')
                    resolve(image)
                } catch (error) { reject(error) }
            })
        })
        const timer = setTimeout(() => req.destroy(Error('Capture timed out')), 22_000)
        req.on('error', reject); req.on('close', () => clearTimeout(timer))
        req.end(JSON.stringify({ requestId }))
    })
}

export function listenCaptureAgent(socketPath: string, tokenFile: string) {
    if (process.platform !== 'linux' || !socketPath.startsWith('/') || !tokenFile.startsWith('/')) throw Error('Explicit Linux socket/token paths required')
    if (statSync(tokenFile).mode & 0o077) throw Error('Capture token must be private')
    const server = createCaptureAgent(readFileSync(tokenFile, 'utf8').trim())
    // An existing socket is never unlinked or stolen from another process.
    server.listen(socketPath, () => chmodSync(socketPath, 0o660))
    return server
}
