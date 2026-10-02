import { describe, expect, it } from 'vitest'
import { localOpenAICandidates, resolveAutonomousEndpoint, resolveInternalLlmPlan } from './autonomous-endpoint.js'

// Live finding 2.82.0 (Spark): the main LLM runs on vLLM through
// `provider: "local"` + `providers.local.baseUrl`, but `config.nodes` carries
// no `services.vllm`. The learning/repair runtimes only looked at
// nodes[].services.vllm and Ollama, so they reported "offline" although the
// local model was right there.
const VLLM = 'http://100.64.10.20:8000'

function fakeFetch(routes: Record<string, any>, calls: string[] = []) {
    return (async (url: string) => {
        calls.push(String(url))
        const body = routes[String(url)]
        if (body === undefined) throw new Error('unreachable')
        return { ok: true, json: async () => body } as any
    }) as unknown as typeof fetch
}

const sparkConfig = {
    provider: 'local',
    model: 'qwen',
    providers: { local: { baseUrl: `${VLLM}/v1`, enabled: true } },
    nodes: [{ name: 'spark', services: {} }],
    learningModel: null,
    repairModel: null,
    internalModel: null,
}

describe('autonomous runtime endpoint', () => {
    it('falls back to the configured local OpenAI-compatible provider (Spark config)', async () => {
        const calls: string[] = []
        const endpoint = await resolveAutonomousEndpoint(sparkConfig, 'auto', {
            fetchImpl: fakeFetch({ [`${VLLM}/v1/models`]: { data: [{ id: 'qwen' }] } }, calls),
        })
        expect(endpoint).toMatchObject({ baseUrl: VLLM, model: 'qwen', provider: 'local' })
        expect(calls).toContain(`${VLLM}/v1/models`)
    })

    it('stays offline without a local provider (unchanged behaviour)', async () => {
        const endpoint = await resolveAutonomousEndpoint({ provider: 'local', nodes: [] }, 'auto', {
            fetchImpl: fakeFetch({}),
        })
        expect(endpoint).toBeNull()
    })

    it('never uses a cloud base URL as an autonomous runtime', () => {
        const candidates = localOpenAICandidates({
            provider: 'openai',
            providers: { openai: { baseUrl: 'https://api.example.com/v1' }, local: { baseUrl: 'https://llm.example.com/v1' } },
        })
        expect(candidates).toEqual([])
    })

    it('stays offline when the local provider is configured but unreachable', async () => {
        const endpoint = await resolveAutonomousEndpoint(sparkConfig, 'auto', { fetchImpl: fakeFetch({}) })
        expect(endpoint).toBeNull()
    })

    it('honours an explicitly requested model and does not substitute another one', async () => {
        const fetchImpl = fakeFetch({ [`${VLLM}/v1/models`]: { data: [{ id: 'qwen' }] } })
        expect(await resolveAutonomousEndpoint(sparkConfig, 'other-model', { fetchImpl })).toBeNull()
        expect(await resolveAutonomousEndpoint(sparkConfig, 'qwen', { fetchImpl })).toMatchObject({ model: 'qwen' })
    })

    it('keeps the provider apiKey only for that local endpoint', async () => {
        const endpoint = await resolveAutonomousEndpoint({
            ...sparkConfig,
            providers: { local: { baseUrl: `${VLLM}/v1`, apiKey: 'test-key' } },
        }, 'auto', { fetchImpl: fakeFetch({ [`${VLLM}/v1/models`]: { data: [{ id: 'qwen' }] } }) })
        expect(endpoint?.apiKey).toBe('test-key')
    })

    it('still prefers a node vLLM service when one is declared', async () => {
        const nodeBase = 'http://192.168.1.50:8000'
        const endpoint = await resolveAutonomousEndpoint({
            ...sparkConfig,
            nodes: [{ name: 'gpu', services: { vllm: nodeBase } }],
        }, 'auto', { fetchImpl: fakeFetch({ [`${nodeBase}/v1/models`]: { data: [{ id: 'qwen-a' }] }, [`${VLLM}/v1/models`]: { data: [{ id: 'qwen' }] } }) })
        expect(endpoint).toMatchObject({ baseUrl: nodeBase, provider: 'vllm', model: 'qwen-a' })
    })
})

describe('internal LLM plan (private data never goes to the cloud)', () => {
    it('uses the local learning runtime when one exists', () => {
        expect(resolveInternalLlmPlan('auto', { model: 'qwen', provider: 'local' })).toEqual({ kind: 'local-runtime', label: 'qwen via local (lokal)' })
    })

    it('has no internal LLM instead of the cloud main client when nothing local exists', () => {
        expect(resolveInternalLlmPlan('auto', null)).toEqual({ kind: 'none' })
        expect(resolveInternalLlmPlan(null, null)).toEqual({ kind: 'none' })
    })

    it('keeps an explicitly named Ollama internal model', () => {
        expect(resolveInternalLlmPlan('llama3', { model: 'qwen', provider: 'local' })).toEqual({ kind: 'ollama', model: 'llama3' })
    })
})

describe('daemon wiring', () => {
    it('builds the learning/repair runtimes from the shared resolver and never points the internal LLM at the main client', async () => {
        const { readFileSync } = await import('node:fs')
        const source = readFileSync(new URL('../daemon.ts', import.meta.url), 'utf8')
        expect(source).toContain('resolveAutonomousEndpoint(config, requested)')
        expect(source).toContain('resolveInternalLlmPlan(')
        expect(source).not.toContain('state.internalLlm = state.llm')
        expect(source).not.toContain("Internal LLM: Cloud (auto)')")
    })
})
