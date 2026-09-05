import { describe, expect, it } from 'vitest'
import { evaluateBenchmarkRegression } from './regression-gate.js'

const baseline = {
    scenarios: 100, taskCompletionRate: 1, correctToolExecutionRate: 1,
    resumeRate: 1, memoryPrecision: 1, averageDurationMs: 1000,
    totalCostUsd: 0.1, unnecessaryQuestions: 0, falseCompletions: 0,
}

describe('benchmark regression gate', () => {
    it('blocks material quality regression', () => {
        const result = evaluateBenchmarkRegression({ ...baseline, memoryPrecision: 0.9 }, baseline)
        expect(result.pass).toBe(false)
        expect(result.regressions[0]).toContain('memoryPrecision')
    })

    it('allows small timing noise', () => {
        expect(evaluateBenchmarkRegression({ ...baseline, averageDurationMs: 1100 }, baseline).pass).toBe(true)
    })
})
