/**
 * 2.89.14 (Abnahme 2.89.13, 29.10.2026 task D): 03:23:49 "MiniMax MiniMax-M3.1-Flash failed: TimeoutError",
 * then "[ModelFallback] Trying fallback: local/auto" although providers.local.enabled = false (B5: no local
 * LLM on the Main), and the turn hung until "Timeout: model request exceeded deadline" at 03:25:34. With the
 * local provider switched off, a failed MiniMax call ends at once (or goes to a configured cloud fallback).
 * Real createLLM wrapper; only the network is simulated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
const savedEnv = process.env.MINIMAX_API_KEY
afterEach(async () => {
    await h?.close(); h = undefined
    if (savedEnv === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = savedEnv
    vi.restoreAllMocks()
})
const FAKE_KEY = 'fake-minimax-key-' + 'q'.repeat(24)
const LOCAL = 'http://192.0.2.10:8000/v1'

describe('2.89.14 no local fallback when the local provider is switched off', () => {
    it('a MiniMax timeout fails fast instead of trying local/auto', async () => {
        process.env.MINIMAX_API_KEY = FAKE_KEY
        const config = { provider: 'minimax', model: 'MiniMax-M3.1-Flash', providers: { local: { baseUrl: LOCAL, enabled: false }, minimax: { baseUrl: 'https://api.minimax.io/v1', enabled: true } }, fallbackModels: [] }
        h = await createE2EHarness({ config })
        const local: string[] = []
        const harnessFetch = globalThis.fetch
        globalThis.fetch = (async (input: any, init?: any) => {
            const url = typeof input === 'string' ? input : String(input?.url || input)
            if (url.startsWith('https://api.minimax.io')) {
                if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'MiniMax-M3.1-Flash' }] }), { status: 200 })
                throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
            }
            if (url.startsWith('http://192.0.2.10') || url.includes('localhost') || url.includes('127.0.0.1')) local.push(url)
            return harnessFetch(input, init)
        }) as typeof fetch
        const factory = await h.module('core/llm-factory.js')
        factory.availableLLMs.length = 0
        ;(await h.module('llm/nova-llm-sdk.js')).resetServerHealthForTests()
        const llm = await factory.createLLM(structuredClone(config))
        const logs: string[] = []
        const original = console.log
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); original(...args) })

        local.length = 0 // createLLM's start-up probes are not the fallback
        const started = Date.now()
        await expect(llm.complete([{ role: 'user', content: 'Hallo' }], [])).rejects.toThrow()
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(logs.some(line => /Trying fallback: local/.test(line))).toBe(false)
        expect(local).toEqual([])
    }, 60_000)
})
