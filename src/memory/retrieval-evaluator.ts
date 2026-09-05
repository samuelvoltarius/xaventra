import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MemoryGovernanceCoordinator } from './memory-governance.js'
import { getMemoryGovernanceCoordinator } from './memory-governance.js'

export interface MemoryEvalCase {
    id: string
    scope: string
    query: string
    expectedIds: string[]
    forbiddenIds?: string[]
    topK?: number
}

export interface MemoryEvalResult {
    id: string
    retrievedIds: string[]
    expectedFound: string[]
    forbiddenFound: string[]
    reciprocalRank: number
    passed: boolean
}

export interface MemoryEvalReport {
    createdAt: string
    cases: number
    recallAtK: number
    precisionAtK: number
    meanReciprocalRank: number
    scopeLeakageRate: number
    passed: boolean
    results: MemoryEvalResult[]
}

export class MemoryRetrievalEvaluator {
    constructor(private readonly governance: MemoryGovernanceCoordinator = getMemoryGovernanceCoordinator()) {}

    run(cases: MemoryEvalCase[], outputFile?: string): MemoryEvalReport {
        let expectedTotal = 0
        let expectedFound = 0
        let retrievedTotal = 0
        let relevantRetrieved = 0
        let forbiddenFound = 0
        let forbiddenTotal = 0
        const results = cases.map(test => {
            const records = this.governance.recall(test.scope, test.query, test.topK || 8)
            const ids = records.map(record => record.id)
            const found = test.expectedIds.filter(id => ids.includes(id))
            const forbidden = (test.forbiddenIds || []).filter(id => ids.includes(id))
            const firstRank = ids.map((id, index) => test.expectedIds.includes(id) ? index + 1 : 0).find(Boolean) || 0
            expectedTotal += test.expectedIds.length
            expectedFound += found.length
            retrievedTotal += ids.length
            relevantRetrieved += ids.filter(id => test.expectedIds.includes(id)).length
            forbiddenFound += forbidden.length
            forbiddenTotal += (test.forbiddenIds || []).length
            return {
                id: test.id,
                retrievedIds: ids,
                expectedFound: found,
                forbiddenFound: forbidden,
                reciprocalRank: firstRank ? 1 / firstRank : 0,
                passed: found.length === test.expectedIds.length && forbidden.length === 0,
            }
        })
        const report: MemoryEvalReport = {
            createdAt: new Date().toISOString(),
            cases: cases.length,
            recallAtK: expectedFound / Math.max(1, expectedTotal),
            precisionAtK: relevantRetrieved / Math.max(1, retrievedTotal),
            meanReciprocalRank: results.reduce((sum, result) => sum + result.reciprocalRank, 0) / Math.max(1, results.length),
            scopeLeakageRate: forbiddenFound / Math.max(1, forbiddenTotal),
            passed: results.length > 0 && results.every(result => result.passed),
            results,
        }
        if (outputFile) {
            if (!existsSync(dirname(outputFile))) mkdirSync(dirname(outputFile), { recursive: true })
            writeFileSync(outputFile, JSON.stringify(report, null, 2))
        }
        return report
    }
}

export function defaultMemoryEvalReportPath(): string {
    return join(process.cwd(), '.nova-data', 'memory-evals', `${Date.now()}.json`)
}
