import { describe, expect, it, vi } from 'vitest'
import { InferenceBudget } from './inference-budget.js'

const reply = (input: number, output: number) => ({ content: 'ok', usage: {
    promptTokens: input, completionTokens: output, totalTokens: input + output,
} })
const budget = (extra = {}) => new InferenceBudget({ timeoutMs: 1000, maxToolCalls: 4, maxOutputTokens: 100, ...extra })

describe('per-run inference budget', () => {
    it('accumulates all visible calls and reduces the following generation allowance', async () => {
        const b = budget()
        const raw = { complete: vi.fn().mockResolvedValueOnce(reply(5333, 47)).mockResolvedValueOnce(reply(5600, 12)) }
        const client = b.wrap(raw)
        await client.complete([], [], { maxTokens: 500 })
        await client.complete([])
        expect(raw.complete.mock.calls.map(call => call[2].maxTokens)).toEqual([100, 53])
        expect(b.snapshot()).toMatchObject({ inputTokens: 10933, outputTokens: 59, totalTokens: 10992, calls: 2, estimated: false })
    })

    it('rejects another inference before contacting a provider once exhausted', async () => {
        const b = budget()
        const raw = { complete: vi.fn().mockResolvedValue(reply(10, 100)) }
        await b.wrap(raw).complete([])
        await expect(b.wrap(raw).complete([])).rejects.toThrow('before model call')
        expect(raw.complete).toHaveBeenCalledTimes(1)
        expect(() => b.assertCanExecute()).toThrow('no further tools')
    })

    it('keeps explicit total budgets including zero and prompt/schema reservation', async () => {
        for (const maxTokens of [0, 100]) {
            const b = budget({ maxTokens })
            const raw = { complete: vi.fn() }
            await expect(b.wrap(raw).complete([{ role: 'user', content: 'hello' }])).rejects.toThrow('before model call')
            expect(raw.complete).not.toHaveBeenCalled()
        }
    })

    it('never lets provider over-generation start a tool', async () => {
        const b = budget()
        await expect(b.wrap({ complete: async () => reply(30, 101) }).complete([])).rejects.toThrow('exceeded')
        expect(() => b.assertCanExecute()).toThrow()
        expect(b.snapshot()).toMatchObject({ outputTokens: 101, totalTokens: 131, estimated: false })
    })

    it('reserves missing usage instead of counting it as measured zero', async () => {
        const b = budget()
        await b.wrap({ complete: async () => ({ content: 'ok' }) }).complete([])
        expect(b.snapshot()).toMatchObject({ outputTokens: 100, estimated: true })
        expect(b.snapshot().inputTokens).toBeGreaterThan(0)
    })

    it('retains previous rounds and conservatively accounts for a failed call', async () => {
        const b = budget()
        const raw = { complete: vi.fn().mockResolvedValueOnce(reply(100, 10)).mockRejectedValueOnce(new Error('timeout')) }
        await b.wrap(raw).complete([])
        await expect(b.wrap(raw).complete([])).rejects.toThrow('timeout')
        expect(b.snapshot()).toMatchObject({ outputTokens: 100, estimated: true, stopped: true, calls: 2 })
        expect(b.snapshot().inputTokens).toBeGreaterThan(100)
    })

    it('reserves pending calls before outer timeout and prevents concurrent effects', async () => {
        const b = budget()
        let finish!: (value: any) => void
        const request = b.wrap({ complete: () => new Promise(resolve => { finish = resolve }) }).complete([])
        expect(b.snapshot()).toMatchObject({ outputTokens: 100, estimated: true, stopped: true })
        expect(() => b.assertCanExecute()).toThrow()
        finish(reply(10, 5)); await request
        expect(b.snapshot()).toMatchObject({ outputTokens: 5, estimated: false, stopped: false })
    })

    it('does not mutate a shared provider or mix principals; wrapping is idempotent', async () => {
        class Client {
            #name = 'private-model'
            get modelId() { return this.#name }
            async complete(_messages: any[]) { return reply(100, 10) }
        }
        const raw = new Client(), a = budget(), b = budget()
        const original = raw.complete
        const wrapped = a.wrap(raw)
        expect(a.wrap(wrapped)).toBe(wrapped)
        expect(wrapped.modelId).toBe('private-model')
        await wrapped.complete([])
        expect(b.snapshot().calls).toBe(0)
        expect(raw.complete).toBe(original)
    })
})
