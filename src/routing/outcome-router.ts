/**
 * Validated routing samples (Lernkurve, Trainingsstand) — no routing.
 *
 * 2.84.0 Punkt 5: Xaventra has ONE measuring router, the multi-router
 * (`decideMultiRoute` with measurements from the model registry, which counts
 * only real owner runs via `ownerKernelRun`). The former shadow decision on
 * every request, its opt-in `active` mode (environment switch) and the
 * shadow decision log are gone. This store keeps principal-scoped validated
 * samples for the learning curve (`successTrend`) and `getTrainingStatus()`
 * (desktop model control).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'

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

/** 2.83.0 Lernkurve: success per task type, last 7 days against the 7 before. */
export interface SuccessTrendWindow { samples: number; successes: number }
export interface SuccessTrend {
    taskTypes: Array<{ taskType: string; previous: SuccessTrendWindow; current: SuccessTrendWindow }>
    /** Validated runs the owner later rejected (invalidated), by rejection time. */
    rejected: { previous: number; current: number }
}
const TREND_WINDOW_MS = 7 * 24 * 60 * 60_000
const TREND_MIN_SAMPLES = 5

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

/** Old shadow decision log: renamed once to `*.migriert` (never deleted). */
export function migrateShadowDecisionLog(dataFile = getNovaDataDir('outcome-router-shadow.jsonl')): boolean {
    let moved = false
    for (const file of [dataFile, `${dataFile}.1`]) {
        try {
            if (!existsSync(file) || existsSync(`${file}.migriert`)) continue
            renameSync(file, `${file}.migriert`)
            moved = true
        } catch { /* best effort; the file is no longer written */ }
    }
    return moved
}

export class OutcomeRouter {
    /** The first three parameters are kept for call-site compatibility only (no ledger read, no shadow log, no mode). */
    constructor(
        _ledger?: unknown,
        _legacyDecisionFile?: string,
        _legacyMode?: 'shadow' | 'active',
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

    /**
     * Read-only learning curve over all principals (counts only, no text): per
     * task type the success rate of the last 7 days against the 7 days before,
     * only task types with at least 5 samples in both windows. A run the owner
     * later rejected counts as a failure in its validation window.
     */
    successTrend(now = Date.now()): SuccessTrend {
        const windowOf = (at: string | undefined): 'current' | 'previous' | null => {
            const time = Date.parse(String(at))
            if (!Number.isFinite(time) || time > now) return null
            if (time > now - TREND_WINDOW_MS) return 'current'
            if (time > now - 2 * TREND_WINDOW_MS) return 'previous'
            return null
        }
        const groups = new Map<string, Record<'current' | 'previous', SuccessTrendWindow>>()
        const rejected = { previous: 0, current: 0 }
        for (const sample of this.loadSamples()) {
            const rejectedIn = sample.invalidatedAt ? windowOf(sample.invalidatedAt) : null
            if (rejectedIn) rejected[rejectedIn]++
            const window = windowOf(sample.validatedAt)
            if (!window) continue
            const group = groups.get(sample.taskType) || { current: { samples: 0, successes: 0 }, previous: { samples: 0, successes: 0 } }
            group[window].samples++
            if (sample.success && !sample.invalidatedAt) group[window].successes++
            groups.set(sample.taskType, group)
        }
        const taskTypes = [...groups]
            .filter(([, group]) => group.current.samples >= TREND_MIN_SAMPLES && group.previous.samples >= TREND_MIN_SAMPLES)
            .sort((a, b) => (b[1].current.samples + b[1].previous.samples) - (a[1].current.samples + a[1].previous.samples) || a[0].localeCompare(b[0]))
            .map(([taskType, group]) => ({ taskType, previous: group.previous, current: group.current }))
        return { taskTypes, rejected }
    }

    getTrainingStatus(userId?: string): OutcomeTrainingStatus {
        const minimumSamples = Math.max(10, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SAMPLES || 20))
        const minimumSuccesses = Math.max(5, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESSES || 15))
        const minimumSuccessRate = Math.max(0.5, Math.min(1, Number(process.env.NOVA_OUTCOME_ROUTER_MIN_SUCCESS_RATE || 0.75)))
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
        // `mode` stays 'shadow': these samples never select a route (the multi-router does).
        return { mode: 'shadow', minimumSamples, minimumSuccesses, minimumSuccessRate, activeTaskTypes: [], canaryPercent: 0, cells, evaluatedAt: new Date().toISOString(), scope: scope ? 'principal' : 'aggregate-observability' }
    }
}

let singleton: OutcomeRouter | null = null
export function getOutcomeRouter(): OutcomeRouter {
    if (!singleton) {
        migrateShadowDecisionLog()
        singleton = new OutcomeRouter()
    }
    return singleton
}
