/**
 * 2.89.8: a self-registered OpenAI-compatible provider (register_llm_provider: baseUrl + sealed vault key) as
 * the PRIMARY model. Real daemon entry -> message pipeline -> agent runner -> REAL llm-factory wrapper
 * (createLLM) -> model fallback chain. Only the network is simulated (documentation hosts, fake key):
 *   acme   = api.acme.example, the registered provider (records what it receives)
 *   local  = 192.0.2.10, the local model on another node (the fallback)
 *   openai = api.openai.com, must NEVER be contacted
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

// The KI scanner reports the local node as RUNNING (the fallback chain only tries what the scan sees running, 2.85).
vi.mock('../mesh/ai-scanner.js', async importOriginal => {
    const original = await importOriginal<typeof import('../mesh/ai-scanner.js')>()
    const services = [{ id: 'vllm-remote', name: 'vllm', type: 'llm', provider: 'vllm', host: '192.0.2.10', port: 8000, endpoint: 'http://192.0.2.10:8000', models: ['qwen'], status: 'running', lastSeen: '2026-10-17T00:00:00Z' }]
    return { ...original, getLastScanResult: () => ({ lastScan: '2026-10-17T00:00:00Z', scanDurationMs: 1, services }), getRunningServices: () => services }
})

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

const FAKE_KEY = 'fake-acme-key-' + 'q'.repeat(26)
const REMOTE = 'http://192.0.2.10:8000/v1'
const ACME = 'https://api.acme.example/v1'

interface Net {
    acme: 'ok' | 'down'
    localAlive: boolean
    acmeRequests: Array<{ url: string; authorization: string; body: string }>
    localRequests: string[]
    openaiRequests: string[]
}

const completion = (text: string) => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
}), { status: 200, headers: { 'content-type': 'application/json' } })

interface Options {
    provider?: string
    model?: string
    fallbackModels?: string[]
    registered?: Record<string, unknown> | null
    storeKey?: boolean
}

const entry = (patch: Record<string, unknown> = {}) => ({
    name: 'acme', apiKey: '', apiKeyRef: 'auth:llm-provider:acme', baseUrl: ACME, models: ['acme-chat-pro'], enabled: true, addedAt: 1, ...patch,
})

async function setup(options: Options = {}) {
    const provider = options.provider ?? 'acme'
    const model = options.model ?? (provider === 'local' ? 'qwen' : 'acme-chat-pro')
    const registered = options.registered === undefined ? entry() : options.registered
    h = await createE2EHarness({
        config: {
            provider, model,
            providers: { local: { baseUrl: REMOTE, enabled: true }, acme: { apiKeyRef: 'auth:llm-provider:acme', baseUrl: ACME, enabled: true } },
            fallbackModels: options.fallbackModels ?? [],
        },
        seed: root => { if (registered) writeFileSync(join(root, '.nova-data', 'external-providers.json'), JSON.stringify([registered], null, 2)) },
    })
    if (options.storeKey !== false) (await h.module('secrets/provider-keys.js')).storeProviderKey('acme', FAKE_KEY)

    const net: Net = { acme: 'ok', localAlive: true, acmeRequests: [], localRequests: [], openaiRequests: [] }
    const harnessFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : String(input?.url || input)
        if (url.startsWith('http://192.0.2.10:8000')) {
            net.localRequests.push(url)
            if (!net.localAlive) return new Response('down', { status: 503 })
            return url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'qwen' }] }), { status: 200 }) : completion('Antwort vom lokalen Modell')
        }
        if (url.startsWith('https://api.acme.example')) {
            const headers = new Headers(init?.headers || {})
            net.acmeRequests.push({ url, authorization: headers.get('authorization') || '', body: String(init?.body || '') })
            if (net.acme === 'down') return new Response('upstream unavailable', { status: 503 })
            return completion('Antwort vom registrierten Anbieter')
        }
        if (/api\.openai\.com|openrouter\.ai|api\.groq\.com/.test(url)) {
            net.openaiRequests.push(url)
            return new Response('must not be called', { status: 500 })
        }
        return harnessFetch(input, init)
    }) as typeof fetch

    const factory = await h.module('core/llm-factory.js')
    factory.availableLLMs.length = 0
    factory.availableLLMs.push({ provider: 'local', model: 'qwen', local: true, endpoint: REMOTE })
    const sdk = await h.module('llm/nova-llm-sdk.js')
    sdk.resetServerHealthForTests()
    const llm = await factory.createLLM({ provider, model })
    h.state.llm = llm
    return { h, net, llm, factory }
}

function plaintextHits(root: string): string[] {
    const hits: string[] = []
    const scan = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name)
            if (statSync(path).isDirectory()) scan(path)
            else { try { if (readFileSync(path).includes(FAKE_KEY)) hits.push(path.slice(root.length)) } catch { /* unreadable */ } }
        }
    }
    scan(root)
    return hits
}

