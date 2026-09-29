import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeUpdateState as atomicWriteJsonSync } from './update-store.js'
import { repairHash, verifyRepairValue, type SignedRepairValue, type RepairTicket, type RepairDeploymentDriver, type PreparedRepair } from '../doctor/repair-activation.js'

/** Forward activation (stop, snapshot, select, start, verify) is not begun with less
 * remaining ticket time: two bounded systemctl operations alone may take 2 x 35 s. */
export const UPDATE_MIN_ACTIVATION_WINDOW_MS = 90_000
/** Rollback-only grace after ticket expiry. Fixed and derived solely from the signed
 * `expiresAt` (part of the ticket hash), so it cannot be extended by any caller.
 * Forward steps never use it. Total bound: ticket lifetime (<= 600 s) + this grace. */
export const UPDATE_ROLLBACK_GRACE_MS = 15 * 60_000
export function updateRollbackDeadline(ticket: { expiresAt: number }): number {
    return Number.isSafeInteger(ticket.expiresAt) ? ticket.expiresAt + UPDATE_ROLLBACK_GRACE_MS : 0
}
/** A driver may grant rollback-only authority until updateRollbackDeadline(ticket).
 * Without this method rollback keeps requiring the unexpired forward authority. */
export interface UpdateDeploymentDriver extends RepairDeploymentDriver {
    hasRollbackAuthority?(ticket: RepairTicket): Promise<boolean>
}
export interface UpdateActivationReceipt {
    ticket: RepairTicket; status: 'accepted' | 'preparing' | 'activating' | 'verifying' | 'installed' | 'rolled-back' | 'blocked'
    updatedAt: number; releaseId?: string; previousReleaseId?: string; reason?: string
    before?: string; after?: string; restoration?: string
}
/** Routine update acceptance is healthy -> healthy, NOT a fabricated Doctor fault.
 * The driver, authority, probe and this directory belong to a separate supervisor.
 * Durable intent precedes every potentially destructive action. A crash retains
 * the lock and exact IDs; neither a timeout nor a retry authorizes a second swap. */
