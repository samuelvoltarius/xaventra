import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { recordOutcomeEvent, recordToolCall, recordToolEvidence } from '../infra/telemetry.js'
import type { TaskContract, TaskValidationReport } from './task-contract.js'
import { getRegressionCaseStore } from '../learning/regression-case-store.js'

export type OutcomeEventType =
    | 'run.started'
    | 'plan.recorded'
    | 'route.selected'
    | 'tool.finished'
    | 'change.recorded'
    | 'test.finished'
    | 'approval.recorded'
    | 'checkpoint.saved'
    | 'validation.finished'
    | 'cost.recorded'
    | 'feedback.recorded'
    | 'run.invalidated'
    | 'run.completed'
    | 'run.failed'

export interface OutcomeEvent {
    version: 1
    eventId: string
    runId: string
    type: OutcomeEventType
    timestamp: string
    payload: Record<string, unknown>
}

export interface OutcomeRunView {
    runId: string
    status: 'running' | 'awaiting_approval' | 'completed' | 'failed'
    startedAt: string
    updatedAt: string
    contract?: TaskContract
    channel?: string
    userId?: string
    backend?: string
    model?: string
    node?: string
    tools: Array<Record<string, unknown>>
    tests: Array<Record<string, unknown>>
    changes: Array<Record<string, unknown>>
    approvals: Array<Record<string, unknown>>
    costs: Array<Record<string, unknown>>
    feedback: Array<Record<string, unknown>>
    events: OutcomeEvent[]
    totalCostUsd: number
    totalTokens: number
    validation?: TaskValidationReport
    finalOutcome?: Record<string, unknown>
    invalidated?: boolean
    eventCount: number
}

export interface OutcomeCheckpoint {
    version: 1
    runId: string
    backend: string
    backendState?: string
    phase: string
    pendingActions: string[]
    completedIdempotencyKeys: string[]
    ownerNode?: string
    leaseEpoch?: number
    resumeInput?: Record<string, unknown>
    savedAt: string
}

const DEFAULT_DATA_DIR = join(process.cwd(), '.nova-data', 'outcome-ledger')

function safePayload(value: Record<string, unknown>): Record<string, unknown> {
    try {
        const serialized = redactSecrets(JSON.stringify(value))
        const limited = serialized.length > 100_000
            ? JSON.stringify({ truncated: true, preview: serialized.slice(0, 100_000) })
            : serialized
        return JSON.parse(limited) as Record<string, unknown>
    } catch {
        return { serializationError: true }
    }
}

function makeEventId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function haMirroringEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true'
}

export class OutcomeLedger {
    constructor(
        private readonly dataDir = DEFAULT_DATA_DIR,
        /** Non-default ledgers are isolated by default. This prevents tests,
         * benchmarks and sandbox repairs from mirroring fixtures into the
         * production HA store. */
        private readonly mirrorToHa = dataDir === DEFAULT_DATA_DIR,
    ) {}

    private dayFile(timestamp = new Date()): string {
        return join(this.dataDir, `${timestamp.toISOString().slice(0, 10)}.jsonl`)
    }

    private get checkpointDir(): string {
        return join(this.dataDir, 'checkpoints')
    }

    append(runId: string, type: OutcomeEventType, payload: Record<string, unknown> = {}): OutcomeEvent {
        if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
        const event: OutcomeEvent = {
            version: 1,
            eventId: makeEventId(),
            runId,
            type,
            timestamp: new Date().toISOString(),
            payload: safePayload(payload),
        }
        appendFileSync(this.dayFile(), `${JSON.stringify(event)}\n`)
        if (this.mirrorToHa && haMirroringEnabled()) {
            void import('./ha-state.js')
                .then(({ writeHaRecord }) => writeHaRecord('outcome-ledger', event.eventId, event, {
                    runId: event.runId, eventType: event.type,
                }))
                .catch(() => false)
        }
        const status = type === 'run.completed' ? 'completed' : type === 'run.failed' ? 'failed' : undefined
        recordOutcomeEvent({ type, status, backend: typeof event.payload.backend === 'string' ? event.payload.backend : undefined })
        if (type === 'tool.finished') {
            const tool = String(event.payload.toolName || event.payload.tool || 'unknown')
            const verified = event.payload.verified === true || event.payload.transportVerified === true || event.payload.success === true
            const latencyMs = Number(event.payload.durationMs || event.payload.latencyMs || 0)
            recordToolCall({ tool, latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0, success: event.payload.success !== false, verified })
            recordToolEvidence({ tool, verified, source: event.payload.transportVerified === true ? 'mesh' : 'outcome-ledger' })
        }
        return event
    }

