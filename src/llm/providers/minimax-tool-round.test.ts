import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMiniMaxLLM } from './minimax.js'

// Prüfstand 2.89.10 (28.10.2026, VM 130): a10 „google nach … photo-aigner.at“ und a12 „Wie viel Akku hat der Dolphin?“
// "[NovaLLM] MiniMax MiniMax-M3.1-Flash failed: Error: MiniMax API error (400): {"type":"error","error":{"type":"bad_request_err…"
// right after the first tool result → all MiniMax models 400 → local fallback → timeout.
// The OpenAI-compatible request sent every message as {role, content}: the assistant's tool_calls and the
// tool message's tool_call_id were dropped, which an OpenAI-compatible API rejects.

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('MiniMax OpenAI endpoint: tool rounds keep their linkage', () => {
    const realFetch = globalThis.fetch
    afterEach(() => { globalThis.fetch = realFetch })

    it('returns the tool call id and sends tool_calls / tool_call_id back in the next round', async () => {
        const bodies: any[] = []
        globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
            bodies.push(JSON.parse(String(init?.body)))
            return bodies.length === 1
                ? reply({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'google_search', arguments: '{"query":"Alfred Aigner photo-aigner.at"}' } }] } }] })
                : reply({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'photo-aigner.at gehört Alfred Aigner.' } }] })
        }) as typeof fetch
        const llm = createMiniMaxLLM({ apiKey: 'fake-minimax-key-xxxxxxxx', model: 'MiniMax-M3.1-Flash' })
        const tools = [{ name: 'google_search', description: 'search', parameters: [{ name: 'query', type: 'string', description: 'q', required: true }] }]

        const first = await llm.complete([{ role: 'user', content: 'google nach Alfred Aigner photo-aigner.at' }] as any, { tools })
        expect(first.toolCalls?.[0]).toMatchObject({ id: 'call_abc', name: 'google_search' })

        const second = await llm.complete([
            { role: 'user', content: 'google nach Alfred Aigner photo-aigner.at' },
            { role: 'assistant', content: '', toolCalls: first.toolCalls },
            { role: 'tool', content: '9 Treffer: https://photo-aigner.at/ueber-mich.html', toolCallId: 'call_abc' },
        ] as any, { tools })
        expect(second.content).toContain('photo-aigner')

        const sent = bodies[1].messages
        const assistant = sent.find((m: any) => m.role === 'assistant')
        expect(assistant.tool_calls).toEqual([{ id: 'call_abc', type: 'function', function: { name: 'google_search', arguments: '{"query":"Alfred Aigner photo-aigner.at"}' } }])
        const tool = sent.find((m: any) => m.role === 'tool')
        expect(tool).toEqual({ role: 'tool', tool_call_id: 'call_abc', content: '9 Treffer: https://photo-aigner.at/ueber-mich.html' })
    })

    it('a tool message whose call id is unknown is sent as plain context, never as an orphan tool message', async () => {
        const bodies: any[] = []
        globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
            bodies.push(JSON.parse(String(init?.body)))
            return reply({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })
        }) as typeof fetch
        const llm = createMiniMaxLLM({ apiKey: 'fake-minimax-key-xxxxxxxx', model: 'MiniMax-M3.1-Flash' })
        await llm.complete([
            { role: 'user', content: 'Wie viel Akku hat der Dolphin?' },
            { role: 'tool', content: 'sensor.dolphin_battery: 81 %' },
        ] as any)
        const sent = bodies[0].messages
        expect(sent.some((m: any) => m.role === 'tool' && !m.tool_call_id)).toBe(false)
        expect(JSON.stringify(sent)).toContain('81 %')
    })
})
