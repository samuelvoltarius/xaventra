/**
 * Compatibility facade. The canonical decision authority lives in
 * context-policy.ts so context loading, planning and execution cannot drift.
 */
import { selectContextPolicy } from './context-policy.js'

export type TaskComplexity = 'trivial' | 'simple' | 'medium' | 'complex'

export interface ComplexityResult {
    level: TaskComplexity
    score: number
    skipLayers: string[]
    reason: string
}

export function classifyComplexity(input: string): ComplexityResult {
    const policy = selectContextPolicy(input)
    const level: TaskComplexity = policy.cognitiveMode === 'fast'
        ? (policy.taskClass === 'conversation' ? 'trivial' : 'simple')
        : policy.cognitiveMode === 'balanced' ? 'medium' : 'complex'
    const score = level === 'trivial' ? 10 : level === 'simple' ? 30 : level === 'medium' ? 60 : 90
    const skipLayers = level === 'trivial'
        ? ['planner', 'reflection', 'proactive', 'rag', 'ast', 'swarm']
        : level === 'simple'
            ? ['planner', 'proactive', 'swarm']
            : level === 'medium' ? ['proactive', 'swarm'] : []
    return { level, score, skipLayers, reason: policy.reasons.join(', ') }
}

export function shouldSkipLayer(complexity: ComplexityResult, layerName: string): boolean {
    return complexity.skipLayers.includes(layerName.toLowerCase())
}

export function getComplexitySummary(result: ComplexityResult): string {
    const emoji = { trivial: '⚡', simple: '🟢', medium: '🟡', complex: '🔴' }
    return `${emoji[result.level]} ${result.level.toUpperCase()} (${result.score}/100): ${result.reason}`
}

export default { classifyComplexity, shouldSkipLayer, getComplexitySummary }
