import { describe, expect, it, vi } from 'vitest'
import { miniMaxServiceClient, resolveCloudServicePlan } from './cloud-service-model.js'

// Live 28.10.2026 after B5 (ns1-Qwen off): "Learning Runtime offline — kein eigenes lokales Modell erreichbar",
// Repair offline, "Internal LLM: keins". The owner allowed MiniMax for these background runtimes.
const key = (name: string) => name === 'minimax' ? 'mm-test-key' : ''

describe('owner-approved cloud model for the background runtimes', () => {
    it('stays off without the explicit switch (local stays the default for every installation)', () => {
        expect(resolveCloudServicePlan({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', providers: { minimax: {} } }, key)).toBeNull()
        expect(resolveCloudServicePlan({ autonomy: { cloudServiceModel: { enabled: 'yes' } } }, key)).toBeNull()
    })

    it('uses MiniMax with the main model when the owner switched it on', () => {
        const plan = resolveCloudServicePlan({
            provider: 'minimax', model: 'MiniMax-M3.1-Flash', providers: { minimax: { apiKeyRef: 'auth:minimax' } },
            autonomy: { cloudServiceModel: { enabled: true } },
        }, key)
        expect(plan).toEqual({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', baseUrl: 'https://api.minimax.io/v1', apiKey: 'mm-test-key' })
    })

    it('no key, a disabled provider or another provider: no cloud', () => {
        const on = { autonomy: { cloudServiceModel: { enabled: true } } }
        expect(resolveCloudServicePlan(on, () => '')).toBeNull()
        expect(resolveCloudServicePlan({ ...on, providers: { minimax: { enabled: false } } }, key)).toBeNull()
        expect(resolveCloudServicePlan({ autonomy: { cloudServiceModel: { enabled: true, provider: 'openai' } } }, () => 'sk-test')).toBeNull()
    })

    it('speaks the service-runtime contract and keeps tool-call ids', async () => {
        const complete = vi.fn(async () => ({ content: 'ok', model: 'MiniMax-M3.1-Flash', tokensUsed: 12, stopReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'recall', arguments: { q: 'x' } }] }))
        const client = miniMaxServiceClient({ complete }, 45_000)
        const result = await client.complete([
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', function: { name: 'recall', arguments: '{"q":"a"}' } }] },
            { role: 'tool', tool_call_id: 'call_0', content: 'r' },
        ], [{ name: 'recall', description: 'd', parameters: { type: 'object', properties: {} } }], { maxTokens: 200 })
        expect(result).toMatchObject({ content: 'ok', toolCalls: [{ id: 'call_1', name: 'recall', arguments: { q: 'x' } }], tokensUsed: 12 })
        const [messages, options] = complete.mock.calls[0] as any
        expect(messages[1].toolCalls).toEqual([{ id: 'call_0', name: 'recall', arguments: { q: 'a' } }])
        expect(messages[2].toolCallId).toBe('call_0')
        expect(options.maxTokens).toBe(200)
        expect(options.signal).toBeInstanceOf(AbortSignal)
    })
})
