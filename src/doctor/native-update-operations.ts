import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repairHash, type RepairTicket } from './repair-activation.js'
import { NativeSystemdService } from './native-systemd-service.js'
import { NativeReleaseSelection, type NativeSelectedRelease } from './native-release-selection.js'
import { NativeSnapshotAdapter, type NativeSnapshotAdapterEnrollment } from './native-snapshot-adapter.js'
import { protectControllerDirectory, readProtectedControllerFile } from './repair-controller-files.js'
import { writeUpdateState } from '../core/update-store.js'
import type { NativeRelease, NativeStepOptions, NativeUpdateOperations } from './native-update-driver.js'
import { NativeRollbackState } from './native-rollback-state.js'
import { updateRollbackDeadline } from '../core/update-activation.js'

export interface NativeOperationsEnrollment {
    root: string; targetId: string; baseline: string; candidate: string
    releases: Record<string, NativeRelease & NativeSelectedRelease>
    snapshot: NativeSnapshotAdapterEnrollment
    rollback?: NativeSelectedRelease & { root: string; destination: string; stateId: string }
}
/** Independent operator-owned proofs, not values inferred from a service being
 * alive. runtimeReady must verify the enrolled writable runtime/rollback state;
 * it must never thaw the preserved snapshot or silently migrate storage. */
export interface NativeOperationsAuthority {
    authorized(ticket: RepairTicket): Promise<boolean>
    /** Optional separate lease check for rollback steps (ticket may be expired within
     * the bounded rollback grace). Without it, `authorized` is asked for rollback too. */
    rollbackAuthorized?(ticket: RepairTicket): Promise<boolean>
    quiescent(ticket: RepairTicket): Promise<boolean>
    beginMaintenance(ticket: RepairTicket): Promise<void>
    verifyRelease(id: string, ticket: RepairTicket): Promise<boolean>
    runtimeReady(id: string, ticket: RepairTicket, stateId: string): Promise<boolean>
}

/** Concrete component composition under UpdateActivationController's lock.
 * There is deliberately no default authority, publisher proof or storage gate.
 * This class does not enroll a host or implement a second activation lifecycle. */
