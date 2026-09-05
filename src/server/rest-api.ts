/**
 * Nova REST API Server
 *
 * Starts when nova.config.json has: { "server": { "enabled": true } }
 * Default port: 18789 | Default host: 0.0.0.0
 *
 * Auth: Bearer token via NOVA_API_TOKEN env var
 * If NOVA_API_TOKEN is not set, the server starts but logs a warning.
 *
 * Endpoints:
 *   GET  /v1/health          — liveness probe, no auth needed
 *   POST /v1/message         — send message through Nova pipeline
 *   GET  /v1/status          — runtime status (auth required)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'

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

function checkAuth(req: IncomingMessage): boolean {
    const token = process.env.NOVA_API_TOKEN
    if (!token) return true                         // No token set → open (warn at startup)
    const header = req.headers['authorization'] ?? ''
    return header === `Bearer ${token}`
}

// ─── Body reader ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ''
        req.on('data', chunk => { body += chunk })
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

// ─── Server factory ───────────────────────────────────────────────────────────

export function startRestApi(
    config: RestApiConfig,
    handleMessage: MessageHandler,
    getStatus: () => Record<string, unknown>,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const apiToken = process.env.NOVA_API_TOKEN
        if (!apiToken) {
            console.warn('[RestAPI] ⚠ NOVA_API_TOKEN not set — server is open (no auth)!')
        }

        const server = createServer(async (req, res) => {
            const url = req.url ?? '/'
            const method = req.method ?? 'GET'

            // ── CORS (for browser clients) ─────────────────────────────────────
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

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
                let body: { content?: string; from?: string; channel?: string }
                try {
                    body = JSON.parse(await readBody(req))
                } catch {
                    json(res, 400, { error: 'Invalid JSON' })
                    return
                }

                const content = body.content?.trim()
                if (!content) {
                    json(res, 400, { error: 'content is required' })
                    return
                }

                const from    = body.from    || 'api-user'
                const channel = body.channel || 'rest-api'

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
            resolve()
        })
    })
}
