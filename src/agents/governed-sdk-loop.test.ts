import { describe, expect, it, vi } from 'vitest'
import { runGovernedSdkLoop } from './governed-sdk-loop.js'

const definitions = ['fetch_url', 'web_search'].map(name => ({ name, description: name,
    parameters: { type: 'object' as const, properties: { query: { type: 'string' } }, required: [] } }))
const call = (name: string, id = name) => ({ id, name, arguments: { query: 'Agent' } })
const response = (toolCalls: ReturnType<typeof call>[] = [], content = '') => ({ content, toolCalls }) as any

describe('actual SDK governed continuation loop', () => {
    it('corrects the reported unoffered shell proposal before effects and returns real HTTP data', async () => {
        const complete = vi.fn().mockResolvedValueOnce(response([call('fetch_url')]))
            .mockResolvedValueOnce(response([], 'HTTP 200: Agent result'))
        const execute = vi.fn(async () => 'HTTP 200: Agent result')
        const output = await runGovernedSdkLoop({ messages: [{ role: 'user', content: 'check mal url -sS --get /search q=Agent' }],
            tools: definitions, initialResponse: response([call('run_command')]),
            modelOptions: { client: { complete } }, execute, maxTurns: 4 })
        expect(output).toBe('HTTP 200: Agent result')
        expect(execute).toHaveBeenCalledOnce()
        expect(execute.mock.calls[0][0]).toMatchObject({ name: 'fetch_url', id: 'fetch_url' })
        expect(complete.mock.calls.every(args => args[1].map((tool: any) => tool.name).join() === 'fetch_url,web_search')).toBe(true)
        expect(complete.mock.calls[1][0]).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'tool', toolCallId: 'fetch_url', content: 'HTTP 200: Agent result' }),
        ]))
    })
    it('uses the same executor for additional SDK turns with correlated results', async () => {
        const complete = vi.fn().mockResolvedValueOnce(response([call('web_search', 'search-2')]))
            .mockResolvedValueOnce(response([], 'two sources'))
        const execute = vi.fn(async (item: any) => `source:${item.id}`)
        await runGovernedSdkLoop({ messages: [{ role: 'user', content: 'research' }], tools: definitions,
            initialResponse: response([call('fetch_url', 'fetch-1')]), modelOptions: { client: { complete } }, execute, maxTurns: 4 })
        expect(execute.mock.calls.map(args => args[0].id)).toEqual(['fetch-1', 'search-2'])
        expect(complete.mock.calls[1][0].filter((item: any) => item.role === 'tool').map((item: any) => item.toolCallId)).toEqual(['fetch-1', 'search-2'])
    })
    it('stops queued siblings and model continuation after an execution denial', async () => {
        const complete = vi.fn()
        const execute = vi.fn(async () => { throw new Error('policy gate') })
        await expect(runGovernedSdkLoop({ messages: [], tools: definitions,
            initialResponse: response([call('fetch_url'), call('web_search')]), modelOptions: { client: { complete } }, execute, maxTurns: 4 })).rejects.toThrow('policy gate')
        expect(execute).toHaveBeenCalledOnce()
        expect(complete).not.toHaveBeenCalled()
    })
    it('never dispatches a repeated invalid proposal or the valid sibling in its batch', async () => {
        const complete = vi.fn().mockResolvedValue(response([call('run_command'), call('fetch_url')]))
        const execute = vi.fn()
        await expect(runGovernedSdkLoop({ messages: [], tools: definitions,
            initialResponse: response([call('run_command'), call('fetch_url')]), modelOptions: { client: { complete } }, execute, maxTurns: 4 })).rejects.toThrow('repeated a tool outside')
        expect(execute).not.toHaveBeenCalled()
        expect(complete).toHaveBeenCalledOnce()
    })
    it('honors cancellation before any seeded effect', async () => {
        const controller = new AbortController()
        controller.abort()
        const execute = vi.fn()
        await expect(runGovernedSdkLoop({ messages: [], tools: definitions,
            initialResponse: response([call('fetch_url')]), modelOptions: { client: { complete: vi.fn() } }, execute, maxTurns: 4,
            signal: controller.signal })).rejects.toThrow()
        expect(execute).not.toHaveBeenCalled()
    })
    it('enforces an SDK turn limit instead of an unbounded application retry loop', async () => {
        const execute = vi.fn(async () => 'read result')
        await expect(runGovernedSdkLoop({ messages: [], tools: definitions,
            initialResponse: response([call('fetch_url')]),
            modelOptions: { client: { complete: vi.fn().mockResolvedValue(response([call('web_search')])) } }, execute, maxTurns: 2 })).rejects.toThrow()
        expect(execute.mock.calls.length).toBeLessThanOrEqual(2)
    })
})
