import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { availableLLMs, createLLM } from './llm-factory.js'
import { setNovaConfig } from './config.js'
import { createNovaLLMClient } from '../llm/nova-llm-sdk.js'
import { LocalLLM } from '../llm/local-llm.js'
import * as fallback from '../llm/model-fallback.js'

vi.mock('../llm/nova-llm-sdk.js', () => ({
    createNovaLLMClient: vi.fn(async config => ({ getCurrentConfig: () => config, configure: vi.fn(), complete: vi.fn(async () => ({ content: 'observed' })) })),
}))
beforeEach(() => { availableLLMs.length = 0; setNovaConfig({}); vi.clearAllMocks() })
afterEach(() => { availableLLMs.length = 0; setNovaConfig({}); vi.restoreAllMocks() })

describe('explicit local endpoint selection', () => {
    it('preserves usage, correlated tool messages and generation limits on the local fallback route', async () => {
        availableLLMs.push({ provider: 'local', model: 'fallback-model', local: true, endpoint: 'http://127.0.0.1:19992' })
        vi.spyOn(LocalLLM.prototype, 'checkAvailable').mockResolvedValue(true)
        vi.spyOn(LocalLLM.prototype, 'complete').mockResolvedValue({ content: 'legacy', model: 'fallback-model' })
        // Force selection of the existing fallback branch; no actual network or
        // cloud failover is claimed by this wrapper-contract test.
        vi.spyOn(fallback, 'runWithModelFallback').mockImplementationOnce(async (options: any) => ({ result: await options.run('local', 'auto'), attempts: [], model: 'fallback-model' } as any))
        const usage = { promptTokens: 321, completionTokens: 12, totalTokens: 333 }
        const llm = await createLLM({ provider: 'local', model: 'chosen-model', providers: { local: { enabled: true, baseUrl: 'http://127.0.0.1:19993' } } })
        const complete = vi.fn(async () => ({ content: 'observed', usage }))
        vi.mocked(createNovaLLMClient).mockResolvedValueOnce({ complete } as any)
        const messages = [
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'one.txt' } }] },
            { role: 'tool', toolCallId: 'c1', content: 'actual tool data' },
        ]
        const result = await llm.complete(messages, [], { maxTokens: 23, timeoutMs: 7000 })
        expect(result.usage).toEqual(usage)
        expect(complete).toHaveBeenCalledWith(messages, [], expect.objectContaining({ maxTokens: 23, timeoutMs: 7000 }))
        expect(createNovaLLMClient).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'local', isolated: true }))
    })
    it('retains a configured model absent from opportunistic discovery', async () => {
        availableLLMs.push({ provider: 'local', model: 'different-model', local: true, endpoint: 'http://127.0.0.1:19991/v1' })
        const llm = await createLLM({ provider: 'local', model: 'chosen-model', providers: { local: { enabled: true, baseUrl: 'http://127.0.0.1:19992/v1' } } })
        expect(llm.modelId).toBe('chosen-model')
        expect(createNovaLLMClient).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local', model: 'chosen-model', baseUrl: 'http://127.0.0.1:19992/v1' }))
    })

    it('does not let a same-name cloud discovery entry override a local endpoint', async () => {
        availableLLMs.push({ provider: 'openai', model: 'shared-model', local: false })
        const llm = await createLLM({ provider: 'local', model: 'shared-model', providers: { local: { enabled: true, baseUrl: 'http://127.0.0.1:19992/v1' } } })
        expect(llm.provider).toBe('local')
        expect(createNovaLLMClient).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local', model: 'shared-model', baseUrl: 'http://127.0.0.1:19992/v1' }))
    })

    it('preserves correlated tool turns and call budgets through the runtime wrapper', async () => {
        availableLLMs.push({ provider: 'local', model: 'chosen-model', local: true, endpoint: 'http://127.0.0.1:19992/v1' })
        const llm = await createLLM({ provider: 'local', model: 'chosen-model' })
        const messages = [
            { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'one.txt' } }] },
            { role: 'tool', toolCallId: 'call-1', content: 'observed data' },
        ]
        await llm.complete(messages, [], { maxTokens: 128, toolChoice: 'auto' })
        const client = await vi.mocked(createNovaLLMClient).mock.results[0].value
        expect(client.complete).toHaveBeenCalledWith(messages, [], { maxTokens: 128, toolChoice: 'auto' })
    })
})
