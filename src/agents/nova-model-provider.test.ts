import { describe, expect, it, vi } from 'vitest'
import type { ModelRequest } from '@openai/agents'
import { NovaAgentsModel, NovaModelProvider, inputToMessages } from './nova-model-provider.js'
import { sdkInput } from './sdk-runtime.js'

const request = (): ModelRequest => ({ input: 'check mal url --get http://search.example/search --data-urlencode q=Agent --data-urlencode format=json',
    tools: [{ type: 'function', name: 'fetch_url', description: 'Read HTTP URL', parameters: { type: 'object', properties: {} }, strict: false }],
    modelSettings: {}, outputType: { type: 'text' }, handoffs: [], tracing: false } as any)
const call = (name: string) => ({ content: '', toolCalls: [{ id: 'call-1', name, arguments: { url: 'http://search.example/search?q=Agent&format=json' } }] })

describe('Nova SDK model bridge', () => {
    it('replans an unexecuted out-of-catalog tool once without expanding the offered catalog', async () => {
        const client = { complete: vi.fn().mockResolvedValueOnce(call('run_command')).mockResolvedValueOnce(call('fetch_url')) }
        const result = await new NovaAgentsModel('qwen', { client }).getResponse(request())
        expect(client.complete).toHaveBeenCalledTimes(2)
        expect(result.output[0]).toMatchObject({ name: 'fetch_url' })
        for (const args of client.complete.mock.calls) expect(args[1].map((tool: any) => tool.name)).toEqual(['fetch_url'])
        expect(client.complete.mock.calls[1][0].at(-1).content).toContain('not executed')
    })
    it('stops after one correction across SDK turns, not once per getModel call', async () => {
        const client = { complete: vi.fn().mockResolvedValueOnce(call('run_command')).mockResolvedValueOnce(call('fetch_url')).mockResolvedValue(call('run_command')) }
        const provider = new NovaModelProvider({ client })
        await provider.getModel('qwen').getResponse(request())
        await expect(provider.getModel('qwen').getResponse(request())).rejects.toThrow('outside the offered contract')
        expect(client.complete).toHaveBeenCalledTimes(3)
    })
    it('counts both inference responses when repairing the rejected batch', async () => {
        const client = { complete: vi.fn()
            .mockResolvedValueOnce({ ...call('run_command'), usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })
            .mockResolvedValueOnce({ ...call('fetch_url'), usage: { promptTokens: 15, completionTokens: 3, totalTokens: 18 } }) }
        const result = await new NovaAgentsModel('qwen', { client }).getResponse(request())
        expect(result.usage).toMatchObject({ requests: 2, inputTokens: 25, outputTokens: 5, totalTokens: 30 })
    })
    it('groups parallel calls into one assistant message before their correlated results', () => {
        const messages = inputToMessages(undefined, [
            { type: 'function_call', callId: 'a', name: 'fetch_url', arguments: '{}' },
            { type: 'function_call', callId: 'b', name: 'web_search', arguments: '{}' },
            { type: 'function_call_result', callId: 'a', output: 'page' },
            { type: 'function_call_result', callId: 'b', output: 'results' },
        ] as any)
        expect(messages).toHaveLength(3)
        expect(messages[0].toolCalls?.map(call => call.id)).toEqual(['a', 'b'])
        expect(messages.slice(1).map(message => message.toolCallId)).toEqual(['a', 'b'])
    })
    it('does not retry provider failures or real tool error output', async () => {
        const client = { complete: vi.fn().mockRejectedValue(new Error('provider unavailable')) }
        await expect(new NovaAgentsModel('qwen', { client }).getResponse(request())).rejects.toThrow('provider unavailable')
        expect(client.complete).toHaveBeenCalledTimes(1)
    })
    it('does not expose any tool when tool choice is none', async () => {
        const client = { complete: vi.fn().mockResolvedValue(call('run_command')) }
        const input = request(); input.modelSettings.toolChoice = 'none'
        await expect(new NovaAgentsModel('qwen', { client }).getResponse(input)).rejects.toThrow('outside the offered contract')
        expect(client.complete.mock.calls[0][1]).toEqual([])
        expect(client.complete).toHaveBeenCalledTimes(1)
    })
    it('does not begin inference after cancellation', async () => {
        const client = { complete: vi.fn() }
        const controller = new AbortController(); controller.abort()
        await expect(new NovaAgentsModel('qwen', { client }).getResponse({ ...request(), signal: controller.signal })).rejects.toThrow('AbortError')
        expect(client.complete).not.toHaveBeenCalled()
    })
    it('rejects late model output after cancellation', async () => {
        let finish!: (value: any) => void
        const client = { complete: vi.fn(() => new Promise<any>(resolve => { finish = resolve })) }
        const controller = new AbortController()
        const pending = new NovaAgentsModel('qwen', { client }).getResponse({ ...request(), signal: controller.signal })
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledTimes(1))
        controller.abort()
        await expect(pending).rejects.toThrow('AbortError')
        finish(call('fetch_url'))
    })
    it('retains history, correlated tool results and an input image through the bridge', () => {
        const messages: any[] = [
            { role: 'system', content: 'Instructions' }, { role: 'user', content: 'Previous question' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'proof', name: 'fetch_url', arguments: {} }] },
            { role: 'tool', toolCallId: 'proof', content: '{"results":[{"title":"Agent"}]}' },
            { role: 'user', content: 'What is visible?', image: { data: 'YWJj', mimeType: 'image/png' } },
        ]
        expect(inputToMessages(undefined, sdkInput(messages))).toEqual(messages)
    })
})
