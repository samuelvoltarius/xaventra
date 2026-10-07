/**
 * Xaventra REST API Server
 *
 * Starts when xaventra.config.json has: { "server": { "enabled": true } }
 * Default port: 18789 | Default host: 127.0.0.1
 *
 * Auth: Bearer token via NOVA_API_TOKEN env var
 * Without NOVA_API_TOKEN only loopback development binding is allowed.
 *
 * Identity: the caller can never choose channel/sender. Every message runs as
 * channel `rest-api`; the sender is `rest-api:token` for a valid bearer token
 * and `rest-api:local` for unauthenticated loopback use. `channel`/`from` in
 * the JSON body are ignored. Browsers are kept out: no CORS unless
 * NOVA_API_CORS_ORIGINS lists origins explicitly, POST requires
 * `Content-Type: application/json`, and without a token only loopback Host
 * headers are accepted (DNS rebinding).
 *
 * Endpoints:
 *   GET  /v1/health          — liveness probe, no auth needed
 *   POST /v1/message         — send message through Nova pipeline
 *   GET  /v1/status          — runtime status (auth required)
 */

import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RestApiConfig {
    enabled: boolean
    port: number
    host: string
}

type MessageHandler = (
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
) => Promise<void>

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const REST_API_CHANNEL = 'rest-api'
export const REST_API_TOKEN_PRINCIPAL = 'rest-api:token'
export const REST_API_LOCAL_PRINCIPAL = 'rest-api:local'

/** Constant-time string comparison (hashing first hides length differences). */
function safeEqual(a: string, b: string): boolean {
    const left = createHash('sha256').update(a, 'utf8').digest()
    const right = createHash('sha256').update(b, 'utf8').digest()
    return timingSafeEqual(left, right) && a.length === b.length
}

function checkAuth(req: IncomingMessage): boolean {
    const token = process.env.NOVA_API_TOKEN
    if (!token) return true                         // No token set → loopback-only dev mode (Host check below)
    const header = req.headers['authorization']
    if (typeof header !== 'string') return false
    return safeEqual(header, `Bearer ${token}`)
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Host header without port; bracketed IPv6 stays bracketed. */
function hostHeaderName(req: IncomingMessage): string {
    const host = String(req.headers['host'] ?? '').trim().toLowerCase()
    if (host.startsWith('[')) {
        const end = host.indexOf(']')
        return end > 0 ? host.slice(0, end + 1) : host
    }
    const colon = host.lastIndexOf(':')
    return colon >= 0 ? host.slice(0, colon) : host
}

function allowedCorsOrigins(): string[] {
    return String(process.env.NOVA_API_CORS_ORIGINS ?? '')
        .split(',').map(value => value.trim()).filter(value => value && value !== '*')
}

// ─── Body reader ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ''
        let bytes = 0
        req.on('data', chunk => {
            bytes += chunk.length
            if (bytes > 1_000_000) { reject(new Error('Request body too large')); return }
            body += chunk
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
    })
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
}

/**
 * 2.89 Paket E: a request that carried the valid NOVA_API_TOKEN is the owner's
 * own access (same proof standard as the token-checked Desktop app). Only the
 * token principal is promoted — the open loopback principal never is
 * (reconcileConfiguredOwner demotes it again).
 */
export async function grantRestTokenOwner(principal: string): Promise<void> {
    if (principal !== REST_API_TOKEN_PRINCIPAL) return
    const users = await import('../users/multi-user-middleware.js')
    users.initMultiUser()
    if (users.getUserPermission(principal, REST_API_CHANNEL) === 'owner') return
    users.getOrCreateUser(principal, REST_API_CHANNEL)
    users.setUserPermission(principal, 'owner')
}

