import { repairHash, type RepairBinding, type RepairTicket, type PreparedRepair, type RepairDeploymentDriver } from './repair-activation.js'

export interface NativeRelease {
    id: string; sourceHash: string; programHash: string; stateId: string
    previousReleaseId?: string; packageHash?: string; binding?: RepairBinding
    rollbackStateId?: string
}
export interface NativeObservation {
    releaseId: string; programHash: string; stateId: string; running: boolean; cleanStopped: boolean
}
export interface NativeSnapshot {
    bindingHash: string; sourceStateId: string; candidateStateId: string
    sourceHash: string; copyHash: string; sourceAfterHash: string; sourceReadOnly: true
}
/** Privileged, operator-owned adapter boundary. Implementations must resolve IDs
 * through protected enrollment, never candidate paths/commands. Not a systemd
 * implementation: production wiring must independently prove these operations.
 * select is a stopped-service CAS; stop/start must confirm actual process exit /
 * readiness. snapshot fences the baseline read-only and persists its receipt.
 * baselineUnchanged validates that receipt and current baseline bytes. */
export interface NativeUpdateOperations {
    hasAuthority(ticket: RepairTicket): Promise<boolean>
    inspect(): Promise<NativeObservation>
    verifyRelease(id: string, ticket: RepairTicket): Promise<boolean>
    beginMaintenance(ticket: RepairTicket): Promise<void>
    quiescent(ticket: RepairTicket): Promise<boolean>
    stop(expected: string, ticket: RepairTicket): Promise<void>
    snapshot(source: string, candidate: string, ticket: RepairTicket): Promise<NativeSnapshot>
    baselineUnchanged(source: string, ticket: RepairTicket): Promise<boolean>
    restoreRollback?(source: string, ticket: RepairTicket): Promise<NativeSnapshot>
    select(next: string, expected: string, ticket: RepairTicket): Promise<void>
    start(expected: string, ticket: RepairTicket): Promise<void>
    saveIntent(value: { attemptId: string; ticketHash: string; from: string; to: string; rollback: boolean }): void
}
/** Uses UpdateActivationController's durable lifecycle, receipt, replay and
 * acceptance gates. No separate updater state machine or implicit retry. */
