/**
 * 2.85 Paket C — Desktop endpoints for "KI-Modelle verbinden".
 * No own view: Paket A ("Verbindungen") and Paket B (first start) call these.
 *
 *   GET    /api/desktop/llm-connections            gefunden / möglich / verbunden (masks only for the owner)
 *   POST   /api/desktop/llm-connections/key         { provider, key } → verify, store, mask  (owner)
 *   DELETE /api/desktop/llm-connections/key/:id     disconnect                               (owner)
 *   POST   /api/desktop/llm-connections/oauth/start { provider }                             (owner)
 *            openrouter → official PKCE login URL; openai → official Codex login (device code);
 *            every other provider → refused with the reason (e.g. Anthropic: API key only)
 *   POST   /api/desktop/llm-connections/oauth/complete { state, code }  (OpenRouter, code typed by hand)
 *   GET    /oauth/llm/openrouter/callback          browser return from OpenRouter (loopback, one-time state)
 *
 * The key is never echoed, logged or put into an error message.
 */
import type { Express, Request, Response } from 'express'
import {
    completeOpenRouterLogin, connectLlmApiKey, disconnectLlmApiKey, findLlmProvider, listLlmConnections, startOpenRouterLogin,
    type LlmConnectionDeps,
} from '../llm/llm-connections.js'

export interface LlmConnectionsApiOptions {
    isOwner(req: Request): boolean
    /** Principal the Codex login belongs to (same mapping as desktop runs). */
    executionPrincipal(req: Request): string
    deps?: LlmConnectionDeps & {
        codexLogin?: (principalId: string) => Promise<{ verificationUrl: string; userCode?: string }>
        list?: typeof listLlmConnections
    }
}

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
const isLoopbackAddress = (address: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || ''))

function ownerOnly(options: LlmConnectionsApiOptions, req: Request, res: Response): boolean {
    if (options.isOwner(req)) return true
    res.status(403).json({ error: 'Owner authorization required' })
    return false
}

// A failed step carries its plain reason also as `error` (the one UI shows `error` of a failed request).
const withError = <T extends { ok: boolean; meldung?: string }>(result: T) => result.ok || !result.meldung ? result : { ...result, error: result.meldung }
const failure = (res: Response, result: { ok: boolean; meldung?: string }) => res.status(result.ok ? 200 : 400).json(withError(result))

export function registerLlmConnectionsApi(app: Express, options: LlmConnectionsApiOptions): void {
    const deps = options.deps || {}

    app.get('/api/desktop/llm-connections', async (req, res) => {
        try {
            const owner = options.isOwner(req)
            const list = await (deps.list || listLlmConnections)({ ...deps, includeMasks: owner, ...(owner ? { principalId: options.executionPrincipal(req) } : {}) })
            res.json(list)
        } catch { res.status(500).json({ error: 'Liste nicht verfügbar' }) }
    })

    app.post('/api/desktop/llm-connections/key', async (req, res) => {
        if (!ownerOnly(options, req, res)) return
        try { failure(res, await connectLlmApiKey(req.body?.provider, req.body?.key, deps)) }
        catch { res.status(500).json(withError({ ok: false, meldung: 'Speichern fehlgeschlagen — der Key wurde nicht übernommen.' })) }
    })

    app.delete('/api/desktop/llm-connections/key/:provider', async (req, res) => {
        if (!ownerOnly(options, req, res)) return
        if (!findLlmProvider(req.params.provider)) return void res.status(404).json({ removed: false })
        res.json({ removed: await disconnectLlmApiKey(req.params.provider, deps) })
    })

    app.post('/api/desktop/llm-connections/oauth/start', async (req, res) => {
        if (!ownerOnly(options, req, res)) return
        const info = findLlmProvider(req.body?.provider)
        if (!info) return void res.status(404).json(withError({ ok: false, meldung: 'Diesen Anbieter kenne ich nicht.' }))
        if (!info.konto.erlaubt) return void res.status(400).json(withError({ ok: false, provider: info.id, meldung: info.konto.hinweis, quelle: info.konto.quelle, apiKey: true, keyUrl: info.keyUrl }))
        try {
            if (info.konto.weg === 'openrouter-pkce') {
                // A browser return works when this UI is opened on the same machine; otherwise
                // OpenRouter shows the code, which is entered via /oauth/complete.
                const host = String(req.headers.host || '')
                const callback = LOOPBACK.test(host) ? `http://${host}/oauth/llm/openrouter/callback` : null
                const login = startOpenRouterLogin(callback)
                return void res.json({ ok: true, provider: info.id, weg: info.konto.weg, url: login.url, state: login.state, manuell: !callback })
            }
            const principal = options.executionPrincipal(req)
            const login = await (deps.codexLogin || (async (id: string) => (await import('../auth/codex-runtime.js')).beginCodexRuntimeLogin(id, 'device')))(principal)
            res.json({ ok: true, provider: info.id, weg: info.konto.weg, url: login.verificationUrl, code: login.userCode || null, hinweis: info.konto.hinweis })
        } catch {
            res.status(502).json(withError({ ok: false, provider: info.id, meldung: info.id === 'openai' ? 'Codex-Anmeldung nicht verfügbar (Codex nicht installiert?). Alternativ einen API-Key einfügen.' : 'Anmeldung konnte nicht gestartet werden.' }))
        }
    })

    app.post('/api/desktop/llm-connections/oauth/complete', async (req, res) => {
        if (!ownerOnly(options, req, res)) return
        failure(res, await completeOpenRouterLogin(req.body?.state, req.body?.code, deps))
    })

    // Browser return from OpenRouter. No desktop token (it is a redirect), so it only
    // completes a pending, unexpired, one-time state, and only from this machine.
    app.get('/oauth/llm/openrouter/callback', async (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        if (!isLoopbackAddress(req.socket.remoteAddress)) return void res.status(403).send('Nur auf diesem Rechner möglich.')
        const result = await completeOpenRouterLogin(req.query.state, req.query.code, deps)
        res.status(result.ok ? 200 : 400).send(result.ok
            ? 'OpenRouter ist verbunden. Dieses Fenster kann geschlossen werden.'
            : 'Verbinden hat nicht geklappt. Bitte in Xaventra erneut auf „Mit Konto verbinden“ tippen.')
    })
}
