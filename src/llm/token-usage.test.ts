import { expect, it } from 'vitest'
import { normalizeTokenUsage } from './token-usage.js'

it('preserves valid local OpenAI and Ollama token counts', () => {
    expect(normalizeTokenUsage(100, 10, 110)).toEqual({ promptTokens: 100, completionTokens: 10, totalTokens: 110 })
    expect(normalizeTokenUsage(20, 4)).toEqual({ promptTokens: 20, completionTokens: 4, totalTokens: 24 })
    expect(normalizeTokenUsage(100, 10, 1).totalTokens).toBe(110)
    expect(normalizeTokenUsage(0, 0).totalTokens).toBe(0)
})
it.each([[undefined, undefined], [NaN, 1], [-1, 20], [5, Infinity], ['20', 2], [0.5, 1], [Number.MAX_SAFE_INTEGER, 1]])(
    'does not turn malformed/absent usage (%s, %s) into measured zero', (prompt, completion) => {
        expect(normalizeTokenUsage(prompt, completion)).toBeUndefined()
    })
