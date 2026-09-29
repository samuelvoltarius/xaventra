import { afterEach, describe, expect, it, vi } from 'vitest'

const chain = vi.hoisted(() => ({ entries: [] as Array<{ provider: string; model: string }> }))
const discovery = vi.hoisted(() => ({ availableLLMs: [] as any[] }))

vi.mock('./model-discovery.js', () => ({ buildFallbackChain: () => chain.entries }))
vi.mock('../core/model-defaults.js', () => ({ getDefaultModel: () => 'qwen-from-config' }))
vi.mock('../core/llm-factory.js', () => ({
    get availableLLMs() { return discovery.availableLLMs },
    getNovaConfig: () => ({}),
}))

import { getDefaultFallbacks } from './model-fallback.js'
import { createNovaLLMClient } from './nova-llm-sdk.js'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    chain.entries = []
    discovery.availableLLMs = []
})

describe('R2 L9: ESM require() sites work again (local only)', () => {
    it('seed fallbacks use the configured default model', () => {
        expect(getDefaultFallbacks()).toEqual([
            { provider: 'local', model: 'qwen-from-config' },
            { provider: 'local', model: 'auto' },
        ])
    })

    it('dynamic fallback chain is used, without cloud models and capped', () => {
        chain.entries = [
            { provider: 'ollama', model: 'qwen3.5:27b' },
            { provider: 'custom', model: 'Qwen3-Next' },
            { provider: 'openai', model: 'gpt-5.5' },
            { provider: 'anthropic', model: 'claude-x' },
            { provider: 'llama-cpp', model: 'gemma' },
            { provider: 'ollama', model: 'qwen2.5:7b' },
        ]

        const fallbacks = getDefaultFallbacks()

        expect(fallbacks).toEqual([
            { provider: 'ollama', model: 'qwen3.5:27b' },
            { provider: 'local', model: 'Qwen3-Next' },
            { provider: 'llama-cpp', model: 'gemma' },
        ])
    })

    it('local provider fails over to a discovered localhost endpoint', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        discovery.availableLLMs = [{ provider: 'vllm', model: 'backup-model', local: true, endpoint: 'http://localhost:1234/v1' }]
        const fetchMock = vi.fn(async (url: string) => {
            if (String(url).includes(':8000')) return new Response('down', { status: 503 })
            return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'BACKUP_OK' } }] }), { status: 200 })
        })
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({ provider: 'local', model: 'primary-l9', baseUrl: 'http://127.0.0.1:8000/v1', isolated: true })
        const response = await client.complete([{ role: 'user', content: 'ping' }])

        expect(response.content).toBe('BACKUP_OK')
        expect(fetchMock.mock.calls.some(call => String(call[0]).startsWith('http://localhost:1234/'))).toBe(true)
    })
})
