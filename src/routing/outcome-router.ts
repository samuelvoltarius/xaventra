import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAllModelStats, getModelScoreAdjustment } from '../llm/model-perf-db.js'
import { getOutcomeLedger, type OutcomeLedger } from '../core/outcome-ledger.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'

export interface RouteCandidate { model: string; node?: string; toolset?: string[]; baseScore?: number; estimatedCostUsd?: number }
export interface ShadowRouteDecision {
    mode: 'shadow' | 'active'
    selected: RouteCandidate
    recommended: RouteCandidate
    confidence: number
    changed: boolean
    activationEligible: boolean
    reasons: string[]
    evaluatedAt: string
}

export interface OutcomeTrainingCell {
    taskType: string
    model: string
    node?: string
    samples: number
    successes: number
    successRate: number
    averageDurationMs: number
    averageCostUsd: number
    activationEligible: boolean
}

export interface OutcomeTrainingStatus {
    mode: 'shadow' | 'active'
    minimumSamples: number
    minimumSuccesses: number
    minimumSuccessRate: number
    activeTaskTypes: string[]
    canaryPercent: number
    cells: OutcomeTrainingCell[]
    evaluatedAt: string
}

function stablePercentage(value: string): number {
    let hash = 2166136261
    for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) }
    return (hash >>> 0) % 100
}

export class OutcomeRouter {
    constructor(
        private readonly ledger: OutcomeLedger = getOutcomeLedger(),
        private readonly decisionFile = join(process.cwd(), '.nova-data', 'outcome-router-shadow.jsonl'),
        private readonly mode: 'shadow' | 'active' = process.env.NOVA_OUTCOME_ROUTER_MODE === 'active' ? 'active' : 'shadow',
    ) {}

