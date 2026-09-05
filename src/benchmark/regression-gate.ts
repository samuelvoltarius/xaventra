import type { calculateBenchmarkMetrics } from './benchmark-lab.js'

type Metrics = ReturnType<typeof calculateBenchmarkMetrics>

export interface BenchmarkRegression {
    pass: boolean
    regressions: string[]
    improvements: string[]
}

export function evaluateBenchmarkRegression(current: Metrics, baseline: Metrics): BenchmarkRegression {
    const regressions: string[] = []
    const improvements: string[] = []
    const rateFields: Array<keyof Pick<Metrics, 'taskCompletionRate' | 'correctToolExecutionRate' | 'resumeRate' | 'memoryPrecision'>> = [
        'taskCompletionRate', 'correctToolExecutionRate', 'resumeRate', 'memoryPrecision',
    ]
    for (const field of rateFields) {
        const delta = current[field] - baseline[field]
        if (delta < -0.02) regressions.push(`${field} regressed by ${(Math.abs(delta) * 100).toFixed(1)} percentage points`)
        else if (delta > 0.02) improvements.push(`${field} improved by ${(delta * 100).toFixed(1)} percentage points`)
    }
    if (current.falseCompletions > baseline.falseCompletions) regressions.push('falseCompletions increased')
    if (current.unnecessaryQuestions > baseline.unnecessaryQuestions + 1) regressions.push('unnecessaryQuestions increased')
    if (current.averageDurationMs > baseline.averageDurationMs * 1.25) regressions.push('averageDurationMs increased by more than 25%')
    if (current.totalCostUsd > baseline.totalCostUsd * 1.25 && current.totalCostUsd - baseline.totalCostUsd > 0.01) regressions.push('totalCostUsd increased materially')
    return { pass: regressions.length === 0, regressions, improvements }
}