describe('2.89.8 registered provider as PRIMARY model', () => {
    it('answers from the registered provider at its own baseUrl with the vault key, shown as that provider (not openai)', async () => {
        const ctx = await setup()
        expect(ctx.llm.provider).toBe('acme')
        expect(ctx.llm.modelId).toBe('acme-chat-pro')
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.error).toBeUndefined()
        expect(turn.final).toContain('Antwort vom registrierten Anbieter')
        const chat = ctx.net.acmeRequests.filter(request => request.url.endsWith('/chat/completions'))
        expect(chat.length).toBeGreaterThan(0)
        for (const request of chat) {
            expect(request.url).toBe(`${ACME}/chat/completions`)
            expect(request.authorization).toBe(`Bearer ${FAKE_KEY}`)
            expect(JSON.parse(request.body).model).toBe('acme-chat-pro')
        }
        expect(ctx.net.openaiRequests).toEqual([])
        expect(ctx.net.localRequests.filter(url => !url.endsWith('/models'))).toEqual([])
        // Discovery lists the model under the real provider name and carries no key.
        const listed = ctx.factory.availableLLMs.filter((item: any) => item.provider === 'acme')
        expect(listed.map((item: any) => item.model)).toContain('acme-chat-pro')
        expect(JSON.stringify(ctx.factory.availableLLMs)).not.toContain(FAKE_KEY)
    }, T)

    it('never lets the key into logs, replies, history or any file in clear text', async () => {
        const ctx = await setup()
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final).toContain('Antwort vom registrierten Anbieter')
        expect(turn.logs.join('\n')).not.toContain(FAKE_KEY)
        expect(turn.replies.join('\n')).not.toContain(FAKE_KEY)
        for (const request of ctx.net.acmeRequests) expect(request.body).not.toContain(FAKE_KEY)
        // the live client object legitimately holds its own key in memory; everything else must not
        const { llm: _client, ...rest } = ctx.h.state
        expect(JSON.stringify(rest)).not.toContain(FAKE_KEY)
        expect(plaintextHits(ctx.h.root)).toEqual([])
    }, T)

    it('falls back to the local chain when the registered primary is down (5xx)', async () => {
        const ctx = await setup()
        ctx.net.acme = 'down'
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.error).toBeUndefined()
        expect(turn.final).toContain('Antwort vom lokalen Modell')
        expect(ctx.net.acmeRequests.length).toBeGreaterThan(0)
        expect(ctx.net.openaiRequests).toEqual([])
        expect(turn.logs.join('\n')).not.toContain(FAKE_KEY)
    }, T)

    it('order primary -> local -> fallbackModels: with both primary and local down the listed model is tried last', async () => {
        const ctx = await setup({ registered: entry({ models: ['acme-chat-pro', 'acme-chat-lite'] }), fallbackModels: ['acme-chat-lite'] })
        ctx.net.localAlive = false
        ctx.net.acme = 'down'
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final.length).toBeGreaterThan(0)
        const models = ctx.net.acmeRequests.filter(r => r.body).map(r => JSON.parse(r.body).model)
        expect(models[0]).toBe('acme-chat-pro')
        expect(models).toContain('acme-chat-lite')
        // the local model was asked before the listed fallback
        expect(ctx.net.localRequests.length).toBeGreaterThan(0)
        expect(ctx.net.openaiRequests).toEqual([])
    }, T)

    it('the opposite direction still works: local primary, registered provider as fallbackModel', async () => {
        const ctx = await setup({ provider: 'local', model: 'qwen', fallbackModels: ['acme-chat-pro'] })
        ctx.net.localAlive = false
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final).toContain('Antwort vom registrierten Anbieter')
        expect(ctx.net.openaiRequests).toEqual([])
    }, T)
})

