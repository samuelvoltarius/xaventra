import { afterEach, describe, expect, it, vi } from 'vitest'

// Never touch the real Codex CLI on this machine.
vi.mock('./codex-cli-adapter.js', () => ({
    CodexCLIAdapter: class {},
    isCodexAvailable: () => false,
    isCodexAuthenticated: () => false,
}))

import { createNovaLLMClient } from './nova-llm-sdk.js'
import { AnthropicLLM } from './anthropic.js'
import { OpenAILLM } from './openai.js'
import { CustomLLM } from './custom.js'
import { LocalLLM } from './local-llm.js'

afterEach(() => {
    vi.unstubAllGlobals()
})

const openAIBody = () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
}), { status: 200 })
const anthropicBody = () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200 })

function ndjsonStream(parts: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part))
            controller.close()
        },
    })
    return new Response(body, { status: 200 })
}

function signalOf(fetchMock: ReturnType<typeof vi.fn>): unknown {
    return ((fetchMock.mock.calls[0] as any[])?.[1] || {}).signal
}

describe('R2 L11: cloud and stream calls carry an abort signal', () => {
    it('SDK Claude and OpenAI completions', async () => {
        const claudeFetch = vi.fn(async () => anthropicBody())
        vi.stubGlobal('fetch', claudeFetch)
        const claude = await createNovaLLMClient({ provider: 'claude', model: 'c', apiKey: 'sk-ant-api03-x', isolated: true })
        await claude.complete([{ role: 'user', content: 'hi' }])
        expect(signalOf(claudeFetch)).toBeInstanceOf(AbortSignal)

        const openaiFetch = vi.fn(async () => openAIBody())
        vi.stubGlobal('fetch', openaiFetch)
        const openai = await createNovaLLMClient({ provider: 'openai', model: 'o', apiKey: 'sk-x', isolated: true })
        await openai.complete([{ role: 'user', content: 'hi' }])
        expect(signalOf(openaiFetch)).toBeInstanceOf(AbortSignal)
    })

    it('legacy Anthropic/OpenAI/custom adapters', async () => {
        const a = vi.fn(async () => anthropicBody())
        vi.stubGlobal('fetch', a)
        await new AnthropicLLM({ apiKey: 'k', model: 'm' } as any).complete([{ role: 'user', content: 'hi' }])
        expect(signalOf(a)).toBeInstanceOf(AbortSignal)

        const o = vi.fn(async () => openAIBody())
        vi.stubGlobal('fetch', o)
        await new OpenAILLM({ apiKey: 'k', model: 'm' }).complete([{ role: 'user', content: 'hi' }])
        expect(signalOf(o)).toBeInstanceOf(AbortSignal)

        const c = vi.fn(async () => new Response(JSON.stringify({ message: { content: 'OK' }, done: true }), { status: 200 }))
        vi.stubGlobal('fetch', c)
        await new CustomLLM({ baseUrl: 'http://127.0.0.1:11434', model: 'm', type: 'ollama' }).complete([{ role: 'user', content: 'hi' }])
        expect(signalOf(c)).toBeInstanceOf(AbortSignal)
    })

    it('local Ollama stream', async () => {
        const s = vi.fn(async () => ndjsonStream([JSON.stringify({ message: { content: 'OK' } }) + '\n']))
        vi.stubGlobal('fetch', s)
        for await (const _ of new LocalLLM({ baseUrl: 'http://127.0.0.1:11434', model: 'm' }).stream([{ role: 'user', content: 'hi' }])) { /* drain */ }
        expect(signalOf(s)).toBeInstanceOf(AbortSignal)
    })
})

describe('R2 L18: Ollama NDJSON lines split across chunks are not lost', () => {
    const line1 = JSON.stringify({ message: { content: 'Hallo ' } }) + '\n'
    const line2 = JSON.stringify({ message: { content: 'Alfred' } }) + '\n'
    const parts = [line1.slice(0, 10), line1.slice(10) + line2.slice(0, 7), line2.slice(7)]

    it('local-llm streamOllama', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonStream(parts)))
        let text = ''
        for await (const chunk of new LocalLLM({ baseUrl: 'http://127.0.0.1:11434', model: 'm' }).stream([{ role: 'user', content: 'hi' }])) text += chunk
        expect(text).toBe('Hallo Alfred')
    })

    it('custom streamOllama', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonStream(parts)))
        let text = ''
        for await (const chunk of new CustomLLM({ baseUrl: 'http://127.0.0.1:11434', model: 'm', type: 'ollama' }).stream([{ role: 'user', content: 'hi' }])) text += chunk
        expect(text).toBe('Hallo Alfred')
    })
})
