import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join } from 'node:path'

interface ControlRecord {
    version: 1
    root: string
    pid: number
    instanceId: string
    port: number
    token: string
}

const FILE = 'daemon-control.json'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch (error) {
        // Uninspectable is not evidence of exit. Never send a terminating signal.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
}

function readRecord(root: string): ControlRecord | undefined {
    const path = join(root, '.nova-data', FILE)
    if (!existsSync(path)) return undefined
    if (statSync(path).size > 4096) throw new Error('Invalid local daemon control record')
    const text = readFileSync(path, 'utf8')
    if (text.length > 4096) throw new Error('Invalid local daemon control record')
    let value: ControlRecord
    try { value = JSON.parse(text) } catch { throw new Error('Invalid local daemon control record') }
    if (value?.version !== 1 || value.root !== root || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
        || !/^[a-f0-9-]{36}$/.test(value.instanceId) || !/^[a-f0-9]{64}$/.test(value.token)) {
        throw new Error('Invalid local daemon control record')
    }
    return value
}

/** Local capability only: never publish this record through Mesh, memory or bundles. */
export async function startDaemonControl(rootPath: string, onStop: () => Promise<void> | void) {
    const root = realpathSync.native(rootPath)
    const prior = readRecord(root)
    if (prior && alive(prior.pid)) throw new Error('A live local daemon already owns this runtime')
    const directory = join(root, '.nova-data')
    mkdirSync(directory, { recursive: true })
    const record: ControlRecord = {
        version: 1, root, pid: process.pid, instanceId: randomUUID(), port: 0,
        token: randomBytes(32).toString('hex'),
    }
    let stopping = false
    const server = createServer((req, res) => {
        const provided = Buffer.from(req.headers.authorization || '')
        const expected = Buffer.from(`Bearer ${record.token}`)
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
            res.writeHead(401).end(); return
        }
        if (req.method !== 'POST' || req.url !== `/stop/${record.instanceId}` || req.headers['x-xaventra-pid'] !== String(record.pid)) {
            res.writeHead(404).end(); return
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Connection', 'close')
        if (!stopping) {
            stopping = true
            res.once('finish', () => {
                void Promise.resolve().then(onStop).catch(() => {
                    // The caller must observe real process exit, not this acknowledgement.
                    console.error('[Xaventra] Local shutdown failed; process exit was not confirmed')
                })
            })
        }
        res.end(JSON.stringify({ instanceId: record.instanceId, pid: record.pid, status: 'stopping' }))
    })
    server.requestTimeout = 2000
    server.headersTimeout = 2000
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    record.port = (server.address() as { port: number }).port
    const path = join(directory, FILE)
    const temporary = `${path}.${record.instanceId}.tmp`
    const cleanup = () => {
        try { if (readRecord(root)?.instanceId === record.instanceId) unlinkSync(path) } catch { /* never remove another owner's marker */ }
    }
    try {
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, path)
    } catch (error) {
        server.close()
        try { unlinkSync(temporary) } catch { /* best effort */ }
        throw error
    }
    process.once('exit', cleanup)
    return {
        async close() {
            process.off('exit', cleanup)
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            cleanup()
        },
    }
}

function requestStop(record: ControlRecord, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        // Fixed loopback host; configuration cannot turn this into a remote request.
        const req = request({ hostname: '127.0.0.1', port: record.port, method: 'POST',
            path: `/stop/${record.instanceId}`, headers: { Authorization: `Bearer ${record.token}`, 'X-Xaventra-Pid': String(record.pid) }, agent: false }, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', chunk => {
                body += chunk
                if (body.length > 4096) req.destroy(new Error('Invalid daemon acknowledgement'))
            })
            res.on('error', reject)
            res.on('end', () => {
                try {
                    const ack = JSON.parse(body)
                    if (res.statusCode !== 200 || ack.instanceId !== record.instanceId || ack.pid !== record.pid || ack.status !== 'stopping') {
                        throw new Error('Daemon identity or shutdown acknowledgement did not match')
                    }
                    resolve()
                } catch { reject(new Error('Local daemon did not authenticate the shutdown request')) }
            })
        })
        const timeout = setTimeout(() => req.destroy(new Error('Local daemon control request timed out')), timeoutMs)
        req.once('close', () => clearTimeout(timeout))
        req.once('error', () => reject(new Error('Local daemon control is unavailable; no process was force-stopped')))
        req.end()
    })
}

export async function stopLocalDaemon(rootPath: string, options: { timeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<'stopped' | 'not-running'> {
    const root = realpathSync.native(rootPath)
    const record = readRecord(root)
    const pidPath = join(root, '.nova.pid')
    if (!record) {
        if (existsSync(pidPath)) throw new Error('No authenticated control channel. This daemon may still be starting or be an older version; stop it in its own terminal or service manager.')
        return 'not-running'
    }
    if (existsSync(pidPath) && readFileSync(pidPath, 'utf8').trim() !== String(record.pid)) {
        throw new Error('Local daemon identity markers disagree; stop/restart refused')
    }
    if (!alive(record.pid)) {
        // A stale record is not permission to signal a reused PID or delete another marker.
        return 'not-running'
    }
    const deadline = Date.now() + Math.max(100, options.timeoutMs ?? 20_000)
    await requestStop(record, Math.max(100, options.requestTimeoutMs ?? 2000))
    do {
        const current = readRecord(root)
        if (current && current.instanceId !== record.instanceId) throw new Error('A replacement daemon appeared; restart refused')
        if (existsSync(pidPath) && readFileSync(pidPath, 'utf8').trim() !== String(record.pid)) {
            throw new Error('A replacement daemon PID appeared; restart refused')
        }
        if (!alive(record.pid)) return 'stopped'
        await delay(50)
    } while (Date.now() < deadline)
    throw new Error('Shutdown was requested but process exit was not confirmed; restart refused')
}
