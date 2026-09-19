import { describe, expect, it } from 'vitest'
import { isReasoningOnlyResponse, reasoningEffortForTurn, recoverReasoningOnlyResponse } from './reasoning-policy.js'

describe('reasoning policy', () => {
    it('disables reasoning for fast chat and every tool-bearing turn', () => {
        expect(reasoningEffortForTurn({ reasoningEffort: 'minimal' }, false)).toBe('none')
        expect(reasoningEffortForTurn({ reasoningEffort: 'high' }, true)).toBe('none')
    })

    it('preserves bounded effort for complex text-only work', () => {
        expect(reasoningEffortForTurn({ reasoningEffort: 'low' }, false)).toBe('low')
        expect(reasoningEffortForTurn({ reasoningEffort: 'medium' }, false)).toBe('medium')
        expect(reasoningEffortForTurn({ reasoningEffort: 'high' }, false)).toBe('high')
    })

    it('classifies hidden reasoning without visible text but never hides a tool call', () => {
        expect(isReasoningOnlyResponse({ content: '', reasoning: 'private work', finishReason: 'length' })).toBe(true)
        expect(isReasoningOnlyResponse({ content: '', reasoning: 'private work', toolCalls: [{ id: '1', name: 'read_file', arguments: {} }] })).toBe(false)
        expect(isReasoningOnlyResponse({ content: '', finishReason: 'stop' })).toBe(false)
        expect(isReasoningOnlyResponse({ content: 'visible', reasoning: 'private work' })).toBe(false)
    })

    it('retries reasoning-only output once through the supplied budgeted boundary', async () => {
        const retry = async () => ({ content: 'visible', finishReason: 'stop' as const })
        const recovered = await recoverReasoningOnlyResponse(
            { content: '', reasoning: 'private work', finishReason: 'length' as const },
            'medium',
            retry,
        )
        expect(recovered).toEqual({ response: { content: 'visible', finishReason: 'stop' }, recovered: true })

        let calls = 0
        const alreadyFast = await recoverReasoningOnlyResponse(
            { content: '', reasoning: 'ignored by provider', finishReason: 'length' as const },
            'none',
            async () => { calls++; return { content: 'unexpected' } },
        )
        expect(alreadyFast.recovered).toBe(false)
        expect(calls).toBe(0)
    })
})
