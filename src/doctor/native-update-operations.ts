import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repairHash, type RepairTicket } from './repair-activation.js'
import { NativeSystemdService } from './native-systemd-service.js'
import { NativeReleaseSelection, type NativeSelectedRelease } from './native-release-selection.js'
import { NativeSnapshotAdapter, type NativeSnapshotAdapterEnrollment } from './native-snapshot-adapter.js'
import { protectControllerDirectory, readProtectedControllerFile } from './repair-controller-files.js'
import { writeUpdateState } from '../core/update-store.js'
import type { NativeRelease, NativeUpdateOperations } from './native-update-driver.js'
import { NativeRollbackState } from './native-rollback-state.js'

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
        const authorityHooks = { authorized:(t:RepairTicket) => this.hasAuthority(t), quiescent:(t:RepairTicket) => this.authority.quiescent(t) }
        if (c.rollback) {
            const r = c.rollback
            if (Object.hasOwn(c.releases,'__rollback') || old.rollbackStateId !== r.stateId
                || !/^[a-f0-9]{64}$/.test(r.unitHash) || [old.unitHash,next.unitHash].includes(r.unitHash)
                || r.process.executable !== old.process.executable || r.process.executableHash !== old.process.executableHash) throw Error('Native rollback program enrollment mismatch')
            this.variants.__rollback = {...old,...r,id:old.id}
            this.rollback = new NativeRollbackState(s,r,authorityHooks)
        } else if (old.rollbackStateId) throw Error('Native rollback enrollment missing')
        this.selector = new NativeReleaseSelection({ root:c.root, unit:s.unit, fragmentPath:s.fragmentPath, releases:this.variants }, t => this.fenced(t))
        this.snapshots = new NativeSnapshotAdapter(s, authorityHooks)
    }
    private bound(t: RepairTicket): boolean {
        const { attemptId, expiresAt, ...binding } = t
        return /^repair-[a-f0-9-]{36}$/.test(attemptId) && Number.isSafeInteger(expiresAt)
            && expiresAt > Date.now() && repairHash(binding) === repairHash(this.config.snapshot.snapshot.binding)
    }
    async hasAuthority(t: RepairTicket): Promise<boolean> {
        return this.bound(t) && await this.authority.authorized(t) && this.bound(t)
    }
    private async fenced(t: RepairTicket): Promise<boolean> {
        return await this.hasAuthority(t) && await this.authority.quiescent(t) && await this.hasAuthority(t)
    }
    private async guard(t: RepairTicket): Promise<void> {
        if (!await this.fenced(t)) throw Error('Native operations authority or fence missing')
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
    async inspect() {
        const key = this.selectedKey(), r = this.variants[key]
        const state = await this.service(key).inspect()
        return { releaseId:r.id,programHash:r.programHash,stateId:r.stateId,running:state.running,cleanStopped:state.cleanStopped }
    }
    async verifyRelease(id: string, t: RepairTicket) {
        this.service(id)
        return await this.hasAuthority(t) && await this.authority.verifyRelease(id,t) && await this.hasAuthority(t)
    }
    async beginMaintenance(t: RepairTicket) {
        if (!await this.hasAuthority(t)) throw Error('Native maintenance authority missing')
        await this.authority.beginMaintenance(t); await this.guard(t)
    }
    quiescent(t: RepairTicket) { return this.fenced(t) }
    async stop(id: string, t: RepairTicket) { await this.guard(t); await this.service(this.selectedKey(id)).stop(() => this.fenced(t)) }
    async snapshot(source: string, candidate: string, t: RepairTicket) {
        if (source !== this.config.baseline || candidate !== this.config.candidate) throw Error('Native snapshot direction mismatch')
        await this.guard(t); return this.snapshots.snapshot(t)
    }
    async baselineUnchanged(source: string, t: RepairTicket) {
        if (source !== this.config.baseline) throw Error('Native rollback source mismatch')
        await this.guard(t); return this.snapshots.baselineUnchanged(t)
    }
    async select(next: string, expected: string, t: RepairTicket) {
        await this.guard(t)
        if (!await this.verifyRelease(next,t)) throw Error('Native release proof missing before selection')
        const from = this.selectedKey(expected), to = this.rollback && next === this.config.baseline ? '__rollback' : next
        if (to === '__rollback') await this.restoreRollback(next,t)
        await this.guard(t); await this.selector.select(to,from,t)
    }
    async restoreRollback(source: string, t: RepairTicket) {
        if (source !== this.config.baseline || !this.rollback) throw Error('Native rollback restoration not enrolled')
        await this.guard(t); return this.rollback.restore(t)
    }
    async start(id: string, t: RepairTicket) {
        await this.guard(t)
        if (!await this.verifyRelease(id,t)) throw Error('Native runtime readiness proof missing')
        const key = this.selectedKey(id), stateId = this.variants[key].stateId
        if (!await this.authority.runtimeReady(id,t,stateId)) throw Error('Native runtime readiness proof missing')
        // A successful unit start is NOT proof of writable independent state.
        await this.guard(t)
        if (this.selectedKey(id) !== key) throw Error('Native selection changed before start')
        await this.service(key).start(() => this.fenced(t))
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
