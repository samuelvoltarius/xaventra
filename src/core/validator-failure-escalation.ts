import { createHash } from 'node:crypto'
import { getOutcomeLedger, type OutcomeLedger } from './outcome-ledger.js'
import { getFailureResearchCoordinator, type FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'

/** Reconcile committed Kernel failures into the existing durable Doctor queue.
 * No request, URL, identity or tool output crosses into global diagnostic context.
 * A crash after run.failed is recovered by the next authorized autonomy cycle.
 */
export function reconcileValidatorFailures(
    ledger: Pick<OutcomeLedger, 'listRuns'> = getOutcomeLedger(),
    doctor: Pick<FailureResearchCoordinator, 'list' | 'ingest'> = getFailureResearchCoordinator(),
): number {
    const known = new Set(doctor.list().map(item => item.findingId))
    let added = 0
    for (const run of ledger.listRuns(200)) {
        if (run.status !== 'failed' || run.invalidated || !run.userId || run.userId === 'Nova-Autonomy'
            || !run.channel || run.channel === 'internal' || run.channel === 'benchmark'
            || run.contract?.id !== run.runId
            || run.finalOutcome?.reason !== 'validator-rejected'
            || run.finalOutcome?.diagnosticEligible !== true
            || run.validation?.validator !== 'nova-execution-kernel'
            || run.validation.success || run.validation.awaitingApproval) continue
        const failedKinds = [...new Set(run.contract.successCriteria
            .filter(criterion => criterion.required && run.validation!.criteria.some(result =>
                result.criterionId === criterion.id && !result.success))
            .map(criterion => criterion.kind)
            .filter(kind => ['response_present', 'response_constraints', 'verified_tool', 'artifact_present', 'test_passed'].includes(kind)))].sort()
        if (!failedKinds.length) continue
        // Principal is part of the key: identical run IDs from different owners
        // must never collapse into a shared diagnostic observation.
        const digest = createHash('sha256').update(JSON.stringify([run.userId, run.runId])).digest('hex')
        const id = `validator-failure-${digest}`
        if (known.has(id)) continue
        doctor.ingest({
            id, title: 'Execution Kernel completion evidence rejected', category: 'tools', severity: 'warning',
            source: 'execution-kernel', status: 'open', createdAt: run.updatedAt, updatedAt: run.updatedAt,
            detail: `Committed validator rejection; failed criteria: ${failedKinds.join(', ')}. Correlation: ${digest}. Cause not yet established.`,
            recommendation: 'Inspect current health, capabilities and mesh through bounded read-only tools. Do not repeat the original action. Source changes require sandbox, regression, rollback and PATCH_GATE.',
            evidence: { correlation: digest, failedKinds },
        })
        known.add(id)
        added++
        if (added >= 10) break // bounded intake per existing cycle, not another timer
    }
    return added
}
