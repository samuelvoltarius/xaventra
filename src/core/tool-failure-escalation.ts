import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { classifyToolFailure, type ToolFailureKind } from './typed-tool-recovery.js'
import { getSessionContinuityStore, type SessionContinuityStore } from '../memory/session-summarizer.js'
import { getFailureResearchCoordinator, type FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { redactSecrets } from '../security/secret-redaction.js'

export interface VerifiedToolFailureObservation {
    callId: string
    toolName: string
    args: Record<string, unknown>
    failure: unknown
}

export type ToolFailureEscalationState = 'awaiting-user' | 'doctor-queued'

export interface ToolFailureEscalationRecord {
    id: string
    runId: string
    principalHash: string
    callId: string
    toolName: string
    classification: ToolFailureKind
    state: ToolFailureEscalationState
    evidenceRefs: string[]
    argumentKeys: string[]
    failureDigest: string
    failureSummary: string
    question?: string
    doctorCaseId?: string
    createdAt: string
    updatedAt: string
}

interface ToolFailureEscalationFile {
    version: 1
    updatedAt: string
    records: ToolFailureEscalationRecord[]
}

export interface ToolFailureEscalationDecision {
    record: ToolFailureEscalationRecord
    content: string
    deduplicated: boolean
}

function stableHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function failureText(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return String(value ?? '')
    const item = value as Record<string, unknown>
    return [item.code, item.status, item.error, item.stderr, item.message]
        .filter(part => typeof part === 'string' || typeof part === 'number')
        .join(' ')
}

function safeSummary(value: unknown): string {
    const redacted = redactSecrets(failureText(value)).replace(/\s+/g, ' ').trim()
    return (redacted || 'No structured failure detail').slice(0, 500)
}

function questionFor(classification: ToolFailureKind, toolName: string): string | undefined {
    if (classification === 'missing-resource') {
        return `Für ${toolName} fehlt ein eindeutig auflösbarer Pfad oder ein Ziel. Welchen konkreten Pfad beziehungsweise welches Ziel soll ich verwenden?`
    }
    if (classification === 'invalid-input') {
        return `Die Eingabe für ${toolName} wurde verifiziert abgelehnt. Welche konkrete Eingabe soll ich stattdessen verwenden?`
    }
    if (classification === 'authorization') {
        return `Für ${toolName} fehlt eine gültige Anmeldung oder Freigabe. Hast du sie außerhalb des Chats erneuert, sodass ich den ursprünglichen Auftrag fortsetzen darf?`
    }
    return undefined
}

export class ToolFailureEscalationStore {
    private records: ToolFailureEscalationRecord[] = []

    constructor(private readonly path = getNovaDataDir('recovery', 'tool-failure-escalations.json')) {
        try {
            if (existsSync(path)) {
                const parsed = JSON.parse(readFileSync(path, 'utf8')) as ToolFailureEscalationFile
                this.records = Array.isArray(parsed.records) ? parsed.records : []
            }
        } catch { this.records = [] }
    }

    get(id: string): ToolFailureEscalationRecord | undefined {
        const value = this.records.find(record => record.id === id)
        return value ? structuredClone(value) : undefined
    }

    list(): ToolFailureEscalationRecord[] {
        return this.records.map(record => structuredClone(record))
    }

    put(record: ToolFailureEscalationRecord): ToolFailureEscalationRecord {
        const index = this.records.findIndex(value => value.id === record.id)
        if (index >= 0) this.records[index] = structuredClone(record)
        else this.records.push(structuredClone(record))
        this.records = this.records.slice(-1_000)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: new Date().toISOString(), records: this.records } satisfies ToolFailureEscalationFile)
        return structuredClone(record)
    }
}

function existingDecision(record: ToolFailureEscalationRecord): ToolFailureEscalationDecision {
    return {
        record,
        deduplicated: true,
        content: record.state === 'awaiting-user' && record.question
            ? record.question
            : 'Die Aktion ist verifiziert fehlgeschlagen. Eine begrenzte Doctor-Diagnose ist bereits vorgemerkt; es wurde keine Änderung ausgeführt.',
    }
}

