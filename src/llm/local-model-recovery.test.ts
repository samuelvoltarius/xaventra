import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNovaLLMClient } from './nova-llm-sdk.js'
import { isModelDisabled, recordModelCall } from './model-perf-db.js'
import { availableLLMs } from '../core/llm-factory.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); availableLLMs.splice(0) })
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
const client = (model: string) => createNovaLLMClient({ provider: 'local', model, baseUrl: 'http://127.0.0.1:8000/v1' })
function disable(model: string) {
    vi.stubEnv('NOVA_OS_MODE', 'false')
    vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
    for (let i = 0; i < 5; i++) recordModelCall(model, 'chat', 1, false)
    expect(isModelDisabled(model)).toBe(true)
}
describe('local model recovery admission', () => {
    it('does not count textless tool calls as inference failures', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        vi.stubEnv('NOVA_OS_MODE', 'false')
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
            content: '', tool_calls: [{ function: { name: 'health_status', arguments: '{}' } }],
        } }] }))))
        const c = await client('tool-only-recovery')
        for (let i = 0; i < 6; i++) await c.complete([{ role: 'user', content: 'health' }])
        expect(isModelDisabled('tool-only-recovery')).toBe(false)
    })
    it('admits one actual inference when every model is cooling down and clears the hold on success', async () => {
        disable('held-recovery')
        const fetchMock = vi.fn(async () => reply())
        vi.stubGlobal('fetch', fetchMock)
        const response = await (await client('held-recovery')).complete([{ role: 'user', content: 'ping' }])
        expect(response.content).toBe('OK')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(isModelDisabled('held-recovery')).toBe(false)
    })
    it('does not admit a second concurrent recovery or retry storm after failure', async () => {
        disable('held-concurrent')
        let release!: () => void
        const fetchMock = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return new Response('unavailable', { status: 503 }) })
        vi.stubGlobal('fetch', fetchMock)
        const c = await client('held-concurrent')
        const first = c.complete([{ role: 'user', content: 'one' }]).catch(() => null)
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        await expect(c.complete([{ role: 'user', content: 'two' }])).rejects.toThrow()
        release(); await first
        await expect(c.complete([{ role: 'user', content: 'three' }])).rejects.toThrow()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    it('does not multiply recovery calls for duplicate mesh routes of the same model', async () => {
        disable('duplicate-recovery')
        availableLLMs.push({ model: 'duplicate-recovery', endpoint: 'http://worker.test:8001', local: true, provider: 'local' } as any)
        const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))
        vi.stubGlobal('fetch', fetchMock)
        const c = await client('duplicate-recovery')
        await expect(c.complete([{ role: 'user', content: 'one' }])).rejects.toThrow()
        await expect(c.complete([{ role: 'user', content: 'two' }])).rejects.toThrow()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    it('prefers a healthy fallback instead of overriding a hold', async () => {
        disable('held-with-fallback')
        availableLLMs.push({ model: 'healthy-fallback', endpoint: 'http://worker.test:8002', local: true, provider: 'local' } as any)
        const fetchMock = vi.fn(async () => reply())
        vi.stubGlobal('fetch', fetchMock)
        await (await client('held-with-fallback')).complete([{ role: 'user', content: 'ping' }])
        expect(fetchMock.mock.calls[0][0]).toBe('http://worker.test:8002/v1/chat/completions')
        expect(isModelDisabled('held-with-fallback')).toBe(true)
    })
    it('never probes a known permanent exclusion', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        await expect((await client('gemma4:26b')).complete([{ role: 'user', content: 'ping' }])).rejects.toThrow()
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it('allows another bounded attempt after the session hold expires', async () => {
        vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
        const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))
        vi.stubGlobal('fetch', fetchMock)
        const c = await client('session-recovery')
        for (let i = 0; i < 3; i++) await expect(c.complete([{ role: 'user', content: 'ping' }])).rejects.toThrow()
        await expect(c.complete([{ role: 'user', content: 'held' }])).rejects.toThrow()
        expect(fetchMock).toHaveBeenCalledTimes(3)
        const now = Date.now()
        vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
        fetchMock.mockImplementation(async () => reply())
        expect((await c.complete([{ role: 'user', content: 'recovered' }])).content).toBe('OK')
        expect(fetchMock).toHaveBeenCalledTimes(4)
    })
})
