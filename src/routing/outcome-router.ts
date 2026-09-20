import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
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
    scope: 'principal' | 'aggregate-observability'
}

export interface ValidatedRoutingSampleInput {
    runId: string
    userId: string
    channel?: string
    taskType: string
    model?: string
    node?: string
    success: boolean
    durationMs: number
    costUsd: number
    validatedAt: string
    validationSource: 'nova-execution-kernel'
    evidenceRefs: string[]
}

interface PersistedRoutingSample {
    version: 1
    runId: string
    principalHash: string
    taskType: string
    model: string
    node?: string
    success: boolean
    durationMs: number
    costUsd: number
    validatedAt: string
    evidenceRefs: string[]
    evidenceHash: string
    invalidatedAt?: string
}

interface PersistedRoutingSamples {
    version: 1
    updatedAt: string
    samples: PersistedRoutingSample[]
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function principalHash(userId: string): string {
    return sha256(`xaventra-outcome-router\u0000${userId.trim()}`)
}

function sampleHash(sample: Omit<PersistedRoutingSample, 'evidenceHash'>): string {
    return sha256(JSON.stringify({ ...sample, evidenceRefs: [...sample.evidenceRefs].sort() }))
}

function excludedTrainingIdentity(userId: string, channel = ''): boolean {
    const identity = `${userId}\u0000${channel}`.toLowerCase()
    return /(^|\u0000|:)(benchmark|fixture|synthetic|sandbox|test)(:|\u0000|$)/.test(identity)
}

function stablePercentage(value: string): number {
    let hash = 2166136261
    for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) }
    return (hash >>> 0) % 100
}

export class OutcomeRouter {
    constructor(
        private readonly ledger: OutcomeLedger = getOutcomeLedger(),
        private readonly decisionFile = getNovaDataDir('outcome-router-shadow.jsonl'),
        private readonly mode: 'shadow' | 'active' = process.env.NOVA_OUTCOME_ROUTER_MODE === 'active' ? 'active' : 'shadow',
        private readonly sampleFile = getNovaDataDir('outcome-router-samples.json'),
    ) {}

    private loadSamples(): PersistedRoutingSample[] {
        try {
            if (!existsSync(this.sampleFile)) return []
            const parsed = JSON.parse(readFileSync(this.sampleFile, 'utf8')) as PersistedRoutingSamples
            if (parsed?.version !== 1 || !Array.isArray(parsed.samples)) return []
            const seen = new Set<string>()
            return parsed.samples.filter(sample => {
                if (sample?.version !== 1 || !sample.runId || !sample.principalHash || !sample.taskType || !sample.model) return false
                if (!/^[a-f0-9]{64}$/.test(sample.principalHash) || !/^[a-f0-9]{64}$/.test(sample.evidenceHash)) return false
                if (!Array.isArray(sample.evidenceRefs) || sample.evidenceRefs.some(ref => typeof ref !== 'string')) return false
                if (!Number.isFinite(Date.parse(sample.validatedAt)) || !Number.isFinite(sample.durationMs) || !Number.isFinite(sample.costUsd)) return false
                const { evidenceHash, ...hashInput } = sample
                if (evidenceHash !== sampleHash(hashInput)) return false
                const key = `${sample.principalHash}\u0000${sample.runId}`
                if (seen.has(key)) return false
                seen.add(key)
                return true
            }).slice(-10_000)
        } catch {
            // Corrupt or partially written training state is never routing evidence.
            return []
        }
    }

    private persistSamples(samples: PersistedRoutingSample[]): void {
        atomicWriteJsonSync(this.sampleFile, {
            version: 1,
            updatedAt: new Date().toISOString(),
            samples: samples.slice(-10_000),
        } satisfies PersistedRoutingSamples)
    }

    /** Persist a derived routing sample only after the canonical Execution
     * Kernel validator produced independently checkable evidence. The store is
     * principal-scoped and contains no request text, tool arguments or output. */
    recordValidatedSample(input: ValidatedRoutingSampleInput): boolean {
        if (input.validationSource !== 'nova-execution-kernel') return false
        if (!input.runId || !input.userId.trim() || !input.taskType || !input.model) return false
        if (excludedTrainingIdentity(input.userId, input.channel)) return false
        if (!Number.isFinite(Date.parse(input.validatedAt))) return false
        const evidenceRefs = [...new Set(input.evidenceRefs.filter(ref => typeof ref === 'string' && ref.trim()))]
        // A non-empty model response is not independent outcome evidence.
        if (evidenceRefs.length === 0 || evidenceRefs.every(ref => ref === 'response' || ref === 'current-turn-output-contract')) return false
        const base: Omit<PersistedRoutingSample, 'evidenceHash'> = {
            version: 1,
            runId: input.runId,
            principalHash: principalHash(input.userId),
            taskType: input.taskType,
            model: input.model,
            ...(input.node ? { node: input.node } : {}),
            success: input.success,
            durationMs: Math.max(0, Number(input.durationMs || 0)),
            costUsd: Math.max(0, Number(input.costUsd || 0)),
            validatedAt: input.validatedAt,
            evidenceRefs,
        }
        const samples = this.loadSamples()
        const key = `${base.principalHash}\u0000${base.runId}`
        if (samples.some(sample => `${sample.principalHash}\u0000${sample.runId}` === key)) return false
        samples.push({ ...base, evidenceHash: sampleHash(base) })
        this.persistSamples(samples)
        return true
    }

