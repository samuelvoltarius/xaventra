import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNovaLLMClient, toOpenAIImageParts } from './nova-llm-sdk.js'
import { LocalLLM, toOpenAIChatMessages } from './local-llm.js'

// Live 30.09.2026: the Spark vLLM reads images ("Links rot, rechts blau") but
// Nova never received a screenshot: local images went out as Ollama-style
// `images` (ignored by vLLM) or as Nova's internal `image` field.

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function imagePart(message: any) {
    return Array.isArray(message?.content) ? message.content.find((part: any) => part.type === 'image_url') : undefined
}

describe('local vision requests carry the image in the backend format', () => {
    it('NovaLLM local provider sends OpenAI image_url parts to vLLM', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        vi.stubEnv('NOVA_OS_MODE', 'false')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Rot.' } }] })))
        vi.stubGlobal('fetch', fetchMock)
        const client = await createNovaLLMClient({ provider: 'local', model: 'vision-probe-qwen', baseUrl: 'http://127.0.0.1:8000/v1' })
        await client.complete([
            { role: 'system', content: 'Du bist Nova.' },
            { role: 'user', content: 'Was siehst du?', image: { data: pixel, mimeType: 'image/png' } } as any,
        ])
        const chat = fetchMock.mock.calls.map(call => JSON.parse(String((call as any)[1]?.body || '{}'))).find(body => Array.isArray(body.messages))
        const user = chat.messages.find((message: any) => message.role === 'user')
        expect(imagePart(user)?.image_url.url).toBe(`data:image/png;base64,${pixel}`)
        expect(user.content[0]).toEqual({ type: 'text', text: 'Was siehst du?' })
        expect(user.images).toBeUndefined()
        expect(user.__images).toBeUndefined()
    })

    it('LocalLLM OpenAI path sends image_url parts, not the internal image field', async () => {
        const fetchMock = vi.fn(async (url: string) => String(url).endsWith('/v1/models')
            ? new Response(JSON.stringify({ data: [{ id: 'qwen' }] }))
            : new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { content: 'Rot.' } }] })))
        vi.stubGlobal('fetch', fetchMock)
        const llm = new LocalLLM({ baseUrl: 'http://127.0.0.1:8000', model: 'qwen', apiType: 'openai' } as any)
        await llm.complete([{ role: 'user', content: 'Was siehst du?', image: { data: pixel, mimeType: 'image/png' } } as any], [])
        const chat = fetchMock.mock.calls.map(call => JSON.parse(String((call as any)[1]?.body || '{}'))).find(body => Array.isArray(body.messages))
        const user = chat.messages.find((message: any) => message.role === 'user')
        expect(imagePart(user)?.image_url.url).toBe(`data:image/png;base64,${pixel}`)
        expect(user.image).toBeUndefined()
    })

    it('keeps text-only and tool messages unchanged and rejects odd mime types', () => {
        const plain = [{ role: 'user', content: 'hi' }, { role: 'tool', content: '{}', tool_call_id: 'c1' }]
        expect(toOpenAIChatMessages(plain)).toEqual(plain)
        expect(toOpenAIImageParts(plain)).toEqual(plain)
        const odd = toOpenAIChatMessages([{ role: 'user', content: 'x', image: { data: pixel, mimeType: 'text/html' } }])
        expect(imagePart(odd[0])?.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    })
})
