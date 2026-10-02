import { createHash } from 'node:crypto'
import { getOutcomeLedger, type OutcomeLedger, type OutcomeRunView } from './outcome-ledger.js'
import type { DoctorFinding } from './self-doctor.js'
import { getFailureResearchCoordinator, observationFingerprint, type FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'

/** 2.83.0 Punkt 8: a Doctor case needs this many rejected runs of the same shape … */
export const VALIDATOR_GROUP_MIN_RUNS = 3
/** … within this window. A single rejected run stays an Outcome-Ledger receipt. */
export const VALIDATOR_GROUP_WINDOW_DAYS = 7

const CHECKED_KINDS = ['response_present', 'response_constraints', 'verified_tool', 'artifact_present', 'test_passed']
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

type DoctorPort = Pick<FailureResearchCoordinator, 'list' | 'ingest'> & Partial<Pick<FailureResearchCoordinator, 'addEvidenceRefs'>>

/** Task type of a run as chosen by the router (`route.selected`), never request text. */
export function validatorTaskType(run: Pick<OutcomeRunView, 'events'>): string {
    const raw = (run.events || []).find(event => event.type === 'route.selected')?.payload?.taskType
    return String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'unbekannt'
}

interface Rejection { runRef: string; legacyId: string; taskType: string; failedKinds: string[]; at: number }

/** Committed, diagnosable Kernel rejection of a real owner run; null otherwise. */
function rejectionOf(run: OutcomeRunView): Rejection | null {
    if (run.status !== 'failed' || run.invalidated || !run.userId || run.userId === 'Nova-Autonomy'
        || !run.channel || run.channel === 'internal' || run.channel === 'benchmark'
        || run.contract?.id !== run.runId
        || run.finalOutcome?.reason !== 'validator-rejected'
        || run.finalOutcome?.diagnosticEligible !== true
        || run.validation?.validator !== 'nova-execution-kernel'
        || run.validation.success || run.validation.awaitingApproval) return null
    const failedKinds = [...new Set(run.contract.successCriteria
        .filter(criterion => criterion.required && run.validation!.criteria.some(result =>
            result.criterionId === criterion.id && !result.success))
        .map(criterion => criterion.kind)
        .filter(kind => CHECKED_KINDS.includes(kind)))].sort()
    if (!failedKinds.length) return null
    // Principal is part of the run reference: identical run IDs from different
    // owners never collapse into one receipt. Only the digest leaves the ledger.
    const digest = sha([run.userId, run.runId])
    return { runRef: `validator-run:${digest.slice(0, 24)}`, legacyId: `validator-failure-${digest}`, taskType: validatorTaskType(run), failedKinds, at: Date.parse(run.updatedAt) || 0 }
}

/** One finding per failure shape (task type + failed criterion kinds). No request, URL, identity or tool output. */
export function validatorShapeFinding(taskType: string, failedKinds: readonly string[], count: number, at: string): DoctorFinding {
    return {
        id: `validator-failure-${sha(['validator-shape', taskType, [...failedKinds].sort()])}`,
        title: 'Execution Kernel completion evidence rejected', category: 'tools', severity: 'warning',
        source: 'execution-kernel', status: 'open', createdAt: at, updatedAt: at,
        detail: `Committed validator rejections; Aufgabenart: ${taskType}; failed criteria: ${failedKinds.join(', ')}; ${count} runs in ${VALIDATOR_GROUP_WINDOW_DAYS} days. Cause not yet established.`,
        recommendation: 'Inspect current health, capabilities and mesh through bounded read-only tools. Do not repeat the original action. Source changes require sandbox, regression, rollback and PATCH_GATE.',
        evidence: { taskType, failedKinds: [...failedKinds], count },
    }
}

/** Reconcile committed Kernel failures into the existing durable Doctor queue.
 * 2.83.0 Punkt 8: one case per failure shape, not per run. An open case of the
 * same shape only receives the new run references; a new case needs
 * VALIDATOR_GROUP_MIN_RUNS rejections in VALIDATOR_GROUP_WINDOW_DAYS. Legacy
 * per-run cases stay and keep their runs. A crash after run.failed is
 * recovered by the next authorized autonomy cycle.
 */
export function reconcileValidatorFailures(
    ledger: Pick<OutcomeLedger, 'listRuns'> = getOutcomeLedger(),
    doctor: DoctorPort = getFailureResearchCoordinator(),
    now: number = Date.now(),
): number {
    const cases = doctor.list()
    const legacy = new Set(cases.map(item => item.findingId))
    const cutoff = now - VALIDATOR_GROUP_WINDOW_DAYS * 24 * 60 * 60_000
    const groups = new Map<string, Rejection[]>()
    for (const run of ledger.listRuns(200)) {
        const rejection = rejectionOf(run)
        if (!rejection || rejection.at < cutoff || legacy.has(rejection.legacyId)) continue
        const key = JSON.stringify([rejection.taskType, rejection.failedKinds])
        groups.set(key, [...(groups.get(key) || []), rejection])
    }
    let added = 0
    for (const items of groups.values()) {
        const { taskType, failedKinds } = items[0]
        const latest = new Date(Math.max(...items.map(item => item.at))).toISOString()
        const finding = validatorShapeFinding(taskType, failedKinds, items.length, latest)
        const hash = observationFingerprint(finding)
        const existing = cases.find(item => item.findingId === finding.id || (item.observationHash === hash && item.findingId.startsWith('validator-failure-')))
        const refs = items.map(item => item.runRef)
        if (existing && existing.findingOpen !== false) {
            const fresh = refs.filter(ref => !existing.evidenceRefs.includes(ref))
            if (fresh.length) doctor.addEvidenceRefs?.(existing.id, fresh)
            continue
        }
        // A case closed by measurement reopens (same case, no second one) only
        // when the shape recurs often enough after it was closed.
        const relevant = existing ? items.filter(item => item.at > Date.parse(existing.updatedAt)) : items
        if (relevant.length < VALIDATOR_GROUP_MIN_RUNS) continue
        if (added >= 10) break // bounded intake per existing cycle, not another timer
        const item = doctor.ingest(finding)
        doctor.addEvidenceRefs?.(item.id, relevant.map(entry => entry.runRef))
        added++
    }
    return added
}
