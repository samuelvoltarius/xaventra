import { describe, expect, it, vi } from 'vitest'

const corrections = [1, 2].map(i => ({
    id: `r2-l11-c${i}`, userId: 'r2-l11-user', originalResponse: 'alt',
    correctedResponse: 'Antworte immer kurz und auf Deutsch bitte', context: 'wetter morgen salzburg',
    timestamp: i, applied: false,
}))
vi.mock('./L7-learning.js', () => ({ getCorrectionLearner: () => ({ getRecentCorrections: () => corrections }) }))

const { default: selfImprovement } = await import('./L20-self-improvement.js')

describe('L20 self-improvement confidence (R2 L11)', () => {
    it('counts each correction once instead of re-boosting on every analysis run', async () => {
        const engine = new selfImprovement.SelfImprovementEngine()
        await engine.analyzeCorrections()
        const rule = () => engine.getRules().find(r => r.userId === 'r2-l11-user')
        const initial = rule()?.confidence
        expect(initial).toBeDefined()
        for (let i = 0; i < 5; i++) await engine.analyzeCorrections()
        expect(rule()?.confidence).toBe(initial)
    })

})
