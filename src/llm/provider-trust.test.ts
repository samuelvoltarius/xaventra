import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No real config, cache or discovery: everything the code reads is mocked here.
const discovery = vi.hoisted(() => ({ availableLLMs: [] as any[] }))
const resolver = vi.hoisted(() => ({ next: null as any }))

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() }
})
vi.mock('../config/config-path.js', () => ({ resolveConfigPath: () => 'Z:/does-not-exist/xaventra.config.json' }))
vi.mock('../core/llm-factory.js', () => ({
    get availableLLMs() { return discovery.availableLLMs },
    getNovaConfig: () => ({}),
}))
vi.mock('../core/model-resolver.js', () => ({ resolveModel: async () => resolver.next }))

import { createNovaLLMClient, getNovaLLM } from './nova-llm-sdk.js'
import { probeAllModels, probeModel } from './capability-probe.js'
import { envOpenAIKeyFor, isLocalEndpoint } from './endpoint-trust.js'

const okChat = () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
}), { status: 200, headers: { 'content-type': 'application/json' } })

function authHeaderOf(call: any[]): string | undefined {
    const headers = (call?.[1]?.headers || {}) as Record<string, string>
    return headers['Authorization']
}

beforeEach(() => {
    discovery.availableLLMs = []
    resolver.next = null
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

describe('R2 L2: OPENAI_API_KEY only goes to OpenAI', () => {
    it('envOpenAIKeyFor returns the key only for api.openai.com', () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-owner-secret')
        vi.stubEnv('OPENAI_BASE_URL', '')
        expect(envOpenAIKeyFor('https://api.openai.com/v1')).toBe('sk-owner-secret')
        expect(envOpenAIKeyFor('http://127.0.0.1:8000/v1')).toBeUndefined()
        expect(envOpenAIKeyFor('https://api.deepseek.com/v1')).toBeUndefined()
        expect(envOpenAIKeyFor('https://api.openai.com.evil.example/v1')).toBeUndefined()
    })

    it('capability probe does not send the env key to vLLM or foreign clouds', async () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-owner-secret')
        const fetchMock = vi.fn(async () => okChat())
        vi.stubGlobal('fetch', fetchMock)

        await probeModel('http://100.86.70.71:8000/v1', 'qwen')
        await probeModel('https://evil.example/v1', 'x')
        for (const call of fetchMock.mock.calls) expect(authHeaderOf(call)).toBeUndefined()

        fetchMock.mockClear()
        await probeModel('https://api.openai.com/v1', 'gpt-x')
        expect(authHeaderOf(fetchMock.mock.calls[0])).toBe('Bearer sk-owner-secret')
    })

    it('probeAllModels probes external providers with their own key', async () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-owner-secret')
        discovery.availableLLMs = [{ provider: 'deepseek', model: 'deepseek-chat', local: false, endpoint: 'https://api.deepseek.com/v1', apiKey: 'ds-own-key' }]
        const fetchMock = vi.fn(async () => okChat())
        vi.stubGlobal('fetch', fetchMock)

        await probeAllModels(true)

        expect(fetchMock).toHaveBeenCalled()
        for (const call of fetchMock.mock.calls) expect(authHeaderOf(call)).toBe('Bearer ds-own-key')
    })

    it('local SDK provider never attaches the env key to a local endpoint', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        vi.stubEnv('OPENAI_API_KEY', 'sk-owner-secret')
        const fetchMock = vi.fn(async () => okChat())
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({ provider: 'local', model: 'qwen', baseUrl: 'http://127.0.0.1:8000/v1', isolated: true })
        await client.complete([{ role: 'user', content: 'ping' }])

        expect(fetchMock).toHaveBeenCalled()
        expect(authHeaderOf(fetchMock.mock.calls[0])).toBeUndefined()
    })
})

describe('R2 L3: no silent cloud failover', () => {
    it('isLocalEndpoint separates LAN/Tailscale from public hosts', () => {
        expect(isLocalEndpoint('http://127.0.0.1:8000/v1')).toBe(true)
        expect(isLocalEndpoint('http://100.86.70.71:8000/v1')).toBe(true)
        expect(isLocalEndpoint('http://192.168.1.20:1234')).toBe(true)
        expect(isLocalEndpoint('http://spark:8000')).toBe(true)
        expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false)
        expect(isLocalEndpoint('https://api.minimax.io/v1')).toBe(false)
    })

    it('a failing local model does not fail over to the resolver cloud pick', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '0')
        resolver.next = { id: 'gpt-5.5', provider: 'openai', role: 'chat', capabilities: ['chat'], endpoint: 'https://api.openai.com/v1' }
        const fetchMock = vi.fn(async (url: string) => {
            if (String(url).startsWith('http://127.0.0.1')) return new Response('overloaded', { status: 503 })
            return okChat()
        })
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({ provider: 'local', model: 'qwen-r2-l3', baseUrl: 'http://127.0.0.1:8000/v1', isolated: true })
        await expect(client.complete([{ role: 'user', content: 'private memory' }])).rejects.toThrow()

        const urls = fetchMock.mock.calls.map(call => String(call[0]))
        expect(urls.some(u => u.includes('api.openai.com'))).toBe(false)
    })

    it('model auto stays local when the resolver picks a cloud provider', async () => {
        resolver.next = { id: 'MiniMax-M3', provider: 'minimax', role: 'chat', capabilities: ['chat'], endpoint: 'https://api.minimax.io/v1', apiKey: 'mm-key' }
        discovery.availableLLMs = [{ provider: 'vllm', model: 'qwen-local', local: true, endpoint: 'http://100.86.70.71:8000/v1' }]

        const client = await createNovaLLMClient({ isolated: true })

        expect(client.providerId).toBe('local')
        expect(client.modelId).toBe('qwen-local')
        expect(client.getCurrentConfig()?.apiKey).toBeUndefined()
    })

    it('an explicitly configured model (no endpoint) is kept as configured', async () => {
        resolver.next = { id: 'gpt-5.5', provider: 'openai', role: 'chat', capabilities: ['chat'] }

        const client = await createNovaLLMClient({ isolated: true })

        expect(client.providerId).toBe('openai')
    })
})

describe('R2 L1: createNovaLLMClient does not switch other clients', () => {
    it('a later client with another model leaves earlier clients and the singleton untouched', async () => {
        const primary = await createNovaLLMClient({ provider: 'local', model: 'primary-model', baseUrl: 'http://127.0.0.1:8000/v1' })
        const sharedModel = getNovaLLM().modelId
        const other = await createNovaLLMClient({ provider: 'local', model: 'vision-model', baseUrl: 'http://127.0.0.1:8001/v1' })

        expect(other.modelId).toBe('vision-model')
        expect(primary.modelId).toBe('primary-model')
        expect(primary).not.toBe(other)
        expect(getNovaLLM().modelId).toBe(sharedModel)
    })
})