export interface RestApiOptions {
    /** Grants the owner role to the token principal (default: multi-user middleware). */
    grantTokenOwner?: (principal: string) => Promise<void> | void
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function startRestApi(
    config: RestApiConfig,
    handleMessage: MessageHandler,
    getStatus: () => Record<string, unknown>,
    options: RestApiOptions = {},
): Promise<Server> {
    const grantTokenOwner = options.grantTokenOwner || grantRestTokenOwner
    return new Promise((resolve, reject) => {
        const apiToken = process.env.NOVA_API_TOKEN
        if (!apiToken && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
            reject(new Error('NOVA_API_TOKEN is required when the REST API listens beyond loopback'))
            return
        }
        if (!apiToken) {
            console.warn('[RestAPI] ⚠ NOVA_API_TOKEN not set — server is open (no auth)!')
        }

        const server = createServer(async (req, res) => {
            const url = req.url ?? '/'
            const method = req.method ?? 'GET'

            // ── DNS rebinding: without a token only loopback Host headers ────────
            if (!process.env.NOVA_API_TOKEN && !LOOPBACK_HOSTNAMES.has(hostHeaderName(req))) {
                json(res, 403, { error: 'Forbidden host' })
                return
            }

            // ── CORS: none by default; only explicitly configured origins ───────
            const origin = typeof req.headers['origin'] === 'string' ? req.headers['origin'] : undefined
            if (origin !== undefined) {
                if (!allowedCorsOrigins().includes(origin)) {
                    json(res, 403, { error: 'Cross-origin requests are not allowed' })
                    return
                }
                res.setHeader('Access-Control-Allow-Origin', origin)
                res.setHeader('Vary', 'Origin')
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            }
            if (method === 'OPTIONS') {
                if (origin === undefined) { json(res, 405, { error: 'Method not allowed' }); return }
                res.writeHead(204); res.end(); return
            }

            // ── GET /v1/health ─────────────────────────────────────────────────
            if (method === 'GET' && url === '/v1/health') {
                json(res, 200, { ok: true, ts: new Date().toISOString() })
                return
            }

            // ── Auth check ─────────────────────────────────────────────────────
            if (!checkAuth(req)) {
                json(res, 401, { error: 'Unauthorized' })
                return
            }

            // ── GET /v1/status ─────────────────────────────────────────────────
            if (method === 'GET' && url === '/v1/status') {
                json(res, 200, { ok: true, ...getStatus() })
                return
            }

            // ── POST /v1/message ───────────────────────────────────────────────
            if (method === 'POST' && url === '/v1/message') {
                const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
                if (contentType !== 'application/json') {
                    json(res, 415, { error: 'Content-Type must be application/json' })
                    return
                }
                let body: { content?: string; from?: string; channel?: string }
                try {
                    body = JSON.parse(await readBody(req))
                } catch {
                    json(res, 400, { error: 'Invalid JSON' })
                    return
                }

                const content = typeof body?.content === 'string' ? body.content.trim() : ''
                if (!content) {
                    json(res, 400, { error: 'content is required' })
                    return
                }

                if ((body.from !== undefined && typeof body.from !== 'string') || (body.channel !== undefined && typeof body.channel !== 'string')) {
                    json(res, 400, { error: 'from and channel must be strings' })
                    return
                }
                // Identity is never taken from the body (K1): a body claiming
                // channel "telegram"/"cli" used to inherit owner rights. The
                // fields stay accepted for compatibility but are ignored.
                const channel = REST_API_CHANNEL
                const from = process.env.NOVA_API_TOKEN ? REST_API_TOKEN_PRINCIPAL : REST_API_LOCAL_PRINCIPAL

                // CL-07: the REST entry runs the full pipeline with tools; on a
                // node without the Main fence it is refused (enforce) or logged.
                try {
                    const { assertFenced } = await import('../mesh/fence.js')
                    await assertFenced('nova-main', { live: true, effect: 'rest:/v1/message' })
                } catch (error) {
                    json(res, 503, { error: 'Not the active Main node (fenced)', detail: String((error as Error)?.message || error).slice(0, 200) })
                    return
                }

                // The owner role follows only the verified token (checkAuth above), never the body.
                if (process.env.NOVA_API_TOKEN && from === REST_API_TOKEN_PRINCIPAL) {
                    try { await grantTokenOwner(from) } catch (error) {
                        console.warn(`[RestAPI] Owner-Recht für Token-Zugang nicht gesetzt: ${String((error as Error)?.message || error).slice(0, 160)}`)
                    }
                }

                let response = ''
                try {
                    await handleMessage(channel, from, content, async (msg) => {
                        // Zwischenmeldungen gingen bisher verloren: jede
                        // ueberschrieb die vorige, nur die letzte kam an. Bei
                        // einer langen Werkzeugkette sass der Mensch minutenlang
                        // vor einem stummen Prompt. Deshalb jeden Schritt in
                        // eine Datei schreiben, die die Konsole mitliest.
                        if (process.env.NOVA_OS_MODE === 'true') {
                            try {
                                const { writeFileSync, mkdirSync } = await import('node:fs')
                                mkdirSync('/run/novaos', { recursive: true })
                                writeFileSync('/run/novaos/fortschritt',
                                    String(msg).replace(/\s+/g, ' ').slice(0, 160))
                            } catch { /* Anzeige darf nie den Lauf stoppen */ }
                        }
                        response = msg
                    })
                    if (process.env.NOVA_OS_MODE === 'true') {
                        try {
                            const { unlinkSync } = await import('node:fs')
                            unlinkSync('/run/novaos/fortschritt')
                        } catch { /* war schon weg */ }
                    }
                    json(res, 200, { ok: true, response })
                } catch (err: any) {
                    json(res, 500, { error: err.message })
                }
                return
            }

            // ── 404 ────────────────────────────────────────────────────────────
            json(res, 404, { error: 'Not found', available: ['/v1/health', '/v1/status', '/v1/message'] })
        })

        server.on('error', (err) => {
            console.error(`[RestAPI] ❌ Server error: ${err.message}`)
            reject(err)
        })

        server.listen(config.port, config.host, () => {
            console.log(`[Nova] ✅ REST API aktiv auf http://${config.host}:${config.port}`)
            console.log(`[Nova]    POST /v1/message  — Nachricht senden`)
            console.log(`[Nova]    GET  /v1/health   — Health check`)
            console.log(`[Nova]    GET  /v1/status   — Status (auth)`)
            if (!apiToken) console.warn('[RestAPI] ⚠ Kein NOVA_API_TOKEN — ohne Auth zugänglich!')
            resolve(server)
        })
    })
}