    importEvent(event: OutcomeEvent): boolean {
        if (event?.version !== 1 || !event.eventId || !event.runId || !event.timestamp || !event.type) return false
        if (this.listEvents().some(existing => existing.eventId === event.eventId)) return false
        if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
        const timestamp = new Date(event.timestamp)
        if (!Number.isFinite(timestamp.getTime())) return false
        const sanitized: OutcomeEvent = { ...event, payload: safePayload(event.payload || {}) }
        appendFileSync(this.dayFile(timestamp), `${JSON.stringify(sanitized)}\n`)
        return true
    }

    importEvents(events: OutcomeEvent[]): number {
        const known = new Set(this.listEvents().map(event => event.eventId))
        let imported = 0
        for (const event of events) {
            if (event?.version !== 1 || !event.eventId || known.has(event.eventId) || !event.runId || !event.timestamp || !event.type) continue
            const timestamp = new Date(event.timestamp)
            if (!Number.isFinite(timestamp.getTime())) continue
            if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
            const sanitized: OutcomeEvent = { ...event, payload: safePayload(event.payload || {}) }
            appendFileSync(this.dayFile(timestamp), `${JSON.stringify(sanitized)}\n`)
            known.add(event.eventId)
            imported++
        }
        return imported
    }

    start(contract: TaskContract, metadata: { channel?: string; userId?: string; backend?: string } = {}): string {
        this.append(contract.id, 'run.started', { contract, ...metadata })
        return contract.id
    }

    recordPlan(runId: string, plan: Record<string, unknown>): void {
        this.append(runId, 'plan.recorded', plan)
    }

    recordRoute(runId: string, route: { backend?: string; model?: string; node?: string; reason?: string }): void {
        this.append(runId, 'route.selected', route)
    }

    recordTool(runId: string, tool: Record<string, unknown>): void {
        this.append(runId, 'tool.finished', tool)
    }

    recordValidation(runId: string, validation: TaskValidationReport): void {
        this.append(runId, 'validation.finished', { validation })
    }

    recordCost(runId: string, cost: { usd?: number; inputTokens?: number; outputTokens?: number; provider?: string; model?: string; durationMs?: number; energyUsd?: number; hardwareUsd?: number; estimated?: boolean; source?: string }): void {
        this.append(runId, 'cost.recorded', cost)
    }

    recordFeedback(runId: string, feedback: { rating?: number; accepted?: boolean; comment?: string; correction?: string; userId?: string }): void {
        this.append(runId, 'feedback.recorded', feedback)
    }

    recordApproval(runId: string, approval: Record<string, unknown>): void {
        this.append(runId, 'approval.recorded', approval)
    }

    complete(runId: string, outcome: Record<string, unknown>): void {
        this.append(runId, 'run.completed', outcome)
    }

    fail(runId: string, outcome: Record<string, unknown>): void {
        this.append(runId, 'run.failed', outcome)
    }

    invalidate(runId: string, outcome: Record<string, unknown>): void {
        const current = this.getRun(runId)
        if (!current || current.invalidated) return
        this.append(runId, 'run.invalidated', outcome)
    }

    /** Close abandoned in-flight runs after a process crash. Approval waits are
     * durable checkpoints and are intentionally not failed by this sweep. */
    failStaleRuns(maxAgeMs = 15 * 60_000, nowMs = Date.now()): string[] {
        const stale = this.listRuns(500).filter(run =>
            run.status === 'running' && nowMs - Date.parse(run.updatedAt) > maxAgeMs)
        for (const run of stale) {
            this.fail(run.runId, {
                success: false,
                reason: 'stale running outcome reconciled after process interruption',
                previousUpdatedAt: run.updatedAt,
            })
        }
        return stale.map(run => run.runId)
    }

