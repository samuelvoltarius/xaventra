import { existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { protectControllerDirectory, readProtectedControllerFile } from './repair-controller-files.js'
import { writeUpdateState } from '../core/update-store.js'
import { repairHash, type RepairBinding, type RepairTicket } from './repair-activation.js'
import { verifyNativeReadOnlyMount, type NativeStateMountProfile } from './native-state-mount.js'
import { createNativeStateCopyScript } from './docker-repair-state.js'
import type { NativeSnapshot } from './native-update-driver.js'

export interface SnapshotEnrollment {
    root: string; sourceStateId: string; candidateStateId: string
    sourceMount: NativeStateMountProfile; destination: string; binding: RepairBinding
}
interface SnapshotOperations {
    // Trusted adapter only: signature/lease, clean stopped writers and external
    // quiescence. The caller also retains the canonical activation lock.
    fenced(ticket: RepairTicket, phase: 'snapshot' | 'baseline'): Promise<boolean>
    copy(): Promise<{ sourceHash: string; copyHash: string; sourceAfterHash: string }>
    hash(path: string): Promise<string>
}
/** Durable sub-operation journal, NOT a second activation controller. Enrolled
 * IDs/paths only. Ambiguous intent is retained and never recopied automatically. */
export class NativeSnapshotStore {
    constructor(private config: SnapshotEnrollment, private ops: SnapshotOperations) {
        protectControllerDirectory(config.root)
        createNativeStateCopyScript(config.sourceMount.path, config.destination) // Validate disjoint paths.
        if (!config.sourceStateId || !config.candidateStateId || config.sourceStateId === config.candidateStateId) throw Error('Independent snapshot states required')
    }
    private paths(t: RepairTicket) {
        const { attemptId, expiresAt, ...binding } = t
        if (!/^repair-[a-f0-9-]{36}$/.test(attemptId) || repairHash(binding) !== repairHash(this.config.binding)) throw Error('Snapshot ticket binding mismatch')
        const identity = repairHash({ ticket: t, enrollment: this.config })
        return { identity, receipt: join(this.config.root, `${identity}.snapshot.json`), lock: join(this.config.root, 'snapshot.lock') }
    }
    private async guard(t: RepairTicket, phase: 'snapshot' | 'baseline' = 'snapshot') {
        if (!Number.isSafeInteger(t.expiresAt) || t.expiresAt <= Date.now() || !await this.ops.fenced(t, phase) || t.expiresAt <= Date.now()) throw Error('Snapshot authority or writer fence lost')
        protectControllerDirectory(this.config.root)
        return verifyNativeReadOnlyMount(this.config.sourceMount)
    }
    private read(path: string, identity: string): NativeSnapshot {
        const r = JSON.parse(readProtectedControllerFile(path, true))
        if (r.identity !== identity || r.status !== 'complete') throw Error('Snapshot intent requires reconciliation')
        const p = r.proof
        if (!p || p.sourceStateId !== this.config.sourceStateId || p.candidateStateId !== this.config.candidateStateId
            || !/^[a-f0-9]{64}$/.test(p.sourceHash) || p.sourceHash !== p.copyHash || p.sourceHash !== p.sourceAfterHash
            || p.sourceReadOnly !== true) throw Error('Invalid snapshot receipt')
        return p
    }
    private release(lock: string, identity: string) {
        const owner = join(lock, 'owner.json')
        if (!existsSync(owner) || JSON.parse(readProtectedControllerFile(owner, true)).identity !== identity) return
        unlinkSync(owner); rmdirSync(lock)
    }
    async snapshot(t: RepairTicket, expectedSourceHash?: string): Promise<NativeSnapshot> {
        if (expectedSourceHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedSourceHash)) throw Error('Invalid expected snapshot hash')
        const p = this.paths(t), before = await this.guard(t)
        if (existsSync(p.receipt)) {
            const proof = this.read(p.receipt, p.identity)
            if (expectedSourceHash !== undefined && proof.sourceHash !== expectedSourceHash) throw Error('Snapshot original hash mismatch')
            if (proof.bindingHash !== repairHash(t) || await this.ops.hash(this.config.sourceMount.path) !== proof.sourceHash
                || await this.ops.hash(this.config.destination) !== proof.copyHash) throw Error('Snapshot replay state changed')
            if (repairHash(await this.guard(t)) !== repairHash(before)) throw Error('Snapshot mount changed')
            this.release(p.lock, p.identity)
            return proof
        }
        mkdirSync(p.lock, { mode: 0o700 })
        writeUpdateState(join(p.lock, 'owner.json'), { identity: p.identity })
        writeUpdateState(p.receipt, { identity: p.identity, status: 'intent' })
        // Failure anywhere below retains both intent and lock. No retry of copy.
        if (repairHash(await this.guard(t)) !== repairHash(before)) throw Error('Snapshot mount changed')
        const copied = await this.ops.copy()
        if (expectedSourceHash !== undefined && copied.sourceHash !== expectedSourceHash) throw Error('Snapshot original hash mismatch')
        if (!/^[a-f0-9]{64}$/.test(copied.sourceHash) || copied.sourceHash !== copied.copyHash || copied.sourceHash !== copied.sourceAfterHash
            || await this.ops.hash(this.config.sourceMount.path) !== copied.sourceHash || await this.ops.hash(this.config.destination) !== copied.copyHash) throw Error('Snapshot hash mismatch')
        if (repairHash(await this.guard(t)) !== repairHash(before)) throw Error('Snapshot mount changed')
        const proof: NativeSnapshot = { ...copied, bindingHash: repairHash(t), sourceStateId: this.config.sourceStateId,
            candidateStateId: this.config.candidateStateId, sourceReadOnly: true }
        writeUpdateState(p.receipt, { identity: p.identity, status: 'complete', mount: before, proof })
        this.release(p.lock, p.identity)
        return proof
    }
    async baselineUnchanged(t: RepairTicket): Promise<boolean> {
        return await this.verifiedBaseline(t) !== null
    }
    /** Revalidated original receipt, never a new hash chosen by the caller. */
    async verifiedBaseline(t: RepairTicket): Promise<NativeSnapshot | null> {
        const p = this.paths(t), before = await this.guard(t, 'baseline'), proof = this.read(p.receipt, p.identity)
        const unchanged = proof.bindingHash === repairHash(t) && await this.ops.hash(this.config.sourceMount.path) === proof.sourceHash
        return repairHash(await this.guard(t, 'baseline')) === repairHash(before) && unchanged ? proof : null
    }
}
