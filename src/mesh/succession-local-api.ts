/**
 * Main succession (2.88): local owner door for safe mode.
 *
 * In safe mode no node is Main, so the Desktop/Dashboard API (which follows
 * the Main lease) is not running. This tiny loopback-only endpoint lets the
 * owner, sitting at a main-eligible machine, see the status and enter the
 * emergency code. It never logs request bodies; codes only go to the
 * constant-time gate with lockout.
 *
 *   GET  /nachfolge                 → status text
 *   POST /nachfolge/notfall         {code}            → make this node emergency Main
 *   POST /nachfolge/notfallcode     {code, current?}  → set/replace the code
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export interface SuccessionLocalApiDeps {
    status: () => { mode: string; text: string | null } | null
    claim: (code: string) => Promise<{ ok: boolean; reason: string }>
    setup: (code: string, current?: string) => Promise<{ ok: boolean; reason: string }> | { ok: boolean; reason: string }
    /** Optional owner token (NOVA_DESKTOP_API_TOKEN) required for setting the code. */
    ownerToken?: () => string
}

const MAX_BODY = 4096

function isDirectLoopback(req: IncomingMessage): boolean {
    const remote = String(req.socket.remoteAddress || '')
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false
    const host = String(req.headers.host || '').trim().toLowerCase()
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) return false
    if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip'] || req.headers['x-forwarded-host']) return false
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
    const origin = req.headers.origin
    if (origin !== undefined) {
        try {
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(origin)).hostname)) return false
        } catch { return false }
    }
    return true
}

function tokenMatches(expected: string, supplied: string): boolean {
    const left = Buffer.from(expected)
    const right = Buffer.from(supplied)
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > MAX_BODY) return null
        chunks.push(Buffer.from(chunk))
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch { return null }
}

export function createSuccessionLocalApi(deps: SuccessionLocalApiDeps): { server: Server; listen: (port: number) => Promise<number> } {
    const server = createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(body))
        }
        if (!isDirectLoopback(req)) return send(403, { error: 'Nur direkt an diesem Rechner erlaubt.' })
        const path = String(req.url || '').split('?')[0]
        if (req.method === 'GET' && path === '/nachfolge') {
            return send(200, deps.status() || { mode: 'aus', text: 'Main-Nachfolge ist auf diesem Rechner nicht eingeschaltet.' })
        }
        if (req.method !== 'POST' || !['/nachfolge/notfall', '/nachfolge/notfallcode'].includes(path)) return send(404, { error: 'Nicht gefunden.' })
        const body = await readBody(req)
        const code = typeof body?.code === 'string' ? body.code : ''
        if (!body || !code) return send(400, { ok: false, reason: 'Bitte den Notfallcode eingeben.' })
        if (path === '/nachfolge/notfall') {
            const result = await deps.claim(code)
            return send(result.ok ? 200 : 403, result)
        }
        const expected = deps.ownerToken?.() || ''
        if (expected) {
            const auth = String(req.headers.authorization || '')
            const supplied = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
            if (!tokenMatches(expected, supplied)) return send(401, { ok: false, reason: 'Nur der Owner darf den Notfallcode ändern.' })
        }
        const current = typeof body.current === 'string' ? body.current : undefined
        const result = await deps.setup(code, current)
        return send(result.ok ? 200 : 400, result)
    })
    return {
        server,
        listen: port => new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, '127.0.0.1', () => {
                server.off('error', reject)
                const address = server.address()
                resolve(typeof address === 'object' && address ? address.port : port)
            })
        }),
    }
}
