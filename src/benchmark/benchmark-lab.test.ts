import { describe, expect, it } from 'vitest'
import { calculateBenchmarkMetrics, getBenchmarkScenarios } from './benchmark-lab.js'

describe('Nova Benchmark Lab', () => {
    it('contains 100 non-destructive real-world scenarios across all priorities', () => {
        const scenarios = getBenchmarkScenarios()
        expect(scenarios).toHaveLength(100)
        expect(new Set(scenarios.map(item => item.category)).size).toBe(10)
        expect(scenarios.every(item => item.destructive === false && item.requiredEvidence.length > 0)).toBe(true)
    })

    it('reports false completions separately from completion rate', () => {
        const metrics = calculateBenchmarkMetrics([{ scenarioId: 'x', success: true, toolExecuted: false, durationMs: 10, falseCompletion: true }])
        expect(metrics.taskCompletionRate).toBe(1)
        expect(metrics.correctToolExecutionRate).toBe(0)
        expect(metrics.falseCompletions).toBe(1)
    })
})
