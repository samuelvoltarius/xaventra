/**
 * 2.85 Paket C — Desktop-Endpunkte „KI-Modelle verbinden“: Key-Eingabe und
 * Konto-Anmeldung nur für den Owner, Key nie im Klartext zurück, Anthropic
 * nie per Konto, OpenRouter-Rückruf nur mit einmaligem state.
 */
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthManager } from '../auth/oauth.js'
import { resetOpenRouterLogins } from '../llm/llm-connections.js'
import { registerLlmConnectionsApi } from './llm-connections-api.js'
import { registerDesktopApi } from './desktop-api.js'

const KEY = ['test', 'value', 'abcdefgh', 'wxyz'].join('-')
const DESKTOP_TOKEN = ['desktop-test-', 'token-0123456789'].join('')

afterEach(() => { vi.unstubAllEnvs(); resetOpenRouterLogins() })

async function serve(app: express.Express) {
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    return { base: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function setup(extra: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'llm-api-'))
    const store = new OAuthManager({ storePath: join(dir, 'auth.json') })
    const providerFetch = vi.fn(async (url: string) => url === 'https://openrouter.ai/api/v1/auth/keys'
        ? { status: 200, text: async () => JSON.stringify({ key: KEY }) }
        : { status: 200, text: async () => JSON.stringify({ data: [{ id: 'm1' }] }) })
    const app = express(); app.use(express.json())
    registerLlmConnectionsApi(app, {
        isOwner: req => req.headers['x-test-owner'] === '1',
        executionPrincipal: () => 'desktop:owner',
        deps: { store, fetchImpl: providerFetch as any, statusFile: join(dir, 'status.json'), env: {}, ...extra },
    })
    return { app, store, providerFetch }
}

const json = (body: unknown, owner = true) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': '1' } : {}) }, body: JSON.stringify(body) })

describe('Desktop: KI-Modelle verbinden', () => {
    it('Key einfügen: nur Owner; Antwort nur mit Maske; Fehler verständlich', async () => {
        const { app, store } = setup()
        const srv = await serve(app)
        try {
            const denied = await fetch(`${srv.base}/api/desktop/llm-connections/key`, json({ provider: 'anthropic', key: KEY }, false))
            expect(denied.status).toBe(403)
            expect(store.getProfile('llm-key:anthropic')).toBeNull()
            const ok = await fetch(`${srv.base}/api/desktop/llm-connections/key`, json({ provider: 'anthropic', key: KEY }))
            const text = await ok.text()
            expect(ok.status).toBe(200)
            expect(text).not.toContain(KEY)
            expect(JSON.parse(text)).toMatchObject({ ok: true, maske: '••••wxyz', modelle: 1 })
            const bad = await fetch(`${srv.base}/api/desktop/llm-connections/key`, json({ provider: 'anthropic', key: 'zu kurz' }))
            expect(bad.status).toBe(400)
            expect(await bad.json()).toMatchObject({ ok: false, grund: 'format' })
            const list = await (await fetch(`${srv.base}/api/desktop/llm-connections`, { headers: { 'x-test-owner': '1' } })).json() as any
            expect(list.verbunden.find((item: any) => item.id === 'cloud:anthropic')).toMatchObject({ maske: '••••wxyz' })
            const anon = await (await fetch(`${srv.base}/api/desktop/llm-connections`)).text()
            expect(anon).not.toContain('wxyz')
            expect((await fetch(`${srv.base}/api/desktop/llm-connections/key/anthropic`, { method: 'DELETE' })).status).toBe(403)
            expect(await (await fetch(`${srv.base}/api/desktop/llm-connections/key/anthropic`, { method: 'DELETE', headers: { 'x-test-owner': '1' } })).json()).toEqual({ removed: true })
        } finally { await srv.close() }
    })

    it('Konto-Anmeldung: Anthropic/Gemini abgelehnt mit Grund, OpenAI nur über Codex, OpenRouter per PKCE', async () => {
        const codexLogin = vi.fn(async () => ({ verificationUrl: 'https://auth.example.com/device', userCode: 'ABCD-1234' }))
        const { app } = setup({ codexLogin })
        const srv = await serve(app)
        try {
            for (const provider of ['anthropic', 'gemini', 'mistral']) {
                const res = await fetch(`${srv.base}/api/desktop/llm-connections/oauth/start`, json({ provider }))
                expect(res.status, provider).toBe(400)
                expect(await res.json()).toMatchObject({ ok: false, apiKey: true })
            }
            const openai = await (await fetch(`${srv.base}/api/desktop/llm-connections/oauth/start`, json({ provider: 'openai' }))).json()
            expect(openai).toMatchObject({ ok: true, weg: 'codex-app-server', url: 'https://auth.example.com/device', code: 'ABCD-1234' })
            expect(codexLogin).toHaveBeenCalledWith('desktop:owner')
            const or = await (await fetch(`${srv.base}/api/desktop/llm-connections/oauth/start`, json({ provider: 'openrouter' }))).json() as any
            expect(or).toMatchObject({ ok: true, weg: 'openrouter-pkce', manuell: false })
            expect(new URL(new URL(or.url).searchParams.get('callback_url')!).pathname).toBe('/oauth/llm/openrouter/callback')
            expect((await fetch(`${srv.base}/api/desktop/llm-connections/oauth/start`, json({ provider: 'openrouter' }, false))).status).toBe(403)
        } finally { await srv.close() }
    })

    it('OpenRouter-Rückruf: einmaliger state, kein Key in der Antwort, fremder state scheitert', async () => {
        const { app, store, providerFetch } = setup()
        const srv = await serve(app)
        try {
            const start = await (await fetch(`${srv.base}/api/desktop/llm-connections/oauth/start`, json({ provider: 'openrouter' }))).json() as any
            const callback = new URL(new URL(start.url).searchParams.get('callback_url')!)
            const evil = await fetch(`${srv.base}/oauth/llm/openrouter/callback?state=fremd&code=abcd1234`)
            expect(evil.status).toBe(400)
            expect(providerFetch).not.toHaveBeenCalled()
            const done = await fetch(`${srv.base}/oauth/llm/openrouter/callback?state=${callback.searchParams.get('state')}&code=abcd1234`)
            const text = await done.text()
            expect(done.status).toBe(200)
            expect(text).not.toContain(KEY)
            expect(store.getProfile('llm-key:openrouter')).toMatchObject({ key: KEY })
            const replay = await fetch(`${srv.base}/oauth/llm/openrouter/callback?state=${callback.searchParams.get('state')}&code=abcd1234`)
            expect(replay.status).toBe(400)
        } finally { await srv.close() }
    })

    it('in der echten Desktop-API eingehängt: Owner nur mit Desktop-Token', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', DESKTOP_TOKEN)
        const app = express(); app.use(express.json())
        registerDesktopApi(app, () => null)
        const srv = await serve(app)
        try {
            const noToken = await fetch(`${srv.base}/api/desktop/llm-connections/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', key: KEY }) })
            expect(noToken.status).toBe(401)
            const start = await fetch(`${srv.base}/api/desktop/llm-connections/oauth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DESKTOP_TOKEN}` }, body: JSON.stringify({ provider: 'anthropic' }) })
            expect(start.status).toBe(400)
            expect(await start.json()).toMatchObject({ ok: false, provider: 'anthropic' })
        } finally { await srv.close() }
    })
})