export class UpdateActivationController {
    constructor(private root: string, private approvalKey: string, private driver: UpdateDeploymentDriver,
        private accept: (releaseId: string, ticket: RepairTicket) => Promise<string>,
        private complete: (receipt: UpdateActivationReceipt) => Promise<void>) { mkdirSync(root, { recursive: true }) }
    status(id: string): UpdateActivationReceipt | undefined {
        if (!/^repair-[a-f0-9-]{36}$/.test(id)) throw Error('Invalid attempt')
        const path = join(this.root, `${id}.json`)
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
    }
    async deploy(signed: SignedRepairValue<RepairTicket>, preparation: unknown): Promise<UpdateActivationReceipt> {
        const t = verifyRepairValue(signed, this.approvalKey)
        if (!/^repair-[a-f0-9-]{36}$/.test(t.attemptId) || !t.proposalId.startsWith('upstream-')
            || ![t.patchHash, t.baselineHash, t.candidateHash].every(h => /^[a-f0-9]{64}$/.test(h))
            || !t.targetId || !t.probeId || t.expiresAt <= Date.now() || t.expiresAt > Date.now() + 600_000) throw Error('Invalid update approval')
        const prior = this.status(t.attemptId)
        if (prior) {
            if (repairHash(prior.ticket) !== repairHash(t)) throw Error('Update replay mismatch')
            // Reconcile completion only; never repeat a container operation.
            if (['installed', 'rolled-back'].includes(prior.status)) {
                await this.finish(prior)
                this.releaseLock(prior.ticket)
            }
            return prior
        }
        const lock = join(this.root, 'activation.lock'); mkdirSync(lock)
        // A persisted owner lets terminal reconciliation release this attempt's
        // lock, never an ambiguous legacy lock or a later activation's lock.
        atomicWriteJsonSync(join(lock, 'owner.json'), { ticketHash: repairHash(t) })
        let r: UpdateActivationReceipt = { ticket: t, status: 'accepted', updatedAt: Date.now() }, p: PreparedRepair | undefined
        let changed = false, maintenance = false, finalized = false
        const save = () => { r.updatedAt = Date.now(); atomicWriteJsonSync(join(this.root, `${t.attemptId}.json`), r) }
        const authority = async () => { if (Date.now() >= t.expiresAt || !await this.driver.hasAuthority(t)) throw Error('Update authority lost') }
        // Rollback only: an expired ticket must not strand a stopped service, but the
        // grace is bounded and still requires the driver's current lease/fencing.
        const rollbackAuthority = async () => {
            if (Date.now() >= updateRollbackDeadline(t)) throw Error('Rollback authority window closed')
            const granted = this.driver.hasRollbackAuthority ? await this.driver.hasRollbackAuthority(t)
                : Date.now() < t.expiresAt && await this.driver.hasAuthority(t)
            if (!granted || Date.now() >= updateRollbackDeadline(t)) throw Error('Rollback authority lost')
        }
        const activationWindow = () => { if (t.expiresAt - Date.now() < UPDATE_MIN_ACTIVATION_WINDOW_MS) throw Error('Update ticket window too short for activation') }
        try {
            save(); await authority()
            r.status = 'preparing'; save()
            p = await this.driver.prepare(t, preparation)
            const { attemptId: _id, expiresAt: _expiry, ...binding } = t
            if (repairHash(p.binding) !== repairHash(binding) || !p.releaseId || !p.previousReleaseId || p.releaseId === p.previousReleaseId) throw Error('Prepared update binding mismatch')
            r.releaseId = p.releaseId; r.previousReleaseId = p.previousReleaseId; save()
            if (await this.driver.currentRelease(t.targetId) !== p.previousReleaseId) throw Error('Baseline changed')
            r.before = await this.accept(p.previousReleaseId, t)
            if (!r.before) throw Error('Baseline acceptance missing')
            activationWindow()
            maintenance = true; await this.driver.beginMaintenance?.(t); await authority(); activationWindow()
            r.status = 'activating'; save(); changed = true
            await this.driver.activate(p, t); await authority()
            r.status = 'verifying'; save()
            if (await this.driver.currentRelease(t.targetId) !== p.releaseId) throw Error('Candidate identity mismatch')
            r.after = await this.accept(p.releaseId, t)
            if (!r.after) throw Error('Candidate acceptance missing')
            await authority(); r.status = 'installed'; save()
        } catch (error) {
            atomicWriteJsonSync(join(this.root, `${t.attemptId}.diagnostic.json`), { phase: r.status, error: String(error).slice(0, 1000) })
            r.reason = 'Update failed; inspect protected controller evidence'
            if (changed && p) {
                try {
                    await rollbackAuthority(); await this.driver.rollback(p, t)
                    if (await this.driver.currentRelease(t.targetId) !== p.previousReleaseId) throw Error('Rollback identity mismatch')
                    r.restoration = await this.accept(p.previousReleaseId, t)
                    if (!r.restoration || r.restoration !== r.before) throw Error('Restoration acceptance mismatch')
                    r.status = 'rolled-back'
                } catch (error) {
                    atomicWriteJsonSync(join(this.root, `${t.attemptId}.rollback-diagnostic.json`), { phase: r.status, error: String(error).slice(0, 1000) })
                    r.status = 'blocked'; r.reason = 'Rollback unverified; retained activation lock, reconcile exact container IDs'
                }
            } else r.status = 'blocked'
            save()
        }
        try {
            if (['installed', 'rolled-back'].includes(r.status)) { await this.finish(r); finalized = true }
        } finally {
            // Failed drain might already have changed external admission. Retain
            // ownership until independently reconciled, even before container stop.
            if (!maintenance || finalized) this.releaseLock(t)
        }
        return r
    }
    private releaseLock(ticket: RepairTicket): void {
        const lock = join(this.root, 'activation.lock'), owner = join(lock, 'owner.json')
        if (!existsSync(owner)) return // Unknown ownership remains fail-closed.
        const identity = JSON.parse(readFileSync(owner, 'utf8'))
        if (identity.ticketHash !== repairHash(ticket)) return
        unlinkSync(owner)
        rmdirSync(lock)
    }
    private async finish(r: UpdateActivationReceipt): Promise<void> {
        const marker = join(this.root, `${r.ticket.attemptId}.completed.json`)
        if (existsSync(marker)) return
        await this.complete(r)
        atomicWriteJsonSync(marker, { receiptHash: repairHash(r) })
    }
}
