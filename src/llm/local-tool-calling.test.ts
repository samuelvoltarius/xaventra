import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNovaLLMClient } from './nova-llm-sdk.js'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

describe('local OpenAI-compatible tool calling', () => {
    it('uses an explicitly configured loopback vLLM endpoint before discovery completes', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'NOVA_SPARK_OK' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({ provider: 'local', model: 'qwen', baseUrl: 'http://127.0.0.1:8000/v1' })
        const response = await client.complete([{ role: 'user', content: 'ping' }])

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8000/v1/chat/completions',
            expect.objectContaining({ method: 'POST' }),
        )
        expect(response.content).toBe('NOVA_SPARK_OK')
    })

    it('never exposes provider reasoning with an orphaned closing think marker', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'The user requests an exact reply.\n</think>\n\nNOVA_SPARK_OK' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })))

        const client = await createNovaLLMClient({ provider: 'local', model: 'qwen', baseUrl: 'http://127.0.0.1:8000/v1' })
        const response = await client.complete([{ role: 'user', content: 'ping' }])

        expect(response.content).toBe('NOVA_SPARK_OK')
    })

    it('forwards an explicit output-token budget to vLLM', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'BENCHMARK_RESULT: READY' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({
            provider: 'local',
            model: 'qwen',
            baseUrl: 'http://127.0.0.1:8000/v1',
        })
        await client.complete(
            [{ role: 'user', content: 'short benchmark plan' }],
            [],
            { maxTokens: 256 },
        )

        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        expect(body.max_tokens).toBe(256)
    })

    it('forwards tool schemas to vLLM and parses the verified tool call', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({
            choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'call-1', function: { name: 'health_status', arguments: '{}' } }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const client = await createNovaLLMClient({ provider: 'local', model: 'qwen-test', baseUrl: 'http://mesh.test:8000' })
        const response = await client.complete([{ role: 'user', content: 'check health' }], [{
            name: 'health_status', description: 'Get health', parameters: { type: 'object', properties: {} },
        }])
        const call = fetchMock.mock.calls.find(([url]) => String(url).includes('mesh.test'))
        const body = JSON.parse(String(call?.[1]?.body))
        expect(body.tools[0].function.name).toBe('health_status')
        expect(body.tool_choice).toBe('auto')
        expect(response.toolCalls).toEqual([{ id: 'call-1', name: 'health_status', arguments: {} }])
        expect(response.finishReason).toBe('tool_calls')
    })
})