export class NativeUpdateDriver implements RepairDeploymentDriver {
    constructor(private enrollment: { targetId: string; releases: Record<string, NativeRelease>; catalog: Record<string, string> },
        private ops: NativeUpdateOperations) {}
    async hasAuthority(t: RepairTicket): Promise<boolean> {
        return t.targetId === this.enrollment.targetId && t.expiresAt > Date.now() && await this.ops.hasAuthority(t)
    }
    private async guard(t: RepairTicket, drained = false): Promise<void> {
        if (!await this.hasAuthority(t)) throw Error('Native update authority lost')
        if (drained && !await this.ops.quiescent(t)) throw Error('Native writer fencing missing')
        // Recheck after potentially slow external fencing query.
        if (!await this.hasAuthority(t)) throw Error('Native update authority expired')
    }
    private pair(t: RepairTicket): [NativeRelease, NativeRelease, RepairBinding] {
        const next = this.enrollment.releases[this.enrollment.catalog[t.candidateHash]]
        const old = next && this.enrollment.releases[next.previousReleaseId || '']
        const { attemptId, expiresAt, ...binding } = t
        if (!old || !next || old.id === next.id || this.enrollment.releases[old.id] !== old || this.enrollment.releases[next.id] !== next
            || old.sourceHash !== t.baselineHash || next.sourceHash !== t.candidateHash || next.packageHash !== t.patchHash
            || repairHash(next.binding) !== repairHash(binding)
            || ![old.programHash, next.programHash, t.baselineHash, t.candidateHash, t.patchHash].every(h => /^[a-f0-9]{64}$/.test(h))) throw Error('Native release approval binding mismatch')
        if (!old.stateId || !next.stateId || old.stateId === next.stateId) throw Error('Independent native state required')
        if (old.rollbackStateId !== undefined && (!old.rollbackStateId || [old.stateId,next.stateId].includes(old.rollbackStateId)
            || !this.ops.restoreRollback)) throw Error('Independent rollback state adapter required')
        return [old, next, binding]
    }
    private async observed(expected?: string): Promise<NativeObservation> {
        const value = await this.ops.inspect(), r = this.enrollment.releases[value.releaseId]
        if (!r || (expected && value.releaseId !== expected) || value.programHash !== r.programHash
            || value.stateId !== r.stateId && (!r.rollbackStateId || value.stateId !== r.rollbackStateId)) throw Error('Native runtime identity mismatch')
        return value
    }
    async currentRelease(target: string): Promise<string> {
        if (target !== this.enrollment.targetId) throw Error('Native target mismatch')
        const value = await this.observed()
        if (!value.running) throw Error('Native runtime not running')
        return value.releaseId
    }
    async prepare(t: RepairTicket): Promise<PreparedRepair> {
        await this.guard(t)
        const [old, next, binding] = this.pair(t)
        const baseline = await this.observed(old.id)
        if (!baseline.running || baseline.stateId !== old.stateId) throw Error('Native baseline not running in enrolled source state')
        if (!await this.ops.verifyRelease(old.id, t) || !await this.ops.verifyRelease(next.id, t)) throw Error('Native immutable release verification failed')
        await this.guard(t)
        return { releaseId: next.id, previousReleaseId: old.id, binding }
    }
    async beginMaintenance(t: RepairTicket): Promise<void> {
        await this.guard(t); await this.ops.beginMaintenance(t); await this.guard(t, true)
    }
    private async switch(p: PreparedRepair, t: RepairTicket, rollback: boolean): Promise<void> {
        const [old, next, binding] = this.pair(t)
        if (p.releaseId !== next.id || p.previousReleaseId !== old.id || repairHash(p.binding) !== repairHash(binding)) throw Error('Native prepared identity mismatch')
        await this.guard(t, true)
        const value = await this.observed()
        const from = rollback ? value.releaseId : old.id, to = rollback ? old.id : next.id
        if ((!rollback && (value.releaseId !== old.id || value.stateId !== old.stateId || !value.running)) || (rollback && ![old.id, next.id].includes(value.releaseId))) throw Error('Native ambiguous switch state')
        if (rollback && !await this.ops.baselineUnchanged(old.id, t)) throw Error('Native rollback baseline unverified')
        if (rollback && value.releaseId === old.id && value.running) {
            if (old.rollbackStateId && value.stateId !== old.rollbackStateId) throw Error('Original state is not restored rollback runtime')
            return
        }
        if (!await this.ops.verifyRelease(to, t)) throw Error('Native release verification failed')
        await this.guard(t, true)
        this.ops.saveIntent({ attemptId: t.attemptId, ticketHash: repairHash(t), from, to, rollback })
        if (value.running) await this.ops.stop(from, t)
        await this.guard(t, true)
        const stopped = await this.observed(from)
        if (stopped.running || !stopped.cleanStopped) throw Error('Native clean stop not proven')
        if (rollback) {
            if (!await this.ops.baselineUnchanged(old.id,t)) throw Error('Native rollback baseline changed during stop')
            if (old.rollbackStateId) {
                const proof = await this.ops.restoreRollback(old.id,t)
                if (proof.bindingHash !== repairHash(t) || proof.sourceStateId !== old.stateId || proof.candidateStateId !== old.rollbackStateId
                    || !/^[a-f0-9]{64}$/.test(proof.sourceHash) || proof.sourceHash !== proof.copyHash || proof.sourceHash !== proof.sourceAfterHash
                    || proof.sourceReadOnly !== true) throw Error('Native rollback restore proof mismatch')
            }
        }
        if (!rollback) {
            const proof = await this.ops.snapshot(old.id, next.id, t)
            if (proof.bindingHash !== repairHash(t) || proof.sourceStateId !== old.stateId || proof.candidateStateId !== next.stateId
                || !/^[a-f0-9]{64}$/.test(proof.sourceHash) || proof.sourceHash !== proof.copyHash || proof.sourceHash !== proof.sourceAfterHash
                || proof.sourceReadOnly !== true) throw Error('Native snapshot verification failed')
        }
        await this.guard(t, true)
        if (!await this.ops.verifyRelease(to, t)) throw Error('Native release changed before start')
        await this.guard(t, true)
        await this.ops.select(to, from, t)
        const selected = await this.observed(to), expectedState = rollback ? old.rollbackStateId || old.stateId : next.stateId
        if (selected.running || !selected.cleanStopped || selected.stateId !== expectedState) throw Error('Native selected runtime state mismatch')
        await this.guard(t, true)
        await this.ops.start(to, t)
        const started = await this.observed(to)
        if (!started.running || started.stateId !== expectedState) throw Error('Native start not confirmed')
        await this.guard(t)
    }
    activate(p: PreparedRepair, t: RepairTicket): Promise<void> { return this.switch(p, t, false) }
    rollback(p: PreparedRepair, t: RepairTicket): Promise<void> { return this.switch(p, t, true) }
}
