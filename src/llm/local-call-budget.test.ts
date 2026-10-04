import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalLLM } from './local-llm.js'

afterEach(() => vi.unstubAllGlobals())
describe('background local completion budgets', () => {
    it.each(['qwen', 'other'])('disables thinking only for an explicitly non-reasoning Qwen call (%s)', async model => {
        const probe = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })))
        vi.stubGlobal('fetch', probe)
        await createLocalLLM({ baseUrl: 'http://127.0.0.1:8000', model }).complete([], [], { reasoningEffort: 'none' })
        const body = JSON.parse(String(probe.mock.calls[0][1].body))
        expect(body.chat_template_kwargs).toEqual(model === 'qwen' ? { enable_thinking: false } : undefined)
    })
    it.each(['http://127.0.0.1:8000', 'http://127.0.0.1:11434'])('forwards an output cap and owner stop to %s', async baseUrl => {
        let init: RequestInit
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            init = options
            return new Response(JSON.stringify(baseUrl.endsWith('11434') ? { message: { content: '{}' } } : { choices: [{ message: { content: '{}' } }] }))
        }))
        const controller = new AbortController()
        await createLocalLLM({ baseUrl, model: 'fixed', requestTimeoutMs: 45000 }).complete([{ role: 'user', content: 'classify' }], [], { maxTokens: 220, timeoutMs: 3000, signal: controller.signal })
        const body = JSON.parse(String(init.body))
        expect(baseUrl.endsWith('11434') ? body.options.num_predict : body.max_tokens).toBe(220)
        expect((init.signal as AbortSignal).aborted).toBe(false)
        controller.abort()
        expect((init.signal as AbortSignal).aborted).toBe(true)
    })
    it('does not issue any request after cancellation', async () => {
        const probe = vi.fn(); vi.stubGlobal('fetch', probe)
        const controller = new AbortController(); controller.abort()
        await expect(createLocalLLM({ baseUrl: 'http://127.0.0.1:8000', model: 'fixed' }).complete([], [], { signal: controller.signal })).rejects.toThrow()
        expect(probe).not.toHaveBeenCalled()
    })
    it('does not start discovery/retry when the background attempt budget is one', async () => {
        const probe = vi.fn(async () => new Response('model fixed not found', { status: 404 })); vi.stubGlobal('fetch', probe)
        await expect(createLocalLLM({ baseUrl: 'http://127.0.0.1:8000', model: 'fixed' }).complete([], [], { maxAttempts: 1 })).rejects.toThrow('404')
        expect(probe).toHaveBeenCalledTimes(1)
    })
    it('actually aborts a stalled request at the per-call deadline', async () => {
        vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })))
        const started = Date.now()
        await expect(createLocalLLM({ baseUrl: 'http://127.0.0.1:8000', model: 'fixed', requestTimeoutMs: 45000 }).complete([], [], { timeoutMs: 30 })).rejects.toThrow()
        expect(Date.now() - started).toBeLessThan(1000)
    })
})
