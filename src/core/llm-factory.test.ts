import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { availableLLMs, createLLM } from './llm-factory.js'
import { setNovaConfig } from './config.js'
import { createNovaLLMClient } from '../llm/nova-llm-sdk.js'

vi.mock('../llm/nova-llm-sdk.js', () => ({
    createNovaLLMClient: vi.fn(async config => ({ getCurrentConfig: () => config, configure: vi.fn(), complete: vi.fn(async () => ({ content: 'observed' })) })),
}))
beforeEach(() => { availableLLMs.length = 0; setNovaConfig({}); vi.clearAllMocks() })
afterEach(() => { availableLLMs.length = 0; setNovaConfig({}) })

describe('explicit local endpoint selection', () => {
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
