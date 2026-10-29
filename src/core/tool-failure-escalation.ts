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
            : 'Die Aktion ist nicht gelungen. Ich habe die Ursache intern vorgemerkt und prüfen lassen; es wurde keine Änderung ausgeführt.',
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
        content: 'Die Aktion ist nicht gelungen. Ich habe die Ursache intern zur Prüfung vorgemerkt; es wurde keine Änderung ausgeführt.',
    }
}

let singleton: ToolFailureEscalationStore | null = null
export function getToolFailureEscalationStore(): ToolFailureEscalationStore {
    return singleton ||= new ToolFailureEscalationStore()
}
export function setToolFailureEscalationStore(value: ToolFailureEscalationStore): void { singleton = value }

/**
 * 2.89.15 (Abnahme 2.89.14, 29.10. 11:28:58): hass_turn_on succeeded, a later printer_info failed, and the
 * escalation answered "… es wurde keine Änderung ausgeführt" - false. An action that succeeded in this run is
 * named first; "keine Änderung" is never claimed then. An effect tool is one that takes the owner's approval
 * code (`confirm` parameter, guarded by owner-approval-confirm-param.test.ts). The code itself is never shown.
 */
export function escalationWithCompletedEffects(
    content: string,
    executions: ReadonlyArray<{ toolName?: string; params?: Record<string, unknown>; success?: boolean; result?: unknown }>,
    tools: ReadonlyArray<{ name: string; parameters?: ReadonlyArray<{ name: string }> }> = [],
): string {
    const done = completedEffects(executions, tools)
    const read = readValues(executions)
    if (!done.length && !read.length) return content
    // 2.90.1 (live 29.10. 14:01:39): a value read before the failure (hass_get 97.0 %) is named, not dropped.
    // 2.90.3: each done step by its own result line (angelegt / gelöscht …), not only the tool name.
    return [
        done.length ? `Erledigt: ${done.join('; ')}.` : '',
        read.length ? `Gelesen: ${read.join('; ')}.` : '',
    ].filter(Boolean).join('\n') + '\n\n'
        + (done.length ? 'Ein späterer Schritt ist danach nicht gelungen; die Ursache ist intern zur Prüfung vorgemerkt.'
            : 'Ein späterer Schritt ist danach nicht gelungen; die Ursache ist intern zur Prüfung vorgemerkt. Geändert wurde nichts.')
}

type EffectTool = { name: string; parameters?: ReadonlyArray<{ name: string }> }
type Execution = { toolName?: string; params?: Record<string, unknown>; success?: boolean; result?: unknown }

/**
 * 2.90.3 (Abnahme 2.90.2, Langtest C, 23:27:52-23:28:07): THE rule for "what did this run change". An effect tool
 * takes the owner's approval code (`confirm`); its successful calls are proven changes, named by the first line of
 * their result (else tool + target), at most five, without repeats. Callers pass the runtime registry - before,
 * normal runs passed no tool list and nothing was ever named.
 */
export function completedEffects(executions: ReadonlyArray<Execution>, tools: ReadonlyArray<EffectTool> = []): string[] {
    const effectTools = new Set(tools.filter(tool => tool.parameters?.some(parameter => parameter.name === 'confirm')).map(tool => tool.name))
    const target = (params: Record<string, unknown> = {}) => {
        const value = ['entity_id', 'filename', 'target', 'host', 'to', 'name'].map(key => params[key]).find(item => typeof item === 'string' && item.trim())
        return value ? ` (${String(value).slice(0, 80)})` : ''
    }
    const firstLine = (result: unknown): string => {
        let data: any = result
        if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* plain text */ } }
        const text = typeof data === 'string' ? data : typeof data?.message === 'string' ? data.message : ''
        return text.split('\n').map(line => line.replace(/[*_`]/g, '').trim()).find(Boolean)?.slice(0, 160) || ''
    }
    const out: string[] = []
    for (const item of executions) {
        if (item.success !== true || !effectTools.has(String(item.toolName || ''))) continue
        const line = (firstLine(item.result) || `${item.toolName}${target(item.params)}`).replace(/[.:]+$/, '')
        if (!out.includes(line)) out.push(line)
    }
    return out.slice(0, 5)
}

const NO_CHANGE_CLAIM = /keine Änderung (?:wurde )?(?:ausgeführt|vorgenommen)|nichts verändert|es wurde nichts geändert/i

/** Does a reply say that nothing was changed? (cheap check before the registry is consulted) */
export function claimsNoChange(content: string): boolean {
    return NO_CHANGE_CLAIM.test(String(content || ''))
}

/**
 * 2.90.3: the one guard at delivery. A reply that says nothing was changed ("keine Änderung ausgeführt",
 * "nichts verändert") while this run proved a change is replaced by the done steps and the failed step as a
 * side note. Replies without such a claim, and runs without a proven change, pass unchanged.
 */
export function guardNoChangeClaim(content: string, executions: ReadonlyArray<Execution>, tools: ReadonlyArray<EffectTool>): string {
    if (!NO_CHANGE_CLAIM.test(String(content || '')) || !completedEffects(executions, tools).length) return content
    return escalationWithCompletedEffects(content, executions, tools)
}

/** Values a successful hass_get returned in this run (at most 3); other reads have no safe short form. */
function readValues(executions: ReadonlyArray<{ toolName?: string; success?: boolean; result?: unknown }>): string[] {
    const out: string[] = []
    for (const item of executions) {
        if (item.success !== true || item.toolName !== 'hass_get') continue
        let data: any = item.result
        if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = null } }
        const entity = data?.entity
        if (!entity?.entity_id || entity.state === undefined) continue
        const unit = entity.attributes?.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : ''
        const line = `${String(entity.attributes?.friendly_name || entity.entity_id).slice(0, 80)}: ${String(entity.state).slice(0, 40)}${unit}`
        if (!out.includes(line)) out.push(line)
    }
    return out.slice(0, 3)
}
