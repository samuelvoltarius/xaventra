/** Source proposals never mutate the running checkout. Approval creates a
 * signed, content-bound activation request for an external surviving controller. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { assertPatchSourcePath, validatePatchInSandbox, getPatchSnapshotHash, type PatchSandboxResult } from './patch-sandbox.js'
import { repairHash, repairRpcEnvelope, signRepairValue, verifyRepairValue, type SignedRepairValue, type RepairTicket, type RepairReceipt } from '../doctor/repair-activation.js'

export interface EvolutionRequest {
    file: string; description: string; search: string; replace: string; reason?: string
    apply?: boolean; approvalToken?: string; reproductionTest?: string
    proposalId?: string; repairProfileId?: string
}
export interface EvolutionResult {
    success: boolean; queued?: boolean; proposalId?: string; branch?: string
    buildOutput?: string; error?: string; rollbackPerformed?: boolean; duration?: number
    activationPending?: boolean; attemptId?: string
}
interface EvolutionLogEntry { timestamp: number; request: EvolutionRequest; result: EvolutionResult; branch: string }
export interface RepairProfile {
    id: string; findingId: string; file: string; reproductionTest: string; probeId: string; targetId: string
}
const ROOT = process.env.XAVENTRA_REPAIR_SOURCE_ROOT || process.cwd(), DATA = join(process.cwd(), '.nova-data')
const PROPOSALS = join(DATA, 'patch-proposals.json'), LOG = join(DATA, 'evolution-log.json')
let activeEvolution: string | null = null
function readArray(path: string): any[] {
    if (!existsSync(path)) return []
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(value)) throw new Error('Invalid persisted repair state')
    return value
}
export function getRepairProfiles(): RepairProfile[] { return readArray(join(DATA, 'self-doctor', 'repair-profiles.json')) }
export function getRepairSourceRoot(): string { return ROOT }
function patchFields(request: EvolutionRequest) {
    return { file: request.file, description: request.description, search: request.search, replace: request.replace,
        reason: request.reason || '', reproductionTest: request.reproductionTest, repairProfileId: request.repairProfileId }
}
function logEvolution(request: EvolutionRequest, result: EvolutionResult) {
    const { approvalToken: _secret, ...safe } = patchFields(request) as EvolutionRequest
    atomicWriteJsonSync(LOG, [...readArray(LOG), { timestamp: Date.now(), request: safe, result, branch: '' }].slice(-100))
}

export async function evolve(request: EvolutionRequest): Promise<EvolutionResult> {
    if (activeEvolution) return { success: false, error: 'Evolution bereits aktiv; Sandbox oder Freigabe läuft.' }
    activeEvolution = `repair-${randomUUID()}`
    const started = Date.now()
    try {
        if (request.apply) return await approveEvolutionProposal(request.proposalId || '', request.approvalToken || '', request)
        assertPatchSourcePath(ROOT, request.file)
        const original = readFileSync(join(ROOT, request.file), 'utf8')
        if (!request.search || request.search === request.replace || original.split(request.search).length !== 2) throw new Error('Patch requires one unique exact replacement')
        const sandbox = await validatePatchInSandbox({ projectRoot: ROOT, ...patchFields(request) })
        if (!sandbox.verified) return { success: false, error: `Sandbox verification failed; patch was not queued: ${sandbox.output.slice(-1000)}`, buildOutput: sandbox.output }
        const profile = request.repairProfileId ? getRepairProfiles().find(p => p.id === request.repairProfileId) : undefined
        if (request.repairProfileId && (!profile || profile.file !== request.file || profile.reproductionTest !== request.reproductionTest)) throw new Error('Repair profile does not match candidate')
        const fields = patchFields(request), id = `patch_${randomUUID()}`
        const proposal = { ...fields, id, createdAt: Date.now(), status: 'queued', sandbox,
            patchHash: repairHash(fields), profile: profile ? structuredClone(profile) : undefined }
        atomicWriteJsonSync(PROPOSALS, [...readArray(PROPOSALS), proposal].slice(-200))
        return { success: false, queued: true, proposalId: id, error: `PATCH_GATE: ${id} queued; no production change.`, duration: Date.now() - started }
    } catch (error) { return { success: false, error: String(error), duration: Date.now() - started } }
    finally { activeEvolution = null }
}

/** Shared slash/Telegram/tool approval boundary. Unbound apply requests are
 * refused, never interpreted as permission for a different patch. */