describe('2.89.8 unknown or unusable primary providers fail closed', () => {
    it('an unregistered provider name is never built as openai: nothing goes to OpenAI, the local chain answers', async () => {
        const ctx = await setup({ provider: 'ghost', model: 'ghost-1', registered: null })
        expect(ctx.llm.provider).not.toBe('openai')
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final).toContain('Antwort vom lokalen Modell')
        expect(ctx.net.openaiRequests).toEqual([])
        expect(ctx.net.acmeRequests).toEqual([])
    }, T)

    it('a registered provider without a vault key is refused (only the local chain is asked)', async () => {
        const ctx = await setup({ storeKey: false })
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final).toContain('Antwort vom lokalen Modell')
        expect(ctx.net.acmeRequests).toEqual([])
        expect(ctx.net.openaiRequests).toEqual([])
    }, T)

    it('a registered provider that does not list the configured model is refused', async () => {
        const ctx = await setup({ model: 'not-listed' })
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(ctx.net.acmeRequests).toEqual([])
        expect(turn.final).toContain('Antwort vom lokalen Modell')
    }, T)

    it('a disabled registered provider is refused', async () => {
        const ctx = await setup({ registered: entry({ enabled: false }) })
        await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(ctx.net.acmeRequests).toEqual([])
    }, T)

    it('openrouter and groq as primary are only built with a real baseUrl, never through the openai client', async () => {
        const ctx = await setup({ registered: null })
        const route = ctx.factory.resolvePrimaryRoute
        expect(route('openrouter', 'm', { openrouter: { apiKey: 'fake-or-key' } }).route?.baseUrl).toBe('https://openrouter.ai/api/v1')
        expect(route('groq', 'm', { groq: { apiKey: 'fake-groq-key', baseUrl: 'https://groq.example.com/v1/' } }).route?.baseUrl).toBe('https://groq.example.com/v1')
        expect(route('openrouter', 'm', {}).failClosed).toMatch(/no API key/)
        expect(route('groq', '', { groq: { apiKey: 'k' } }).failClosed).toMatch(/explicit model/)
        expect(route('openai', 'gpt-x').route).toBeUndefined()
        expect(route('openai', 'gpt-x').failClosed).toBeUndefined()
        expect(route('nonsense', 'x').failClosed).toMatch(/neither built in nor registered/)
    }, T)
})

describe('2.89.8 a model abort never shows internal text to the user', () => {
    it('with every endpoint failing the user gets no validator wording', async () => {
        const ctx = await setup()
        ctx.net.acme = 'down'
        ctx.net.localAlive = false
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final.length).toBeGreaterThan(0)
        expect(turn.final).not.toMatch(/inference stopped|stopped before completion|budget exceeded|Erfolgsnachweis fehlt/i)
        expect(turn.replies.join('\n')).not.toMatch(/inference stopped|stopped before completion/i)
    }, T)

    it('maps validator violations to German text with a next step', async () => {
        const { userFacingVerdictMessage } = await import('../core/task-contract.js')
        const stopped = userFacingVerdictMessage([], ['inference stopped before completion'])
        expect(stopped).toContain('mitten in der Antwort abgebrochen')
        expect(stopped).toContain('noch einmal')
        expect(stopped).not.toMatch(/inference|completion/i)
        const unknown = userFacingVerdictMessage(['some internal english reason'], [])
        expect(unknown).not.toContain('internal english')
        expect(unknown).toContain('Nachweis')
    })
})