export class EnrolledNativeUpdateOperations implements NativeUpdateOperations {
    private config: NativeOperationsEnrollment
    private selector: NativeReleaseSelection
    private snapshots: NativeSnapshotAdapter
    private rollback?: NativeRollbackState
    private variants: Record<string, NativeRelease & NativeSelectedRelease>
    constructor(config: NativeOperationsEnrollment, private authority: NativeOperationsAuthority) {
        this.config = structuredClone(config)
        const c = this.config, old = c.releases[c.baseline], next = c.releases[c.candidate], s = c.snapshot
        if (!old || !next || c.baseline === c.candidate || Object.keys(c.releases).length !== 2
            || old.id !== c.baseline || next.id !== c.candidate || next.previousReleaseId !== old.id
            || old.stateId !== s.snapshot.sourceStateId || next.stateId !== s.snapshot.candidateStateId
            || old.unitHash !== s.baseline.unitHash || next.unitHash !== s.candidate.unitHash
            || repairHash(old.process) !== repairHash(s.baseline.process) || repairHash(next.process) !== repairHash(s.candidate.process)
            || repairHash(next.binding) !== repairHash(s.snapshot.binding)
            || next.binding.targetId !== c.targetId || old.sourceHash !== next.binding.baselineHash
            || next.sourceHash !== next.binding.candidateHash || next.packageHash !== next.binding.patchHash) throw Error('Native operations enrollment mismatch')
        for (const r of [old, next]) {
            if (![r.sourceHash, r.programHash, r.unitHash].every(h => /^[a-f0-9]{64}$/.test(h))) throw Error('Native operations hash enrollment missing')
        }
        protectControllerDirectory(c.root)
        this.variants = {...c.releases}
        const authorityHooks = { authorized:(t:RepairTicket) => this.hasAuthority(t), quiescent:(t:RepairTicket) => this.authority.quiescent(t),
            rollbackAuthorized:(t:RepairTicket) => this.hasAuthority(t,{rollback:true}) }
        // Restoration into the third state happens only during rollback.
        const rollbackHooks = { authorized:(t:RepairTicket) => this.hasAuthority(t,{rollback:true}), quiescent:(t:RepairTicket) => this.authority.quiescent(t),
            rollbackAuthorized:(t:RepairTicket) => this.hasAuthority(t,{rollback:true}) }
        if (c.rollback) {
            const r = c.rollback
            if (Object.hasOwn(c.releases,'__rollback') || old.rollbackStateId !== r.stateId
                || !/^[a-f0-9]{64}$/.test(r.unitHash) || [old.unitHash,next.unitHash].includes(r.unitHash)
                || r.process.executable !== old.process.executable || r.process.executableHash !== old.process.executableHash) throw Error('Native rollback program enrollment mismatch')
            this.variants.__rollback = {...old,...r,id:old.id}
            this.rollback = new NativeRollbackState(s,r,rollbackHooks)
        } else if (old.rollbackStateId) throw Error('Native rollback enrollment missing')
        this.selector = new NativeReleaseSelection({ root:c.root, unit:s.unit, fragmentPath:s.fragmentPath, releases:this.variants }, (t,rollback) => this.fenced(t,rollback === true))
        this.snapshots = new NativeSnapshotAdapter(s, authorityHooks)
    }
    private bound(t: RepairTicket, rollback = false): boolean {
        const { attemptId, expiresAt, ...binding } = t
        return /^repair-[a-f0-9-]{36}$/.test(attemptId) && Number.isSafeInteger(expiresAt)
            && (rollback ? updateRollbackDeadline(t) : expiresAt) > Date.now() && repairHash(binding) === repairHash(this.config.snapshot.snapshot.binding)
    }
    /** options.rollback: bounded rollback grace; callers below grant it only to
     * rollback-direction steps. Forward steps require an unexpired ticket. */
    async hasAuthority(t: RepairTicket, options?: NativeStepOptions): Promise<boolean> {
        const rollback = options?.rollback === true
        const lease = rollback && this.authority.rollbackAuthorized ? this.authority.rollbackAuthorized.bind(this.authority) : this.authority.authorized.bind(this.authority)
        return this.bound(t, rollback) && await lease(t) && this.bound(t, rollback)
    }
    private async fenced(t: RepairTicket, rollback = false): Promise<boolean> {
        const options: NativeStepOptions | undefined = rollback ? { rollback: true } : undefined
        return await this.hasAuthority(t, options) && await this.authority.quiescent(t) && await this.hasAuthority(t, options)
    }
    private async guard(t: RepairTicket, rollback = false): Promise<void> {
        if (!await this.fenced(t, rollback)) throw Error('Native operations authority or fence missing')
    }
    private service(id: string) {
        const r = this.variants[id], s = this.config.snapshot
        if (!Object.hasOwn(this.variants, id)) throw Error('Unenrolled native release')
        return new NativeSystemdService({ unit:s.unit,fragmentPath:s.fragmentPath,fragmentHash:r.unitHash,process:r.process })
    }
    private selectedKey(expected?: string) {
        const c = this.config, hash = createHash('sha256').update(readProtectedControllerFile(c.snapshot.fragmentPath)).digest('hex')
        const key = Object.keys(this.variants).find(key => this.variants[key].unitHash === hash)
        if (!key || expected && this.variants[key].id !== expected) throw Error('Unenrolled native unit content or release mismatch')
        return key
    }
    /** Rollback direction only: from the enrolled candidate back to the baseline, or
     * (candidate never selected) from the still selected baseline unit to the
     * separately enrolled rollback runtime of that baseline. */
    private rollbackStep(options: NativeStepOptions | undefined, from: string | undefined, to: string | undefined): boolean {
        if (!options) return false
        const source = from === undefined || from === this.config.candidate || from === this.config.baseline && to === this.config.baseline && !!this.rollback
        if (options.rollback !== true || !source || to !== undefined && to !== this.config.baseline) throw Error('Native rollback tolerance outside the rollback direction')
        return true
    }
    async inspect(options?: NativeStepOptions) {
        const key = this.selectedKey(), r = this.variants[key]
        // A failed unit is only observable for the candidate's own unit content in rollback.
        const candidateFailure = this.rollbackStep(options, undefined, undefined) && key === this.config.candidate
        const state = await this.service(key).inspect({ candidateFailure })
        return { releaseId:r.id,programHash:r.programHash,stateId:r.stateId,running:state.running,cleanStopped:state.cleanStopped,
            stopped:state.stopped,failed:state.failed }
    }
    async verifyRelease(id: string, t: RepairTicket, options?: NativeStepOptions) {
        this.service(id)
        // A rollback only ever verifies (and later starts) the enrolled baseline.
        const auth: NativeStepOptions | undefined = this.rollbackStep(options, undefined, id) ? { rollback: true } : undefined
        return await this.hasAuthority(t, auth) && await this.authority.verifyRelease(id,t) && await this.hasAuthority(t, auth)
    }
    async beginMaintenance(t: RepairTicket) {
        if (!await this.hasAuthority(t)) throw Error('Native maintenance authority missing')
        await this.authority.beginMaintenance(t); await this.guard(t)
    }
    quiescent(t: RepairTicket, options?: NativeStepOptions) { return this.fenced(t, options?.rollback === true) }
    async stop(id: string, t: RepairTicket, options?: NativeStepOptions) {
        // A rollback only ever stops the candidate; the baseline stop stays a forward step.
        const rollback = options?.rollback === true && id === this.config.candidate
        await this.guard(t, rollback)
        const key = this.selectedKey(id)
        // Rollback stop of the candidate may end uncleanly; never for the baseline.
        const candidateFailure = rollback && key === this.config.candidate
        await this.service(key).stop(() => this.fenced(t, rollback), { candidateFailure })
    }
    async resetFailed(id: string, t: RepairTicket, options: NativeStepOptions) {
        if (options?.rollback !== true || id !== this.config.candidate) throw Error('Native failure reset only for rollback of the enrolled candidate')
        await this.guard(t, true)
        const key = this.selectedKey(id)
        if (key !== this.config.candidate) throw Error('Native failure reset only for rollback of the enrolled candidate')
        await this.service(key).resetFailed(() => this.fenced(t, true))
    }
    async snapshot(source: string, candidate: string, t: RepairTicket) {
        if (source !== this.config.baseline || candidate !== this.config.candidate) throw Error('Native snapshot direction mismatch')
        await this.guard(t); return this.snapshots.snapshot(t)
    }
    async baselineUnchanged(source: string, t: RepairTicket, options?: NativeStepOptions) {
        if (source !== this.config.baseline) throw Error('Native rollback source mismatch')
        await this.guard(t, options?.rollback === true); return this.snapshots.baselineUnchanged(t)
    }
    async select(next: string, expected: string, t: RepairTicket, options?: NativeStepOptions) {
        const rollback = this.rollbackStep(options, expected, next), candidateFailure = rollback && options.candidateFailure === true
        // Re-selecting the same release (baseline -> its rollback unit) is a rollback
        // step only; the unclean-exit tolerance only applies when leaving the candidate.
        if (!rollback && next === expected || candidateFailure && expected !== this.config.candidate) throw Error('Native rollback tolerance outside the rollback direction')
        const step: NativeStepOptions | undefined = rollback ? { rollback: true } : undefined
        await this.guard(t, rollback)
        if (!await this.verifyRelease(next,t,step)) throw Error('Native release proof missing before selection')
        const from = this.selectedKey(expected), to = this.rollback && next === this.config.baseline ? '__rollback' : next
        if (to === '__rollback') await this.restoreRollback(next,t,step)
        await this.guard(t, rollback); await this.selector.select(to,from,t,{ candidateFailure, rollback })
    }
    async restoreRollback(source: string, t: RepairTicket, options?: NativeStepOptions) {
        if (source !== this.config.baseline || !this.rollback) throw Error('Native rollback restoration not enrolled')
        await this.guard(t, options?.rollback === true); return this.rollback.restore(t)
    }
    async start(id: string, t: RepairTicket, options?: NativeStepOptions) {
        const rollback = this.rollbackStep(options, undefined, id), candidateFailure = rollback && options.candidateFailure === true
        const step: NativeStepOptions | undefined = rollback ? { rollback: true } : undefined
        await this.guard(t, rollback)
        if (!await this.verifyRelease(id,t,step)) throw Error('Native runtime readiness proof missing')
        const key = this.selectedKey(id), stateId = this.variants[key].stateId
        if (!await this.authority.runtimeReady(id,t,stateId)) throw Error('Native runtime readiness proof missing')
        // A successful unit start is NOT proof of writable independent state.
        await this.guard(t, rollback)
        if (this.selectedKey(id) !== key) throw Error('Native selection changed before start')
        await this.service(key).start(() => this.fenced(t, rollback), { candidateFailure })
    }
    saveIntent(value: Parameters<NativeUpdateOperations['saveIntent']>[0]) {
        const c = this.config
        if (!/^repair-[a-f0-9-]{36}$/.test(value.attemptId) || !/^[a-f0-9]{64}$/.test(value.ticketHash)
            || typeof value.rollback !== 'boolean' || !Object.hasOwn(c.releases,value.from)
            || value.to !== (value.rollback ? c.baseline : c.candidate)
            || !value.rollback && value.from !== c.baseline) throw Error('Invalid native switch intent')
        protectControllerDirectory(c.root)
        const path = join(c.root, `${value.attemptId}.${value.rollback ? 'rollback' : 'activate'}.intent.json`)
        if (existsSync(path)) {
            if (repairHash(JSON.parse(readProtectedControllerFile(path,true))) !== repairHash(value)) throw Error('Native switch intent conflict')
            // An intent is not permission to repeat effects. The shared controller
            // and component receipts decide reconciliation; never overwrite it.
            return
        }
        writeUpdateState(path,value)
    }
}
