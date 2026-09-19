import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { NovaLLM, TokenManager } from './nova-llm-sdk.js'

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
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }), { headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const client = new NovaLLM(join(process.cwd(), 'inert-auth.json'))
        client.configure({ provider, model: 'fixture-model', maxTokens: 100 })
        await client.complete([{ role: 'user', content: 'ping' }], [], { maxTokens: 17 })
        await client.complete([{ role: 'user', content: 'ping' }], [], { maxTokens: 150 })
        expect(fetchMock.mock.calls.map(call => JSON.parse(String((call as any)[1].body)).max_tokens)).toEqual([17, 100])
    })
})
