/**
 * P0 (28.10.2026, VM 130): MiniMax as primary, key moved to the vault at start
 * ("[Nova] 🔐 Provider keys in den verschlüsselten Tresor verschoben: minimax"), then
 * "[NovaLLM] MiniMax ist als Primary konfiguriert, aber es fehlt ein API-Key" and every
 * Telegram turn went "[ModelFallback] 🔄 Trying fallback: local/auto" → CPU qwen → 90 s timeout.
 * createLLM got the daemon's config whose providers.minimax only carries `apiKeyRef`.
 * Real daemon entry → pipeline → createLLM; only the network is simulated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

vi.mock('../mesh/ai-scanner.js', async importOriginal => {
    const original = await importOriginal<typeof import('../mesh/ai-scanner.js')>()
    const services = [{ id: 'vllm-remote', name: 'vllm', type: 'llm', provider: 'vllm', host: '192.0.2.10', port: 8000, endpoint: 'http://192.0.2.10:8000', models: ['qwen'], status: 'running', lastSeen: '2026-10-28T00:00:00Z' }]
    return { ...original, getLastScanResult: () => ({ lastScan: '2026-10-28T00:00:00Z', scanDurationMs: 1, services }), getRunningServices: () => services }
})

let h: E2EHarness | undefined
const savedEnv = process.env.MINIMAX_API_KEY
afterEach(async () => {
    await h?.close(); h = undefined
    if (savedEnv === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = savedEnv
})
const T = 90_000
const FAKE_KEY = 'fake-minimax-key-' + 'm'.repeat(24)
const MINIMAX = 'https://api.minimax.io/v1'
const REMOTE = 'http://192.0.2.10:8000/v1'

const completion = (text: string) => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
}), { status: 200, headers: { 'content-type': 'application/json' } })

async function setup(keyIn: 'vault' | 'env') {
    const minimax: Record<string, unknown> = { baseUrl: MINIMAX, enabled: true, ...(keyIn === 'vault' ? { apiKeyRef: 'auth:llm-provider:minimax' } : {}) }
    const config = { provider: 'minimax', model: 'MiniMax-M3.1-Flash', providers: { local: { baseUrl: REMOTE, enabled: true }, minimax }, fallbackModels: [] }
    if (keyIn === 'env') process.env.MINIMAX_API_KEY = FAKE_KEY; else delete process.env.MINIMAX_API_KEY
    h = await createE2EHarness({ config })
    if (keyIn === 'vault') (await h.module('secrets/provider-keys.js')).storeProviderKey('minimax', FAKE_KEY)

    const net = { minimax: [] as Array<{ url: string; authorization: string }>, local: [] as string[] }
    const harnessFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : String(input?.url || input)
        if (url.startsWith('https://api.minimax.io')) {
            net.minimax.push({ url, authorization: new Headers(init?.headers || {}).get('authorization') || '' })
            return url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'MiniMax-M3.1-Flash' }] }), { status: 200 }) : completion('Antwort von MiniMax')
        }
        if (url.startsWith('http://192.0.2.10:8000')) {
            net.local.push(url)
            return url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'qwen' }] }), { status: 200 }) : completion('Antwort vom lokalen Modell')
        }
        return harnessFetch(input, init)
    }) as typeof fetch

    const factory = await h.module('core/llm-factory.js')
    factory.availableLLMs.length = 0
    factory.availableLLMs.push({ provider: 'local', model: 'qwen', local: true, endpoint: REMOTE })
    ;(await h.module('llm/nova-llm-sdk.js')).resetServerHealthForTests()
    // Like the daemon (daemon.ts: createLLM(config)): the loaded config, providers.minimax WITHOUT a plaintext apiKey.
    const llm = await factory.createLLM(structuredClone(config))
    h.state.llm = llm
    return { h, net, llm }
}

describe('P0: MiniMax primary finds its key (vault reference or MINIMAX_API_KEY)', () => {
    for (const keyIn of ['vault', 'env'] as const) {
        it(`key in ${keyIn}: the turn is answered by MiniMax, no local fallback, no "fehlt ein API-Key"`, async () => {
            const ctx = await setup(keyIn)
            const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
            expect(turn.logs.join('\n')).not.toMatch(/fehlt ein API-Key|MiniMax ohne API-Key/)
            expect(turn.logs.join('\n')).not.toMatch(/Trying fallback: local/)
            expect(turn.error).toBeUndefined()
            expect(turn.final).toContain('Antwort von MiniMax')
            const chat = ctx.net.minimax.filter(request => request.url.endsWith('/chat/completions'))
            expect(chat.length).toBeGreaterThan(0)
            for (const request of chat) expect(request.authorization).toBe(`Bearer ${FAKE_KEY}`)
            expect(ctx.net.local.filter(url => !url.endsWith('/models'))).toEqual([])
            expect(turn.logs.join('\n')).not.toContain(FAKE_KEY)
        }, T)
    }
})