    getTrainingStatus(): OutcomeTrainingStatus {
        const minimumSamples = Math.max(10, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SAMPLES || 20))
        const minimumSuccesses = Math.max(5, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESSES || 15))
        const minimumSuccessRate = Math.max(0.5, Math.min(1, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESS_RATE || 0.75)))
        const activeTaskTypes = (process.env.NOVA_OUTCOME_ROUTER_ACTIVE_TASKS || '').split(',').map(item => item.trim()).filter(Boolean)
        const canaryPercent = Math.max(0, Math.min(100, Number(process.env.NOVA_OUTCOME_ROUTER_CANARY_PERCENT || 100)))
        const groups = new Map<string, { taskType: string; model: string; node?: string; runs: ReturnType<OutcomeLedger['listRuns']> }>()
        for (const run of this.ledger.listRuns(5_000)) {
            if ((run.status !== 'completed' && run.status !== 'failed') || typeof run.validation?.success !== 'boolean') continue
            if (run.channel === 'benchmark' || String(run.userId || '').startsWith('benchmark:')) continue
            const route = [...run.events].reverse().find(event => event.type === 'route.selected')
            const taskType = String(route?.payload?.taskType || '')
            if (!taskType || !run.model) continue
            const key = `${taskType}\u0000${run.model}\u0000${run.node || ''}`
            const group = groups.get(key) || { taskType, model: run.model, node: run.node, runs: [] }
            group.runs.push(run)
            groups.set(key, group)
        }
        const cells = [...groups.values()].map(group => {
            const successes = group.runs.filter(run => run.status === 'completed' && run.validation?.success === true).length
            const samples = group.runs.length
            const successRate = samples ? successes / samples : 0
            return {
                taskType: group.taskType, model: group.model, node: group.node, samples, successes, successRate,
                averageDurationMs: samples ? group.runs.reduce((sum, run) => sum + Number(run.finalOutcome?.durationMs || 0), 0) / samples : 0,
                averageCostUsd: samples ? group.runs.reduce((sum, run) => sum + run.totalCostUsd, 0) / samples : 0,
                activationEligible: samples >= minimumSamples && successes >= minimumSuccesses && successRate >= minimumSuccessRate,
            }
        }).sort((a, b) => b.samples - a.samples || b.successRate - a.successRate)
        return { mode: this.mode, minimumSamples, minimumSuccesses, minimumSuccessRate, activeTaskTypes, canaryPercent, cells, evaluatedAt: new Date().toISOString() }
    }

    decide(taskType: string, baseline: RouteCandidate, candidates: RouteCandidate[]): ShadowRouteDecision {
        const all = candidates.some(item => item.model === baseline.model && item.node === baseline.node) ? candidates : [baseline, ...candidates]
        const stats = new Map(getAllModelStats().map(item => [item.model, item]))
        const graph = getCapabilityGraph().getSnapshot()
        const terminal = this.ledger.listRuns(500).filter(run =>
            (run.status === 'completed' || run.status === 'failed')
            // Synthetic benchmark fixtures prove capabilities but must never
            // teach the production model router which route to activate.
            && run.channel !== 'benchmark'
            && !String(run.userId || '').startsWith('benchmark:'))
        const scored = all.map(candidate => {
            const perf = stats.get(candidate.model)
            const ledgerMatches = terminal.filter(run =>
                run.model === candidate.model
                && (!candidate.node || run.node === candidate.node)
                && run.events.some(event => event.type === 'route.selected' && event.payload.taskType === taskType))
            // Only externally validated outcomes may train or activate routing.
            // A model response or a terminal status alone is not evidence.
            const validatedMatches = ledgerMatches.filter(run => typeof run.validation?.success === 'boolean')
            const successes = validatedMatches.filter(run => run.status === 'completed' && run.validation?.success === true).length
            const rawSuccessRate = validatedMatches.length ? successes / validatedMatches.length : 0
            const successRate = (successes + 1) / (validatedMatches.length + 2) // Bayesian score avoids early overfitting
            const ratings = validatedMatches.flatMap(run => run.feedback.map(item => Number(item.rating)).filter(Number.isFinite))
            const feedbackScore = ratings.length ? ((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) - 3) * 5 : 0
            const averageCost = validatedMatches.length ? validatedMatches.reduce((sum, run) => sum + run.totalCostUsd, 0) / validatedMatches.length : Number(candidate.estimatedCostUsd || 0)
            const averageDuration = validatedMatches.length
                ? validatedMatches.reduce((sum, run) => sum + Number(run.finalOutcome?.durationMs || 0), 0) / validatedMatches.length
                : Number(perf?.avgLatencyMs || 0)
            const runtimeSamples = graph.nodes
                .filter(node => !candidate.node || node.id === candidate.node || node.hostname === candidate.node)
                .flatMap(node => node.runtimes)
                .filter(runtime => runtime.models.includes(candidate.model))
                .flatMap(runtime => Object.values((runtime.metadata?.performance || {}) as Record<string, { tokensPerSecond?: number }>))
            const tokensPerSecond = Math.max(0, ...runtimeSamples.map(sample => Number(sample.tokensPerSecond || 0)))
            const outcomeSamples = graph.nodes
                .filter(node => !candidate.node || node.id === candidate.node || node.hostname === candidate.node)
                .flatMap(node => node.runtimes)
                .filter(runtime => runtime.models.includes(candidate.model))
                .map(runtime => ((runtime.metadata?.outcomes || {}) as Record<string, { toolSamples?: number; toolSuccessRate?: number }>)[candidate.model])
                .filter(Boolean)
            const toolSamples = outcomeSamples.reduce((sum, sample) => sum + Number(sample.toolSamples || 0), 0)
            const weightedToolSuccess = toolSamples
                ? outcomeSamples.reduce((sum, sample) => sum + Number(sample.toolSuccessRate || 0) * Number(sample.toolSamples || 0), 0) / toolSamples
                : 0
            const outcomeBonus = (successRate - 0.5) * 40 + feedbackScore
            const quality = getModelScoreAdjustment(candidate.model, taskType)
            const latencyPenalty = Math.min(20, averageDuration / 2000)
            const costPenalty = Math.min(20, averageCost * 100)
            const throughputBonus = Math.min(10, tokensPerSecond / 10)
            const toolReliabilityBonus = toolSamples >= 3 ? (weightedToolSuccess - 0.5) * 20 : 0
            return {
                candidate,
                score: Number(candidate.baseScore || 0) + quality + outcomeBonus + throughputBonus + toolReliabilityBonus - latencyPenalty - costPenalty,
                samples: validatedMatches.length,
                successes,
                rawSuccessRate,
                successRate,
                averageCost,
                tokensPerSecond,
                toolSamples,
                toolSuccessRate: weightedToolSuccess,
            }
        }).sort((a, b) => b.score - a.score)
        const winner = scored[0] || { candidate: baseline, score: 0, samples: 0, successes: 0, rawSuccessRate: 0, successRate: 0.5, averageCost: 0, tokensPerSecond: 0, toolSamples: 0, toolSuccessRate: 0 }
        const runnerUp = scored[1]
        const confidence = Math.max(0, Math.min(1, (winner.samples / 20) * (runnerUp ? Math.max(0.1, (winner.score - runnerUp.score + 10) / 30) : 0.5)))
        const minSamples = Math.max(10, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SAMPLES || 20))
        const minSuccesses = Math.max(5, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESSES || 15))
        const minSuccessRate = Math.max(0.5, Math.min(1, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESS_RATE || 0.75)))
        const activationEligible = winner.samples >= minSamples
            && winner.successes >= minSuccesses
            && winner.rawSuccessRate >= minSuccessRate
            && confidence >= 0.65
        const recommended = winner.candidate
        const activeTaskTypes = (process.env.NOVA_OUTCOME_ROUTER_ACTIVE_TASKS || '').split(',').map(item => item.trim()).filter(Boolean)
        const taskTypeAllowed = activeTaskTypes.length === 0 || activeTaskTypes.includes(taskType)
        const canaryPercent = Math.max(0, Math.min(100, Number(process.env.NOVA_OUTCOME_ROUTER_CANARY_PERCENT || 100)))
        const inCanary = stablePercentage(`${taskType}:${recommended.model}:${recommended.node || ''}`) < canaryPercent
        const selected = this.mode === 'active' && activationEligible && taskTypeAllowed && inCanary ? recommended : baseline
        const decision: ShadowRouteDecision = {
            mode: this.mode, selected, recommended, confidence,
            changed: selected.model !== baseline.model || selected.node !== baseline.node,
            activationEligible,
            reasons: [
                `task=${taskType}`,
                `outcome score=${winner.score.toFixed(1)}`,
                `validated success=${(winner.successRate * 100).toFixed(0)}%`,
                `average cost=$${winner.averageCost.toFixed(4)}`,
                `measured throughput=${winner.tokensPerSecond.toFixed(1)} tok/s`,
                `verified tool success=${winner.toolSamples ? `${(winner.toolSuccessRate * 100).toFixed(0)}% (${winner.toolSamples})` : 'no samples'}`,
                `validated samples=${winner.samples}/${minSamples}`,
                `validated successes=${winner.successes}/${minSuccesses}`,
                `raw success rate=${(winner.rawSuccessRate * 100).toFixed(0)}%/${(minSuccessRate * 100).toFixed(0)}%`,
                this.mode === 'shadow'
                    ? 'shadow mode: baseline retained'
                    : !taskTypeAllowed ? 'active task allowlist excludes this task: baseline retained'
                        : !inCanary ? `outside ${canaryPercent}% deterministic canary: baseline retained`
                            : activationEligible ? 'active outcome routing' : 'activation gate closed: baseline retained',
            ],
            evaluatedAt: new Date().toISOString(),
        }
        try {
            if (!existsSync(dirname(this.decisionFile))) mkdirSync(dirname(this.decisionFile), { recursive: true })
            appendFileSync(this.decisionFile, `${JSON.stringify(decision)}\n`)
        } catch { /* routing must never fail due to telemetry */ }
        return decision
    }
}

let singleton: OutcomeRouter | null = null
export function getOutcomeRouter(): OutcomeRouter { singleton ||= new OutcomeRouter(); return singleton }
