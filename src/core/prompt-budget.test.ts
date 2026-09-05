import { describe, expect, it } from 'vitest'
import { applySystemPromptBudget } from './prompt-budget.js'

describe('system prompt budget', () => {
    it('preserves beginning and critical tail within the hard maximum', () => {
        const input = `IDENTITY-${'a'.repeat(8_000)}-CRITICAL-RULE`
        const result = applySystemPromptBudget(input, 1_000)
        expect(result.truncated).toBe(true)
        expect(result.prompt.length).toBeLessThanOrEqual(1_000)
        expect(result.prompt.startsWith('IDENTITY-')).toBe(true)
        expect(result.prompt.endsWith('-CRITICAL-RULE')).toBe(true)
    })
})

