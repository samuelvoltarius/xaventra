import { describe, expect, it } from 'vitest'
import { classifyLocalModelFailure } from './nova-llm-sdk.js'
import { toCleanChatMessages } from './local-llm.js'

// 2.88.2 (live 07.10.2026): vLLM answered one request with HTTP 400 "TextEncodeInput
// must be Union[…]" and Xaventra blacklisted her own local model for the session.
// A rejected request is not a broken model.

describe('a 400 from the local model is a request error, never a reason to block the model', () => {
    it('classifies 4xx request errors separately', () => {
        expect(classifyLocalModelFailure('LLM API error (400): {"error":{"message":"TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]","type":"BadRequestError"}}')).toBe('request-error')
        expect(classifyLocalModelFailure('LLM API error (422): validation failed')).toBe('request-error')
    })
    it('real crashes stay hard failures (Gegenprobe)', () => {
        expect(classifyLocalModelFailure('LLM API error (500): CUDA out of memory')).toBe('hard-failure')
    })
})

describe('messages sent to OpenAI-compatible servers are plain chat messages', () => {
    it('drops stored extra fields and turns non-text content into text', () => {
        const out = toCleanChatMessages([
            { role: 'user', content: 'Frage', timestamp: 1, runId: 'r' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
            { role: 'tool', content: { ok: true }, tool_call_id: 'c1' },
            { role: 'assistant', content: [{ type: 'text', text: 'Teil A' }, { type: 'text', text: 'Teil B' }] },
        ] as any)
        expect(out[0]).toEqual({ role: 'user', content: 'Frage' })
        expect(out[1]).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] })
        expect(out[2]).toEqual({ role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' })
        expect(out[3]).toEqual({ role: 'assistant', content: 'Teil A\nTeil B' })
    })
    it('keeps an attached image for the vision path (Gegenprobe)', () => {
        const out = toCleanChatMessages([{ role: 'user', content: 'Was siehst du?', image: { data: 'AAAA', mimeType: 'image/png' } }] as any)
        expect((out[0] as any).image).toEqual({ data: 'AAAA', mimeType: 'image/png' })
    })
})
