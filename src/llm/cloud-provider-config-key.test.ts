import { afterEach, describe, expect, it, vi } from 'vitest'

// Never touch the real Codex CLI on this machine.
vi.mock('./codex-cli-adapter.js', () => ({
    CodexCLIAdapter: class {},
    isCodexAvailable: () => false,
    isCodexAuthenticated: () => false,
}))

import { createNovaLLMClient } from './nova-llm-sdk.js'

afterEach(() => {
    vi.unstubAllGlobals()
})

function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    return ((fetchMock.mock.calls[0] as any[])?.[1]?.headers || {}) as Record<string, string>
}

describe('R2 L10: cloud providers use the configured key with the right header', () => {
    it('Claude sends the configured API key as x-api-key', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({ provider: 'claude', model: 'claude-test', apiKey: 'sk-ant-api03-test', isolated: true })
        await client.complete([{ role: 'user', content: 'hi' }])

        const headers = headersOf(fetchMock)
        expect(String((fetchMock.mock.calls[0] as any[])[0])).toBe('https://api.anthropic.com/v1/messages')
        expect(headers['x-api-key']).toBe('sk-ant-api03-test')
        expect(headers['Authorization']).toBeUndefined()
    })

    it('OpenAI uses the configured key without .nova-data/auth.json', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const client = await createNovaLLMClient({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-config-test', isolated: true })
        const response = await client.complete([{ role: 'user', content: 'hi' }])

        expect(response.content).toBe('OK')
        expect(String((fetchMock.mock.calls[0] as any[])[0])).toBe('https://api.openai.com/v1/chat/completions')
        expect(headersOf(fetchMock)['Authorization']).toBe('Bearer sk-config-test')
    })
})