/** Persist one deterministic escalation for independently observed tool
 * failure evidence. Raw failure text is data only: it cannot choose a tool,
 * command or permission. The function either asks one durable, user-scoped
 * question or queues the existing read-only Doctor research pipeline. */
export function escalateVerifiedToolFailures(input: {
    principalId: string
    runId: string
    request: string
    observations: VerifiedToolFailureObservation[]
}, dependencies: {
    store?: ToolFailureEscalationStore
    continuity?: SessionContinuityStore
    doctor?: FailureResearchCoordinator
    now?: Date
} = {}): ToolFailureEscalationDecision | null {
    const observation = input.observations.find(value => value.callId && value.toolName)
    if (!observation) return null

    const store = dependencies.store || getToolFailureEscalationStore()
    const continuity = dependencies.continuity || getSessionContinuityStore()
    const doctor = dependencies.doctor || getFailureResearchCoordinator()
    const classification = classifyToolFailure(observation.failure)
    const principalHash = stableHash(input.principalId).slice(0, 24)
    const id = stableHash([input.runId, observation.callId, observation.toolName, classification]).slice(0, 24)
    const existing = store.get(id)
    if (existing) return existingDecision(existing)

    const now = (dependencies.now || new Date()).toISOString()
    const summary = safeSummary(observation.failure)
    const requestedQuestion = questionFor(classification, observation.toolName)
    const pending = continuity.getSummary(input.principalId)?.pendingClarification
    const canAsk = Boolean(requestedQuestion) && !pending
    const base: ToolFailureEscalationRecord = {
        id,
        runId: input.runId,
        principalHash,
        callId: observation.callId,
        toolName: observation.toolName,
        classification,
        state: canAsk ? 'awaiting-user' : 'doctor-queued',
        evidenceRefs: [`run:${input.runId}`, `tool:${observation.callId}`],
        argumentKeys: Object.keys(observation.args || {}).sort().slice(0, 30),
        failureDigest: stableHash(summary),
        failureSummary: summary,
        createdAt: now,
        updatedAt: now,
    }

    if (canAsk && requestedQuestion) {
        base.question = requestedQuestion
        store.put(base)
        continuity.setPendingClarification(input.principalId, {
            id: `tool-failure-${id}`,
            originalRequest: input.request,
            question: requestedQuestion,
            missingFields: [classification, observation.toolName],
            createdAt: (dependencies.now || new Date()).getTime(),
        })
        return { record: structuredClone(base), content: requestedQuestion, deduplicated: false }
    }

    const finding = doctor.ingest({
        id: `tool-failure-${id}`,
        title: `Verified ${classification} failure in ${observation.toolName}`,
        detail: `Observed by the Execution Kernel for ${observation.toolName}: ${summary}`,
        category: 'tools', severity: classification === 'unknown' ? 'warning' : 'info',
        source: 'execution-kernel',
        recommendation: 'Run bounded read-only Doctor research; do not execute a repair without sandbox, regression, rollback and PATCH_GATE evidence.',
        evidence: { runId: input.runId, callId: observation.callId, toolName: observation.toolName, classification, failureDigest: base.failureDigest },
        status: 'open', createdAt: now, updatedAt: now,
    })
    base.doctorCaseId = finding.id
    store.put(base)
    return {
        record: structuredClone(base), deduplicated: false,
        content: 'Die Aktion ist verifiziert fehlgeschlagen. Ich habe eine begrenzte Doctor-Diagnose vorgemerkt; es wurde keine Änderung ausgeführt.',
    }
}

let singleton: ToolFailureEscalationStore | null = null
export function getToolFailureEscalationStore(): ToolFailureEscalationStore {
    return singleton ||= new ToolFailureEscalationStore()
}
export function setToolFailureEscalationStore(value: ToolFailureEscalationStore): void { singleton = value }