    invalidateValidatedSample(runId: string, userId: string, reason = 'outcome invalidated'): boolean {
        if (!runId || !userId.trim()) return false
        const scope = principalHash(userId)
        const samples = this.loadSamples()
        const sample = samples.find(item => item.runId === runId && item.principalHash === scope && !item.invalidatedAt)
        if (!sample) return false
        sample.invalidatedAt = new Date().toISOString()
        sample.evidenceRefs = [...sample.evidenceRefs, `invalidation:${sha256(reason).slice(0, 16)}`]
        const { evidenceHash: _previousHash, ...hashInput } = sample
        sample.evidenceHash = sampleHash(hashInput)
        this.persistSamples(samples)
        return true
    }

    getTrainingStatus(userId?: string): OutcomeTrainingStatus {
        const minimumSamples = Math.max(10, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SAMPLES || 20))
        const minimumSuccesses = Math.max(5, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESSES || 15))
        const minimumSuccessRate = Math.max(0.5, Math.min(1, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESS_RATE || 0.75)))
        const activeTaskTypes = (process.env.NOVA_OUTCOME_ROUTER_ACTIVE_TASKS || '').split(',').map(item => item.trim()).filter(Boolean)
        const canaryPercent = Math.max(0, Math.min(100, Number(process.env.NOVA_OUTCOME_ROUTER_CANARY_PERCENT || 100)))
        const scope = userId?.trim() ? principalHash(userId) : undefined
        const samples = this.loadSamples().filter(sample => !sample.invalidatedAt && (!scope || sample.principalHash === scope))
        const groups = new Map<string, { taskType: string; model: string; node?: string; samples: PersistedRoutingSample[] }>()
        for (const sample of samples) {
            const key = `${sample.taskType}\u0000${sample.model}\u0000${sample.node || ''}`
            const group = groups.get(key) || { taskType: sample.taskType, model: sample.model, node: sample.node, samples: [] }
            group.samples.push(sample)
            groups.set(key, group)
        }
        const cells = [...groups.values()].map(group => {
            const successes = group.samples.filter(sample => sample.success).length
            const sampleCount = group.samples.length
            const successRate = sampleCount ? successes / sampleCount : 0
            return {
                taskType: group.taskType, model: group.model, node: group.node, samples: sampleCount, successes, successRate,
                averageDurationMs: sampleCount ? group.samples.reduce((sum, sample) => sum + sample.durationMs, 0) / sampleCount : 0,
                averageCostUsd: sampleCount ? group.samples.reduce((sum, sample) => sum + sample.costUsd, 0) / sampleCount : 0,
                activationEligible: Boolean(scope) && sampleCount >= minimumSamples && successes >= minimumSuccesses && successRate >= minimumSuccessRate,
            }
        }).sort((a, b) => b.samples - a.samples || b.successRate - a.successRate)
        return { mode: this.mode, minimumSamples, minimumSuccesses, minimumSuccessRate, activeTaskTypes, canaryPercent, cells, evaluatedAt: new Date().toISOString(), scope: scope ? 'principal' : 'aggregate-observability' }
    }

    decide(taskType: string, baseline: RouteCandidate, candidates: RouteCandidate[], context: { userId?: string; channel?: string } = {}): ShadowRouteDecision {
        const all = candidates.some(item => item.model === baseline.model && item.node === baseline.node) ? candidates : [baseline, ...candidates]
        const graph = getCapabilityGraph().getSnapshot()
        const scope = context.userId?.trim() && !excludedTrainingIdentity(context.userId, context.channel)
            ? principalHash(context.userId)
            : undefined
        const terminal = scope ? this.loadSamples().filter(sample => sample.principalHash === scope && !sample.invalidatedAt) : []
        const scored = all.map(candidate => {
            const validatedMatches = terminal.filter(sample =>
                sample.model === candidate.model
                && (!candidate.node || sample.node === candidate.node)
                && sample.taskType === taskType)
            const successes = validatedMatches.filter(sample => sample.success).length
            const rawSuccessRate = validatedMatches.length ? successes / validatedMatches.length : 0
            const successRate = (successes + 1) / (validatedMatches.length + 2) // Bayesian score avoids early overfitting
            const feedbackScore = 0
            const averageCost = validatedMatches.length ? validatedMatches.reduce((sum, sample) => sum + sample.costUsd, 0) / validatedMatches.length : Number(candidate.estimatedCostUsd || 0)
            const averageDuration = validatedMatches.length
                ? validatedMatches.reduce((sum, sample) => sum + sample.durationMs, 0) / validatedMatches.length
                : 0
            const runtimeSamples = graph.nodes
                .filter(node => !candidate.node || node.id === candidate.node || node.hostname === candidate.node)
                .flatMap(node => node.runtimes)
                .filter(runtime => runtime.models.includes(candidate.model))
                .flatMap(runtime => Object.values((runtime.metadata?.performance || {}) as Record<string, { tokensPerSecond?: number }>))
            const tokensPerSecond = Math.max(0, ...runtimeSamples.map(sample => Number(sample.tokensPerSecond || 0)))
            // Outcome success is principal-scoped. Capability Graph outcome
            // aggregates and model-perf.json may include other users or merely
            // transport-level success, so neither may train active selection.
            const toolSamples = validatedMatches.length
            const weightedToolSuccess = rawSuccessRate
            const outcomeBonus = (successRate - 0.5) * 40 + feedbackScore
            const latencyPenalty = Math.min(20, averageDuration / 2000)
            const costPenalty = Math.min(20, averageCost * 100)
            const throughputBonus = Math.min(10, tokensPerSecond / 10)
            const toolReliabilityBonus = toolSamples >= 3 ? (weightedToolSuccess - 0.5) * 20 : 0
            return {
                candidate,
                score: Number(candidate.baseScore || 0) + outcomeBonus + throughputBonus + toolReliabilityBonus - latencyPenalty - costPenalty,
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
