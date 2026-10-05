import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNovaLLMClient } from './nova-llm-sdk.js'
import { cancellableCompletion } from './cancellable-completion.js'
import { runWithModelFallback } from './model-fallback.js'

afterEach(() => vi.unstubAllEnvs())
describe('request-wide model cancellation', () => {
    it('closes a real stalled local HTTP request and never attempts another model', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        let requests = 0
        let observed!: () => void
        const received = new Promise<void>(resolve => { observed = resolve })
        let closed = false
        const server = createServer((_request, response) => {
            requests++; observed()
            response.on('close', () => { closed = true })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try {
            const port = (server.address() as any).port
            const client = await createNovaLLMClient({ provider: 'local', model: 'qwen', baseUrl: `http://127.0.0.1:${port}/v1`, isolated: true })
            const controller = new AbortController()
            const pending = client.complete([{ role: 'user', content: 'fixture' }], [], { signal: controller.signal })
            // Attach rejection handling before firing cancellation.
            const rejected = expect(pending).rejects.toThrow('fixture cancellation')
            await received
            controller.abort(new Error('fixture cancellation'))
            await rejected
            await vi.waitFor(() => expect(closed).toBe(true))
            expect(requests).toBe(1)
        } finally {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })
    it('does not fail over a timeout belonging to the aborted whole request', async () => {
        const controller = new AbortController()
        const run = vi.fn(async () => {
            controller.abort(new Error('Timeout: whole request'))
            throw new Error('Timeout: provider')
        })
        await expect(runWithModelFallback({ provider: 'local', model: 'a', fallbacks: [{ provider: 'local', model: 'b' }], signal: controller.signal, run })).rejects.toThrow('whole request')
        expect(run).toHaveBeenCalledTimes(1)
    })
    it('aborts cooperative clients and rejects non-cooperative late results', async () => {
        let signal: AbortSignal | undefined
        const complete = vi.fn((_messages, _tools, options) => {
            signal = options.signal
            return new Promise<any>(() => {})
        })
        const wrapped = cancellableCompletion({ complete }, undefined, 20)
        await expect(wrapped.complete([])).rejects.toThrow('deadline')
        await expect(wrapped.complete([])).rejects.toThrow('deadline')
        expect(signal?.aborted).toBe(true)
        expect(complete).toHaveBeenCalledTimes(1)
    })
})
