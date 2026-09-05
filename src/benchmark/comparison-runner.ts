import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calculateBenchmarkMetrics, getBenchmarkScenarios, type BenchmarkObservation, type BenchmarkScenario } from './benchmark-lab.js'

export interface BenchmarkCompetitor {
    name: string
    version?: string
    execute(scenario: BenchmarkScenario): Promise<BenchmarkObservation>
}

export interface BenchmarkComparisonEntry {
    agent: string
    version?: string
    metrics: ReturnType<typeof calculateBenchmarkMetrics>
    results: BenchmarkObservation[]
}

export interface BenchmarkComparisonReport {
    version: 1
    createdAt: string
    contractHash: string
    scenarios: number
    ranking: string[]
    agents: BenchmarkComparisonEntry[]
}

function stableContractHash(scenarios: BenchmarkScenario[]): string {
    // Deliberately dependency-free and deterministic. This is an identity for
    // the exact scenario contract, not a security signature.
    let hash = 2166136261
    for (const char of JSON.stringify(scenarios)) {
        hash ^= char.charCodeAt(0)
        hash = Math.imul(hash, 16777619)
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function rankScore(metrics: ReturnType<typeof calculateBenchmarkMetrics>): number {
    return metrics.taskCompletionRate * 50
        + metrics.correctToolExecutionRate * 20
        + metrics.resumeRate * 10
        + metrics.memoryPrecision * 10
        - metrics.falseCompletions * 10
        - metrics.unnecessaryQuestions * 0.5
        - Math.min(10, metrics.totalCostUsd)
}

export async function runBenchmarkComparison(
    competitors: BenchmarkCompetitor[],
    scenarios = getBenchmarkScenarios(),
    outputDir = join(process.cwd(), '.nova-data', 'benchmarks', 'comparisons'),
): Promise<BenchmarkComparisonReport> {
    if (competitors.length === 0) throw new Error('at least one benchmark competitor is required')
    const agents: BenchmarkComparisonEntry[] = []
    for (const competitor of competitors) {
        const results: BenchmarkObservation[] = []
        for (const scenario of scenarios) results.push(await competitor.execute(scenario))
        agents.push({ agent: competitor.name, version: competitor.version, metrics: calculateBenchmarkMetrics(results), results })
    }
    const ranking = [...agents]
        .sort((a, b) => rankScore(b.metrics) - rankScore(a.metrics))
        .map(entry => entry.agent)
    const report: BenchmarkComparisonReport = {
        version: 1,
        createdAt: new Date().toISOString(),
        contractHash: stableContractHash(scenarios),
        scenarios: scenarios.length,
        ranking,
        agents,
    }
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, `${Date.now()}.json`), JSON.stringify(report, null, 2))
    return report
}