export async function approveEvolutionProposal(id: string, approvalToken: string, expectedRequest?: EvolutionRequest): Promise<EvolutionResult> {
    const expected = process.env.NOVA_PATCH_GATE_TOKEN
    if (!expected || approvalToken !== expected) return { success: false, error: 'PATCH_GATE token invalid' }
    const proposals = readArray(PROPOSALS), proposal = proposals.find(p => p.id === id)
    if (!proposal || proposal.kind === 'doctor-config' || proposal.status !== 'queued') return { success: false, error: 'A queued source proposalId is required' }
    const fail = (error: string): EvolutionResult => ({ success: false, proposalId: id, error })
    if (expectedRequest && repairHash(patchFields(expectedRequest)) !== proposal.patchHash) return fail('Approved patch fields differ from queued proposal')
    if (repairHash(patchFields(proposal)) !== proposal.patchHash) return fail('Queued patch integrity mismatch')
    const profile = getRepairProfiles().find(p => p.id === proposal.repairProfileId)
    if (!profile || repairHash(profile) !== repairHash(proposal.profile)) return fail('Operator repair profile / independent live probe missing or changed')
    // Never stash, checkout, merge or overwrite user work.
    if (execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim()) return fail('Dirty source checkout; activation refused without touching user changes')
    if (getPatchSnapshotHash(ROOT) !== proposal.sandbox.baselineHash) return fail('Source changed since sandbox validation')
    const sandbox: PatchSandboxResult = proposal.sandbox
    if (!sandbox.verified || !sandbox.cleanupVerified || !sandbox.rollbackPassed || !sandbox.recoveryPassed || !sandbox.reproductionPassed
        || !/^[a-f0-9]{64}$/.test(sandbox.candidateHash || '')) return fail('Complete isolated regression/rollback evidence required')
    const url = process.env.XAVENTRA_REPAIR_CONTROLLER_URL, publicKey = process.env.XAVENTRA_REPAIR_CONTROLLER_PUBLIC_KEY
    const privateKey = process.env.XAVENTRA_REPAIR_APPROVAL_PRIVATE_KEY
    if (!url || !publicKey || !privateKey) return fail('External repair controller and separate signing identity are not configured; no activation')
    const ticket: RepairTicket = { proposalId: id, patchHash: proposal.patchHash, baselineHash: sandbox.baselineHash!, candidateHash: sandbox.candidateHash!,
        probeId: profile.probeId, targetId: profile.targetId, attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 5 * 60_000 }
    const signed = signRepairValue(ticket, privateKey)
    // Persist before dispatch: an ambiguous timeout cannot authorize a retry.
    proposal.status = 'activation-pending'; proposal.ticket = ticket
    atomicWriteJsonSync(PROPOSALS, proposals)
    try {
        const receipt = await repairRpcEnvelope<RepairReceipt>(url, { operation: 'activate', ticket: signed }, publicKey, 120_000)
        return recordActivationReceipt(id, receipt)
    } catch {
        return { success: false, activationPending: true, proposalId: id, attemptId: ticket.attemptId,
            error: 'Activation submitted; terminal signed receipt not verified. Reconcile with /patch status; do not retry deployment.' }
    }
}

function recordActivationReceipt(id: string, envelope: SignedRepairValue<RepairReceipt>): EvolutionResult {
    const receipt = verifyRepairValue(envelope, process.env.XAVENTRA_REPAIR_CONTROLLER_PUBLIC_KEY || '')
    const proposals = readArray(PROPOSALS), proposal = proposals.find(p => p.id === id)
    if (!proposal?.ticket || repairHash(receipt.binding) !== repairHash(proposal.ticket)) throw new Error('Activation receipt binding mismatch')
    const resolved = receipt.status === 'resolved' && receipt.before?.state === 'fault' && receipt.after?.state === 'healthy'
        && receipt.before.releaseId === receipt.previousReleaseId && receipt.after.releaseId === receipt.releaseId
        && receipt.before.probeId === proposal.profile.probeId && receipt.after.probeId === proposal.profile.probeId
        && receipt.before.targetId === proposal.profile.targetId && receipt.after.targetId === proposal.profile.targetId
        && receipt.after.observedAt >= receipt.before.observedAt && receipt.after.challenge !== receipt.before.challenge
    if (receipt.status === 'resolved' && !resolved) throw new Error('Live recovery evidence incomplete')
    proposal.status = resolved ? 'applied' : ['rolled-back', 'blocked'].includes(receipt.status) ? receipt.status : 'activation-pending'
    proposal.activation = receipt
    proposal.signedActivation = envelope
    atomicWriteJsonSync(PROPOSALS, proposals)
    const result: EvolutionResult = { success: resolved, activationPending: proposal.status === 'activation-pending', proposalId: id,
        attemptId: receipt.binding.attemptId, rollbackPerformed: receipt.status === 'rolled-back', error: receipt.reason }
    logEvolution(proposal, result)
    return result
}
export async function reconcileRepairActivations(): Promise<void> {
    const url = process.env.XAVENTRA_REPAIR_CONTROLLER_URL, key = process.env.XAVENTRA_REPAIR_CONTROLLER_PUBLIC_KEY
    if (!url || !key) return
    for (const proposal of readArray(PROPOSALS).filter(p => p.status === 'activation-pending').slice(0, 1)) {
        const receipt = await repairRpcEnvelope<RepairReceipt>(url, { operation: 'status', attemptId: proposal.ticket.attemptId }, key)
        recordActivationReceipt(proposal.id, receipt)
    }
}
export function getEvolutionHistory(limit = 20): EvolutionLogEntry[] { try { return readArray(LOG).slice(-limit) } catch { return [] } }
export function getEvolutionStats() {
    const history = getEvolutionHistory(100)
    return { total: history.length, successful: history.filter(h => h.result.success).length, failed: history.filter(h => !h.result.success).length,
        lastEvolution: history.length ? new Date(history.at(-1)!.timestamp).toISOString() : undefined }
}
export function getPatchProposals(limit = 20): any[] { try { return readArray(PROPOSALS).slice(-limit) } catch { return [] } }
export function isEvolutionActive(): boolean { return activeEvolution !== null }
export function getActiveEvolution(): string | null { return activeEvolution }
export default { evolve, getEvolutionHistory, getEvolutionStats, getPatchProposals, isEvolutionActive, getActiveEvolution }