    saveCheckpoint(checkpoint: Omit<OutcomeCheckpoint, 'version' | 'savedAt'>): OutcomeCheckpoint {
        const complete: OutcomeCheckpoint = { ...checkpoint, version: 1, savedAt: new Date().toISOString() }
        atomicWriteJsonSync(join(this.checkpointDir, `${checkpoint.runId}.json`), safePayload(complete as unknown as Record<string, unknown>))
        this.append(checkpoint.runId, 'checkpoint.saved', {
            phase: checkpoint.phase,
            backend: checkpoint.backend,
            pendingActions: checkpoint.pendingActions,
        })
        if (this.mirrorToHa && haMirroringEnabled()) {
            void import('./ha-state.js')
                .then(({ writeHaRecord }) => writeHaRecord('outcome-checkpoint', `outcome_checkpoint_${checkpoint.runId}`, complete, {
                    runId: checkpoint.runId, phase: checkpoint.phase,
                }))
                .catch(() => false)
        }
        return complete
    }

    importCheckpoint(checkpoint: OutcomeCheckpoint): boolean {
        if (checkpoint?.version !== 1 || !checkpoint.runId || !checkpoint.backend || !checkpoint.savedAt) return false
        const current = this.loadCheckpoint(checkpoint.runId)
        if (current && current.savedAt >= checkpoint.savedAt) return false
        if (!existsSync(this.checkpointDir)) mkdirSync(this.checkpointDir, { recursive: true })
        atomicWriteJsonSync(join(this.checkpointDir, `${checkpoint.runId}.json`), safePayload(checkpoint as unknown as Record<string, unknown>))
        return true
    }

    loadCheckpoint(runId: string): OutcomeCheckpoint | null {
        const path = join(this.checkpointDir, `${runId}.json`)
        try {
            return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as OutcomeCheckpoint : null
        } catch {
            return null
        }
    }

    listRuns(limit = 50): OutcomeRunView[] {
        const events = this.listEvents()

        const runs = new Map<string, OutcomeRunView>()
        for (const event of events) {
            let view = runs.get(event.runId)
            if (!view) {
                view = {
                    runId: event.runId,
                    status: 'running',
                    startedAt: event.timestamp,
                    updatedAt: event.timestamp,
                    tools: [], tests: [], changes: [], approvals: [], eventCount: 0,
                    costs: [], feedback: [], events: [], totalCostUsd: 0, totalTokens: 0,
                }
                runs.set(event.runId, view)
            }
            view.updatedAt = event.timestamp
            view.eventCount++
            view.events.push(event)
            if (event.type === 'run.started') {
                view.contract = event.payload.contract as TaskContract
                view.channel = String(event.payload.channel || '') || undefined
                view.userId = String(event.payload.userId || '') || undefined
                view.backend = String(event.payload.backend || '') || undefined
            } else if (event.type === 'route.selected') {
                view.backend = String(event.payload.backend || view.backend || '') || undefined
                // Route events are additive projections. Later telemetry-only
                // events often omit node/model; omission must not erase the
                // earlier verified vLLM/Codex placement.
                if (event.payload.model) view.model = String(event.payload.model)
                if (event.payload.node) view.node = String(event.payload.node)
            } else if (event.type === 'tool.finished') view.tools.push(event.payload)
            else if (event.type === 'test.finished') view.tests.push(event.payload)
            else if (event.type === 'change.recorded') view.changes.push(event.payload)
            else if (event.type === 'approval.recorded') view.approvals.push(event.payload)
            else if (event.type === 'cost.recorded') {
                view.costs.push(event.payload)
                view.totalCostUsd += Number(event.payload.usd || 0)
                view.totalTokens += Number(event.payload.inputTokens || 0) + Number(event.payload.outputTokens || 0)
            } else if (event.type === 'feedback.recorded') view.feedback.push(event.payload)
            else if (event.type === 'validation.finished') {
                view.validation = event.payload.validation as TaskValidationReport
                if (view.validation?.awaitingApproval) view.status = 'awaiting_approval'
            } else if (event.type === 'run.completed') {
                view.status = 'completed'
                view.finalOutcome = event.payload
            } else if (event.type === 'run.failed') {
                view.status = 'failed'
                view.finalOutcome = event.payload
            } else if (event.type === 'run.invalidated') {
                view.status = 'failed'
                view.invalidated = true
                view.finalOutcome = event.payload
            }
        }
        return [...runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, limit))
    }

    private listEvents(): OutcomeEvent[] {
        if (!existsSync(this.dataDir)) return []
        const files = readdirSync(this.dataDir)
            .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
            .sort()
            .slice(-14)
        const events: OutcomeEvent[] = []
        for (const file of files) {
            const lines = readFileSync(join(this.dataDir, file), 'utf8').split('\n').filter(Boolean)
            for (const line of lines) {
                try { events.push(JSON.parse(line) as OutcomeEvent) } catch { /* ignore partial final line */ }
            }
        }

        return events
    }

    getRun(runId: string): OutcomeRunView | null {
        return this.listRuns(500).find(run => run.runId === runId) || null
    }
}

