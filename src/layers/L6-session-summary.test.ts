import { beforeEach, describe, expect, it, vi } from 'vitest'

const complete = vi.hoisted(() => vi.fn())

vi.mock('../llm/nova-llm-sdk.js', () => ({
    createNovaLLMClient: async () => ({ complete }),
}))

import { buildForegroundSummary, processSessionForLLM, summarizeMessages } from './L6-session-summary.js'

describe('L6 session summary latency contract', () => {
    beforeEach(() => {
        complete.mockReset()
        complete.mockResolvedValue({ content: 'Eine ausreichend lange und sichere technische Zusammenfassung.' })
    })

    it('uses one bounded background model attempt', async () => {
        await summarizeMessages([{ role: 'user', content: 'Bitte merke dir die technische Entscheidung.' }])

        expect(complete).toHaveBeenCalledOnce()
        expect(complete.mock.calls[0][2]).toEqual({
            maxTokens: 512,
            timeoutMs: 8_000,
            maxAttempts: 1,
        })
    })

    it('builds the foreground memory view without invoking a model', () => {
        const summary = buildForegroundSummary([
            { role: 'user', content: 'Wichtig: Spark ist der Main.' },
            { role: 'assistant', content: 'Die Entscheidung wurde bestätigt.' },
        ], 'Bestehender Kontext')

        expect(summary).toContain('Bestehender Kontext')
        expect(summary).toContain('Spark ist der Main')
        expect(complete).not.toHaveBeenCalled()
    })

    it('never blocks the foreground session path on summary inference', async () => {
        const history = Array.from({ length: 24 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: index === 0 ? 'Wichtig: Spark ist der Main.' : `Nachricht ${index} mit genügend Kontext.`,
            timestamp: index,
        }))

        const result = await processSessionForLLM(`latency-test-${Date.now()}`, 'test', history, 12_000, false)

        expect(result.summaryMessage?.content).toContain('Spark ist der Main')
        expect(result.hotMessages).toHaveLength(14)
        expect(result.summarized).toBe(false)
        expect(complete).not.toHaveBeenCalled()
    })
})
