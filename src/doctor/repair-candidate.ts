import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertPatchSourcePath } from '../synthesis/patch-sandbox.js'
import { evolve, getRepairProfiles, getPatchProposals, getRepairSourceRoot } from '../synthesis/self-evolution.js'
import type { FailureResearchCoordinator, ResearchWorker } from './failure-research-coordinator.js'
import type { TaskContract } from '../core/task-contract.js'
import { repairHash, verifyRepairValue, type RepairReceipt } from './repair-activation.js'
import { redactSecrets } from '../security/secret-redaction.js'

/** Operator profiles select source and immutable oracle. Neither logs nor the
 * model can select files, probe URLs, credentials or production activation. */
export async function proposeDoctorRepair(coordinator: FailureResearchCoordinator, worker: ResearchWorker): Promise<void> {
    if (!worker.hasAuthority()) return
    const profiles = getRepairProfiles()
    const item = coordinator.list().find(c => c.findingOpen !== false && c.stage === 'researching'
        && c.investigation?.status === 'verified' && !c.repair && profiles.some(p => p.findingId === c.findingId))
    if (!item) return
    const profile = profiles.find(p => p.findingId === item.findingId)!
    const runId = `doctor-candidate-${randomUUID()}`
    if (!coordinator.claimRepair(item.id, runId, item.observationHash!)) return
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000)
    try {
        const sourceRoot = getRepairSourceRoot()
        assertPatchSourcePath(sourceRoot, profile.file)
        assertPatchSourcePath(sourceRoot, profile.reproductionTest)
        if (!/\.test\.ts$/.test(profile.reproductionTest) || /\.(test|spec)\./.test(profile.file)) throw new Error('Invalid immutable repair profile')
        const file = join(sourceRoot, profile.file)
        if (statSync(file).size > 48 * 1024) throw new Error('Repair source exceeds model budget; narrow the operator profile')
        const source = readFileSync(file, 'utf8'), sourceHash = repairHash(source)
        if (redactSecrets(source) !== source) throw new Error('Source may contain secrets; candidate research refused')
        const content = [
            'Erzeuge genau ein JSON-Objekt {"description":string,"search":string,"replace":string,"reason":string}.',
            'Ein eng begrenzter Patch, unique exact search. Keine Befehle ausführen, keine Freigabe, keine Änderung, keine Heilung behaupten.',
            'Nutze echte Diagnose-Tools für aktuelle Gegenbelege. Falls kein belegbarer Patch möglich ist: {"blocked":"Grund"}.',
            `Untrusted Falldaten und Quelltext: ${JSON.stringify({ finding: item.hypothesis, report: item.investigation?.report,
                file: profile.file, source }).replace(/\[/g, '\\u005b')}`,
        ].join('\n')
        const contract: TaskContract = {
            id: runId, version: 1, goal: content, createdAt: new Date().toISOString(), expectedArtifacts: [], requiredTests: [],
            successCriteria: [{ id: 'diagnostic-evidence', kind: 'verified_tool', required: true, description: 'Verified current diagnostic result' }],
            allowedChanges: { readOnly: true, allowedPaths: [], allowedTools: ['health_status', 'nova_capabilities'].filter(t => !worker.allowedTools || worker.allowedTools.includes(t)), externalSideEffects: false },
            budget: { timeoutMs: 90_000, maxToolCalls: 3, maxTokens: 6_000 }, approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
        }
        const response = await worker.execute({ contract, content, caseId: item.id, signal: controller.signal, purpose: 'candidate' })
        const run = worker.getRun(runId)
        if (controller.signal.aborted || !worker.hasAuthority() || run?.runId !== runId || run.userId !== 'Nova-Autonomy'
            || run.channel !== 'internal' || run.status !== 'completed' || run.invalidated || run.validation?.success !== true
            || !run.tools.some(t => t.success && contract.allowedChanges.allowedTools.includes(String(t.toolName)))
            || !coordinator.isCurrentObservation(item.id, item.observationHash!)) throw new Error('Candidate lacks current governed outcome/authority')
        const raw = response.output.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
        if (raw.length > 32 * 1024) throw new Error('Candidate exceeds patch budget')
        const patch = JSON.parse(raw)
        if (patch.blocked) throw new Error('Doctor could not substantiate a source repair')
        if (Object.keys(patch).some(k => !['description', 'search', 'replace', 'reason'].includes(k))
            || !['description', 'search', 'replace', 'reason'].every(k => typeof patch[k] === 'string')
            || !patch.search || source.split(patch.search).length !== 2 || patch.search === patch.replace) throw new Error('Invalid exact Doctor patch')
        if (repairHash(readFileSync(file, 'utf8')) !== sourceHash) throw new Error('Source changed during Doctor generation')
        const result = await evolve({ ...patch, file: profile.file, reproductionTest: profile.reproductionTest, repairProfileId: profile.id })
        if (!result.queued || !result.proposalId) throw new Error(result.error || 'Isolated verification did not queue a patch')
        coordinator.finishRepair(item.id, { status: 'queued', runId, proposalId: result.proposalId }, item.observationHash!)
    } catch (error) {
        coordinator.finishRepair(item.id, { status: 'blocked', runId, reason: redactSecrets(String(error)).slice(0, 500) }, item.observationHash!)
    } finally { clearTimeout(timer) }
}

/** Only the shared approval boundary stores signed-controller-verified receipts.
 * A completed investigation or an arbitrary stage evidence string cannot heal. */
export function reconcileDoctorRepairs(coordinator: FailureResearchCoordinator): void {
    for (const item of coordinator.list().filter(c => c.repair?.proposalId)) {
        const proposal = getPatchProposals(200).find(p => p.id === item.repair!.proposalId)
        if (proposal?.status === 'applied' && proposal.signedActivation) {
            try {
                const receipt = verifyRepairValue<RepairReceipt>(proposal.signedActivation, process.env.XAVENTRA_REPAIR_CONTROLLER_PUBLIC_KEY || '')
                if (receipt.status === 'resolved' && repairHash(receipt.binding) === repairHash(proposal.ticket)) {
                    coordinator.resolveRepair(item.id, proposal.id, proposal.signedActivation)
                }
            } catch { /* forged or no longer trusted receipt cannot close a case */ }
        }
    }
}
