/**
 * 2.85 Paket C — KI-Modelle verbinden: API-Key einmal einfügen, sofort
 * geprüft, sicher abgelegt (0600), nie wieder angezeigt; verständliche
 * Fehler; OpenRouter-Konto per offiziellem PKCE; eine Liste
 * gefunden/möglich/verbunden für Paket A und B. Keine Netzaufrufe.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthManager } from '../auth/oauth.js'
import {
    applyStoredLlmKeysToEnv, buildLlmConnectionList, classifyKeyCheck, completeOpenRouterLogin, connectLlmApiKey, disconnectLlmApiKey,
    findLlmProvider, listLlmConnections, LLM_PROVIDERS, maskKey, resetOpenRouterLogins, startOpenRouterLogin, verifyApiKey,
} from './llm-connections.js'

// Inert test values: no provider prefix, nothing that looks like a real key.
const KEY = ['test', 'value', 'abcdefgh', 'wxyz'].join('-')
const OTHER = ['test', 'value', 'zyxwvuts', '9876'].join('-')

function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'llm-conn-'))
    const authPath = join(dir, 'auth.json')
    return { dir, authPath, store: new OAuthManager({ storePath: authPath }), statusFile: join(dir, 'llm-connections.json'), env: {} as NodeJS.ProcessEnv }
}

const answer = (status: number, body: unknown) => vi.fn(async () => ({ status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }))

afterEach(() => resetOpenRouterLogins())

describe('Fehler verständlich erklären', () => {
    it.each([
        [401, '{}', 'key-ungueltig'],
        [400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', 'key-ungueltig'],
        [402, '{"error":"payment required"}', 'kein-guthaben'],
        [429, '{"error":{"code":"insufficient_quota"}}', 'kein-guthaben'],
        [400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}', 'kein-guthaben'],
        [403, '{"error":"region not supported"}', 'kein-zugriff'],
        [429, '{"error":"rate limit"}', 'ueberlastet'],
        [503, '', 'anbieter-stoerung'],
        [200, '{"data":[]}', null],
    ])('HTTP %i → %s', (status, body, reason) => {
        expect(classifyKeyCheck(status, body)).toBe(reason)
    })

    it('Netzfehler → „Netz“, Format → keine Anfrage', async () => {
        const offline = vi.fn(async () => { throw new Error('ECONNREFUSED') })
        expect(await verifyApiKey('openai', KEY, { fetchImpl: offline })).toMatchObject({ ok: false, grund: 'netz', meldung: expect.stringMatching(/^Netz/) })
        const never = vi.fn()
        expect(await verifyApiKey('openai', 'kurz', { fetchImpl: never as any })).toMatchObject({ ok: false, grund: 'format' })
        expect(await verifyApiKey('openai', 'mit leerzeichen drin 1234567890', { fetchImpl: never as any })).toMatchObject({ ok: false, grund: 'format' })
        expect(never).not.toHaveBeenCalled()
    })

    it('der Key geht nur an den eigenen Anbieter, im passenden Header', async () => {
        for (const info of LLM_PROVIDERS) {
            const fetchImpl = answer(200, { data: [{ id: 'm' }] })
            expect(await verifyApiKey(info.id, KEY, { fetchImpl })).toEqual({ ok: true, modelle: 1 })
            const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any]
            expect(url).toBe(info.checkUrl)
            expect(new URL(url).protocol).toBe('https:')
            expect(init.method).toBe('GET')
            const headers = JSON.stringify(init.headers)
            expect(headers).toContain(KEY)
            if (info.id === 'anthropic') expect(init.headers['x-api-key']).toBe(KEY)
            else if (info.id === 'gemini') expect(init.headers['x-goog-api-key']).toBe(KEY)
            else expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
        }
    })
})

describe('API-Key: einmal einfügen, prüfen, sicher ablegen, nie wieder anzeigen', () => {
    it('gültig → gespeichert (0600), Rückgabe nur Maske, Status ohne Key, sofort nutzbar (Umgebung)', async () => {
        const box = sandbox()
        const result = await connectLlmApiKey('anthropic', `  ${KEY}\n`, { ...box, fetchImpl: answer(200, { data: [{ id: 'a' }, { id: 'b' }] }) })
        expect(result).toEqual({ ok: true, provider: 'anthropic', maske: '••••wxyz', modelle: 2 })
        expect(JSON.stringify(result)).not.toContain(KEY)
        expect(box.store.getProfile('llm-key:anthropic')).toMatchObject({ type: 'api_key', key: KEY })
        if (process.platform !== 'win32') expect(statSync(box.authPath).mode & 0o777).toBe(0o600)
        expect(readFileSync(box.statusFile, 'utf8')).not.toContain(KEY)
        expect(box.env.ANTHROPIC_API_KEY).toBe(KEY)
    })

    it('ungültig → nichts gespeichert, klare Meldung', async () => {
        const box = sandbox()
        const result = await connectLlmApiKey('openai', KEY, { ...box, fetchImpl: answer(401, '{"error":{"code":"invalid_api_key"}}') })
        expect(result).toMatchObject({ ok: false, grund: 'key-ungueltig', meldung: expect.stringMatching(/^Key ungültig/) })
        expect(box.store.getProfile('llm-key:openai')).toBeNull()
        expect(box.env.OPENAI_API_KEY).toBeUndefined()
    })

    it('kein Guthaben → nichts gespeichert', async () => {
        const box = sandbox()
        const result = await connectLlmApiKey('openrouter', KEY, { ...box, fetchImpl: answer(402, '{}') })
        expect(result).toMatchObject({ ok: false, grund: 'kein-guthaben', meldung: expect.stringMatching(/^Kein Guthaben/) })
        expect(box.store.getProfile('llm-key:openrouter')).toBeNull()
    })

    it('eine vorhandene Umgebungsvariable (.env) gewinnt; Trennen entfernt nur den eigenen Wert', async () => {
        const box = sandbox()
        box.env.OPENAI_API_KEY = OTHER
        await connectLlmApiKey('openai', KEY, { ...box, fetchImpl: answer(200, { data: [] }) })
        expect(box.env.OPENAI_API_KEY).toBe(OTHER)
        expect(await disconnectLlmApiKey('openai', box)).toBe(true)
        expect(box.env.OPENAI_API_KEY).toBe(OTHER)
        await connectLlmApiKey('mistral', KEY, { ...box, fetchImpl: answer(200, { data: [] }) })
        expect(box.env.MISTRAL_API_KEY).toBe(KEY)
        await disconnectLlmApiKey('mistral', box)
        expect(box.env.MISTRAL_API_KEY).toBeUndefined()
        expect(box.store.getProfile('llm-key:mistral')).toBeNull()
    })

    it('beim Start werden gespeicherte Keys wie .env-Keys bereitgestellt', async () => {
        const box = sandbox()
        box.store.setApiKey('llm-key:groq', 'groq', KEY)
        expect(applyStoredLlmKeysToEnv({ store: box.store, env: box.env })).toEqual(['groq'])
        expect(box.env.GROQ_API_KEY).toBe(KEY)
    })

    it('Maske zeigt höchstens die letzten vier Zeichen', () => {
        expect(maskKey(KEY)).toBe('••••wxyz')
        expect(maskKey('')).toBeNull()
    })
})

describe('Anmeldung mit Konto nur, wo der Anbieter es Drittanwendungen erlaubt', () => {
    it('Anthropic: nie Konto/Abo-Login (Owner-Regel 30.09.2026), nur API-Key; Gemini/xAI/Mistral ebenso', () => {
        for (const id of ['anthropic', 'gemini', 'xai', 'mistral', 'groq', 'deepseek']) {
            const info = findLlmProvider(id)!
            expect(info.konto.erlaubt, id).toBe(false)
            expect(info.konto.weg, id).toBeUndefined()
            expect(info.konto.quelle).toMatch(/^https:\/\//)
        }
        expect(findLlmProvider('anthropic')!.konto.hinweis).toMatch(/API-Key/)
        expect(findLlmProvider('openrouter')!.konto).toMatchObject({ erlaubt: true, weg: 'openrouter-pkce' })
        expect(findLlmProvider('openai')!.konto).toMatchObject({ erlaubt: true, weg: 'codex-app-server' })
    })

    it('OpenRouter PKCE: S256-Challenge, Rückruf mit state, Code einmalig gegen Key, Key geprüft und gespeichert', async () => {
        const box = sandbox()
        const { url, state } = startOpenRouterLogin('http://localhost:3011/oauth/llm/openrouter/callback')
        const parsed = new URL(url)
        expect(parsed.origin + parsed.pathname).toBe('https://openrouter.ai/auth')
        expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
        expect(parsed.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(new URL(parsed.searchParams.get('callback_url')!).searchParams.get('state')).toBe(state)
        const calls: Array<[string, any]> = []
        const fetchImpl = vi.fn(async (u: string, init: any) => {
            calls.push([u, init])
            if (u === 'https://openrouter.ai/api/v1/auth/keys') return { status: 200, text: async () => JSON.stringify({ key: KEY }) }
            return { status: 200, text: async () => JSON.stringify({ data: { label: 'x' } }) }
        })
        const result = await completeOpenRouterLogin(state, 'authcode-123', { ...box, fetchImpl })
        expect(result).toEqual({ ok: true, provider: 'openrouter', maske: '••••wxyz', modelle: 0 })
        const exchange = JSON.parse(calls[0][1].body)
        expect(exchange).toMatchObject({ code: 'authcode-123', code_challenge_method: 'S256' })
        expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(calls[1][0]).toBe('https://openrouter.ai/api/v1/key')
        expect(box.store.getProfile('llm-key:openrouter')).toMatchObject({ key: KEY })
        // state is one-time
        expect(await completeOpenRouterLogin(state, 'authcode-123', { ...box, fetchImpl })).toMatchObject({ ok: false })
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('unbekannter state → kein Austausch', async () => {
        const fetchImpl = vi.fn()
        expect(await completeOpenRouterLogin('fremd', 'code-1234', { fetchImpl: fetchImpl as any })).toMatchObject({ ok: false })
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})

describe('Eine Liste: gefunden / möglich / verbunden', () => {
    const services = [
        { id: 'vllm@localhost:8000', name: 'vllm', type: 'llm', endpoint: 'http://localhost:8000', models: ['qwen3-vl-32b'], status: 'running', sourceNode: 'local', host: 'localhost' },
        { id: 'ollama@192.168.50.20:11434', name: 'ollama', type: 'llm', endpoint: 'http://192.168.50.20:11434', models: ['llama3.2:3b', 'nomic-embed-text'], status: 'running', sourceNode: '192.168.50.20', host: '192.168.50.20', metadata: { source: 'own-network' } },
        { id: 'ollama-embeddings@192.168.50.20:11434', name: 'ollama-embeddings', type: 'embeddings', endpoint: 'http://192.168.50.20:11434', models: ['nomic-embed-text'], status: 'running' },
        { id: 'searxng@192.168.50.30:8888', name: 'searxng', type: 'search', endpoint: 'http://192.168.50.30:8888', models: [], status: 'running', sourceNode: '192.168.50.30', host: '192.168.50.30', metadata: { source: 'own-network' } },
        { id: 'piper@localhost:5030', name: 'piper', type: 'tts', endpoint: 'http://localhost:5030', models: [], status: 'running' },
    ]

    it('lokale Funde: gefunden, Datenklasse lokal, ohne Frage nutzbar; belegte vs. vermutete Fähigkeiten', () => {
        const registry = { endpoints: [{ model: 'qwen3-vl-32b', baseUrl: 'http://localhost:8000', capabilities: [{ capability: 'chat' }, { capability: 'tools' }] }] }
        const list = buildLlmConnectionList({ services, registry }, null, {}, {})
        const local = list.filter(item => item.status === 'gefunden')
        expect(local.map(item => item.id)).toEqual(['lokal:vllm@http://localhost:8000', 'lokal:ollama@http://192.168.50.20:11434', 'lokal:searxng@http://192.168.50.30:8888'])
        expect(local.every(item => item.datenklasse === 'lokal' && item.nutzbar)).toBe(true)
        expect(local[0].faehigkeiten).toEqual({ belegt: ['chat', 'tools'], vermutet: ['vision'] })
        expect(local[1]).toMatchObject({ title: 'Ollama im eigenen Netz (192.168.50.20)', faehigkeiten: { belegt: [], vermutet: ['chat', 'embedding'] } })
        expect(local[2]).toMatchObject({ kategorie: 'suche', title: 'SearXNG im eigenen Netz (192.168.50.30)' })
    })

    it('Cloud: möglich bis verbunden; Maske nur auf Wunsch; Codex-Login zählt als verbunden für OpenAI', () => {
        const box = sandbox()
        box.store.setApiKey('llm-key:anthropic', 'anthropic', KEY)
        const list = buildLlmConnectionList({ services: [], codex: { authenticated: true, available: true }, includeMasks: true }, box.store, {}, {})
        const byId = Object.fromEntries(list.map(item => [item.id, item]))
        expect(byId['cloud:anthropic']).toMatchObject({ status: 'verbunden', datenklasse: 'cloud', maske: '••••wxyz', anmeldung: { apiKey: true, konto: null } })
        expect(byId['cloud:openai']).toMatchObject({ status: 'verbunden', anmeldung: { konto: 'codex-app-server' } })
        expect(byId['cloud:openrouter']).toMatchObject({ status: 'moeglich', nutzbar: false, anmeldung: { konto: 'openrouter-pkce' } })
        const noMask = buildLlmConnectionList({ services: [] }, box.store, {}, {})
        expect(JSON.stringify(noMask)).not.toContain('wxyz')
        expect(JSON.stringify(list)).not.toContain(KEY)
    })

    it('listLlmConnections teilt in die drei Listen', async () => {
        const box = sandbox()
        const result = await listLlmConnections({ services, registry: null, codex: null, store: box.store, statusFile: box.statusFile, env: { XAI_API_KEY: OTHER } })
        expect(result.gefunden).toHaveLength(3)
        expect(result.verbunden.map(item => item.id)).toEqual(['cloud:xai'])
        expect(result.moeglich).toHaveLength(LLM_PROVIDERS.length - 1)
        expect(JSON.stringify(result)).not.toContain(OTHER)
    })
})
