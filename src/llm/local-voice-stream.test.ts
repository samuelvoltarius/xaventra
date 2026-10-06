import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNovaLLMClient } from './nova-llm-sdk.js'
import { readOpenAiCompletionStream } from './sse-completion.js'
import { runWithVoiceTurn, speakableClient, type VoiceTurnSink } from '../voice/voice-turn-stream.js'

// 2.87 Paket P: Sprach-Züge streamen die sichtbare Antwort wortweise, ohne
// globale Änderung. Keine Netzaufrufe: fetch ist ein Fake.

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

function sse(events: unknown[]): Response {
    const encoder = new TextEncoder()
    const lines = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            // absichtlich mitten in Zeilen geteilt
            const all = lines.join('')
            for (let i = 0; i < all.length; i += 7) controller.enqueue(encoder.encode(all.slice(i, i + 7)))
            controller.close()
        },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

const delta = (content: string) => ({ choices: [{ delta: { content } }] })

function recorder() {
    const deltas: string[] = []
    const tools: string[][] = []
    const sink: VoiceTurnSink = { onTextDelta: text => { deltas.push(text) }, onToolRound: names => { tools.push(names) } }
    return { sink, deltas, tools }
}

describe('readOpenAiCompletionStream', () => {
    it('setzt Text, Werkzeugaufrufe und Nutzung wie eine normale Antwort zusammen', async () => {
        const { sink, deltas, tools } = recorder()
        const result = await readOpenAiCompletionStream(sse([
            delta('<think>geheim</think>Hallo '), delta('Alfred.'),
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'uhrzeit', arguments: '{"z' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'one":"Wien"}' } }] }, finish_reason: 'tool_calls' }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
            '[DONE]',
        ]).body!, sink)
        expect(deltas.join('')).toBe('Hallo Alfred.')
        expect(result.content).toBe('Hallo Alfred.')
        expect(result.toolCalls).toEqual([{ id: 'c1', name: 'uhrzeit', arguments: { zone: 'Wien' } }])
        expect(result.finishReason).toBe('tool_calls')
        expect(tools).toEqual([['uhrzeit']])
        expect(result.usage?.totalTokens).toBe(8)
    })

    it('gibt Denkspur nie weiter, auch wenn das Schluss-Tag über Stücke geteilt ist', async () => {
        const { sink, deltas } = recorder()
        const result = await readOpenAiCompletionStream(sse([delta('<thi'), delta('nk>a b c</th'), delta('ink>Antwort'), '[DONE]']).body!, sink)
        expect(deltas.join('')).toBe('Antwort')
        expect(result.content).toBe('Antwort')
    })
})

describe('LocalLLMProvider im Sprach-Zug', () => {
    it('streamt nur in sprechbaren Runden und schaltet dort request-lokal das Denken ab', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        const fetchMock = vi.fn(async (_url: string, init: any) => JSON.parse(String(init.body)).stream
            ? sse([delta('Es ist '), delta('zehn Uhr.'), '[DONE]'])
            : new Response(JSON.stringify({ choices: [{ message: { content: 'Es ist zehn Uhr.' } }] }), { headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const client = await createNovaLLMClient({ provider: 'local', model: 'qwen', baseUrl: 'http://127.0.0.1:8000/v1', isolated: true })
        const { sink, deltas } = recorder()

        const spoken = await runWithVoiceTurn(sink, () => speakableClient(client).complete([{ role: 'user', content: 'wie spät' }], []))
        expect(spoken.content).toBe('Es ist zehn Uhr.')
        expect(deltas.join('')).toBe('Es ist zehn Uhr.')
        const streamed = JSON.parse(String(fetchMock.mock.calls[0][1].body))
        expect(streamed.stream).toBe(true)
        expect(streamed.chat_template_kwargs).toEqual({ enable_thinking: false })
        expect(streamed.reasoning_effort).toBe('none')

        // Im selben Sprach-Zug, aber nicht sprechbar (z. B. Prüfaufruf): unverändert, kein Stück.
        const before = deltas.length
        await runWithVoiceTurn(sink, () => client.complete([{ role: 'user', content: 'prüfe' }], [], { reasoningEffort: 'high' }))
        const plain = JSON.parse(String(fetchMock.mock.calls[1][1].body))
        expect(plain.stream).toBeUndefined()
        expect(plain.chat_template_kwargs).toBeUndefined()
        expect(deltas.length).toBe(before)

        // Ohne Sprach-Zug ändert speakableClient nichts.
        await speakableClient(client).complete([{ role: 'user', content: 'text' }], [], { reasoningEffort: 'high' })
        expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).stream).toBeUndefined()
    })
})
