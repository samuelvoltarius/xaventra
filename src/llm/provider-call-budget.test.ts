import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { NovaLLM, TokenManager } from './nova-llm-sdk.js'
import { InferenceBudget } from '../core/inference-budget.js'

vi.mock('./codex-cli-adapter.js', () => ({
    CodexCLIAdapter: class {}, isCodexAvailable: () => false, isCodexAuthenticated: () => false,
}))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('cloud HTTP generation allowances', () => {
    it.each(['openai', 'claude'] as const)('%s respects a lower per-call or configured allowance', async provider => {
        vi.spyOn(TokenManager.prototype, 'getToken').mockResolvedValue({ token: 'fixture-not-a-credential' })
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            content: [{ type: 'text', text: 'ok' }],
            usage: provider === 'claude' ? { input_tokens: 10, output_tokens: 1 }
                : { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }), { headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const client = new NovaLLM(join(process.cwd(), 'inert-auth.json'))
        client.configure({ provider, model: 'fixture-model', maxTokens: 100 })
        await client.complete([{ role: 'user', content: 'ping' }], [], { maxTokens: 17 })
        await client.complete([{ role: 'user', content: 'ping' }], [], { maxTokens: 150 })
        expect(fetchMock.mock.calls.map(call => JSON.parse(String((call as any)[1].body)).max_tokens)).toEqual([17, 100])
    })

    it('retains Claude usage, including cache input, across native continuation rounds', async () => {
        vi.spyOn(TokenManager.prototype, 'getToken').mockResolvedValue({ token: 'fixture-not-a-credential' })
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 34, output_tokens: 7 },
        }), { headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const client = new NovaLLM(join(process.cwd(), 'inert-auth.json'))
        client.configure({ provider: 'claude', model: 'fixture-model' })
        const budget = new InferenceBudget({ timeoutMs: 1000, maxToolCalls: 4, maxOutputTokens: 20 })
        const wrapped = budget.wrap(client)
        await wrapped.complete([{ role: 'user', content: 'one' }])
        await wrapped.complete([{ role: 'user', content: 'two' }])
        expect(budget.snapshot()).toMatchObject({ inputTokens: 2468, outputTokens: 14, totalTokens: 2482, estimated: false })
        expect(fetchMock.mock.calls.map(call => JSON.parse(String((call as any)[1].body)).max_tokens)).toEqual([20, 13])
    })
})
