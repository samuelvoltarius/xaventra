import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalLLM, selectLocalChatModel } from './local-llm.js'

describe('LocalLLM tool calling', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('passes tools to Ollama and returns normalized tool calls', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            model: 'qwen3.5:27b',
            message: {
                content: '',
                tool_calls: [{ function: { name: 'health_status', arguments: { verbose: true } } }],
            },
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const llm = new LocalLLM({ baseUrl: 'http://localhost:11434', model: 'qwen3.5:27b' })

        const result = await llm.complete(
            [{ role: 'user', content: 'Prüfe den Status' }],
            [{ name: 'health_status', description: 'Status prüfen', parameters: { type: 'object', properties: {} } }],
        )

        const body = JSON.parse(fetchMock.mock.calls[0][1].body)
        expect(body.tools[0].function.name).toBe('health_status')
        expect(result.toolCalls).toEqual([
            expect.objectContaining({ name: 'health_status', arguments: { verbose: true } }),
        ])
    })

    it('selects a live chat model and ignores embedding models', () => {
        expect(selectLocalChatModel(
            ['nomic-embed-text', 'qwen', 'sakamakismile/Ornith-1.0-35B-NVFP4'],
            'missing-model',
        )).toBe('qwen')
    })

    it('discovers a model before sending an auto completion', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: [{ id: 'qwen' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                model: 'qwen',
                choices: [{ message: { content: 'bereit' }, finish_reason: 'stop' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const llm = new LocalLLM({ baseUrl: 'http://localhost:8000', model: 'auto' })

        const result = await llm.complete([{ role: 'user', content: 'Antworte kurz' }])

        const request = JSON.parse(fetchMock.mock.calls[2][1].body)
        expect(request.model).toBe('qwen')
        expect(result.content).toBe('bereit')
        expect(llm.getModel()).toBe('qwen')
    })

    it('recovers once when vLLM no longer serves the configured model', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                error: { message: 'The model `old-model` does not exist.' },
            }), { status: 404, headers: { 'content-type': 'application/json' } }))
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: [{ id: 'qwen' }, { id: 'nomic-embed-text' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                model: 'qwen',
                choices: [{ message: { content: 'fallback-ok' }, finish_reason: 'stop' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        const llm = new LocalLLM({ baseUrl: 'http://localhost:8000', model: 'old-model' })

        const result = await llm.complete([{ role: 'user', content: 'Test' }])

        expect(result.content).toBe('fallback-ok')
        expect(llm.getModel()).toBe('qwen')
        expect(fetchMock).toHaveBeenCalledTimes(4)
    })
})