let singleton: OutcomeLedger | null = null
const scopedOutcomeLedger = new AsyncLocalStorage<OutcomeLedger>()

export function getOutcomeLedger(): OutcomeLedger {
    const scoped = scopedOutcomeLedger.getStore()
    if (scoped) return scoped
    singleton ||= new OutcomeLedger()
    return singleton
}

export function recordFeedbackForLatestUserRun(input: {
    userId: string
    channel?: string
    rating?: number
    accepted?: boolean
    comment?: string
    correction?: string
    maxAgeMs?: number
}, ledger = getOutcomeLedger()): string | null {
    const maxAgeMs = input.maxAgeMs ?? 48 * 60 * 60_000
    const run = ledger.listRuns(200).find(candidate =>
        candidate.userId === input.userId
        && (!input.channel || candidate.channel === input.channel)
        && !candidate.invalidated
        && (candidate.status === 'completed' || candidate.status === 'failed')
        && Date.now() - Date.parse(candidate.updatedAt) <= maxAgeMs)
    if (!run) return null
    ledger.recordFeedback(run.runId, {
        rating: input.rating,
        accepted: input.accepted,
        comment: input.comment,
        correction: input.correction,
        userId: input.userId,
    })
    const negative = input.accepted === false
        || (typeof input.rating === 'number' && input.rating <= 2)
        || Boolean(input.correction)
    if (negative && run.channel !== 'benchmark' && !String(run.userId || '').startsWith('benchmark:')) {
        const taskType = String(run.events.find(event => event.type === 'route.selected')?.payload.taskType || 'user-feedback')
        const request = String(run.contract?.goal || input.comment || input.correction || 'User rejected the validated outcome')
        ledger.invalidate(run.runId, {
            success: false,
            reason: input.correction || input.comment || 'User rejected the validated outcome',
            source: 'explicit-user-feedback',
        })
        getRegressionCaseStore().record({
            userId: input.userId,
            taskType,
            request,
            runId: run.runId,
            failureClass: input.correction ? 'user-correction' : 'negative-user-feedback',
        })
        void import('../learning/learning-coordinator.js').then(({ getLearningCoordinator }) =>
            getLearningCoordinator().invalidateValidatedRun({
                runId: run.runId,
                userId: input.userId,
                request,
                taskType,
                reason: input.correction || input.comment || 'negative-user-feedback',
            }),
        ).catch(() => undefined)
    }
    return run.runId
}

/** Run an asynchronous workflow against a dedicated ledger without replacing
 * the daemon-wide production ledger. AsyncLocalStorage keeps concurrent
 * Telegram, mesh and benchmark runs in their own authority scope. */
export function withOutcomeLedger<T>(ledger: OutcomeLedger, operation: () => Promise<T>): Promise<T> {
    return scopedOutcomeLedger.run(ledger, operation)
}

export async function hydrateOutcomeLedgerFromHa(ledger = getOutcomeLedger()): Promise<{ events: number; checkpoints: number }> {
    const { readHaRecords } = await import('./ha-state.js')
    const [eventRecords, checkpointRecords] = await Promise.all([
        readHaRecords<OutcomeEvent>('outcome-ledger', 5_000),
        readHaRecords<OutcomeCheckpoint>('outcome-checkpoint', 1_000),
    ])
    let events = 0
    let checkpoints = 0
    events = ledger.importEvents(eventRecords.sort((a, b) => a.timestamp - b.timestamp).map(record => record.payload))
    for (const record of checkpointRecords.sort((a, b) => a.timestamp - b.timestamp)) {
        if (ledger.importCheckpoint(record.payload)) checkpoints++
    }
    return { events, checkpoints }
}
