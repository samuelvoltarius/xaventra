import { createHash } from 'node:crypto'
import { NativeSnapshotStore, type SnapshotEnrollment } from './native-snapshot-store.js'
import { NativeStateHelper, type NativeStateHelperProfile } from './native-state-helper.js'
import { NativeSystemdService } from './native-systemd-service.js'
import { readProtectedControllerFile } from './repair-controller-files.js'
import type { NativeProcessProfile } from './native-process-identity.js'
import type { RepairTicket } from './repair-activation.js'

export interface NativeSnapshotAdapterEnrollment {
    snapshot: SnapshotEnrollment; helper: NativeStateHelperProfile
    unit: string; fragmentPath: string
    baseline: { unitHash: string; process: NativeProcessProfile }
    candidate: { unitHash: string; process: NativeProcessProfile }
}
/** Composition only: no stop/start/remount or second authority. Enrolled unit
 * content selects an existing service observer, never a guessed process. */
export class NativeSnapshotAdapter {
    private config: NativeSnapshotAdapterEnrollment
    private store: NativeSnapshotStore
    constructor(config: NativeSnapshotAdapterEnrollment, private authority: {
        authorized(ticket: RepairTicket): Promise<boolean>
        quiescent(ticket: RepairTicket): Promise<boolean>
    }) {
        this.config = structuredClone(config)
        const c = this.config
        if (c.helper.source !== c.snapshot.sourceMount.path || c.helper.destination !== c.snapshot.destination
            || c.baseline.unitHash === c.candidate.unitHash) throw Error('Snapshot adapter enrollment mismatch')
        // Validate both fixed profiles up front; no side effects.
        for (const release of [c.baseline,c.candidate]) new NativeSystemdService({ unit:c.unit,fragmentPath:c.fragmentPath,fragmentHash:release.unitHash,process:release.process })
        const helper = new NativeStateHelper(c.helper)
        this.store = new NativeSnapshotStore(c.snapshot, {
            copy: () => helper.copy(), hash: path => helper.hash(path),
            fenced: (ticket,phase) => this.fenced(ticket,phase),
        })
    }
    private async fenced(t: RepairTicket, phase: 'snapshot' | 'baseline' | 'restore'): Promise<boolean> {
        if (!Number.isSafeInteger(t.expiresAt) || t.expiresAt <= Date.now() || !await this.authority.authorized(t)) return false
        const c = this.config, hash = createHash('sha256').update(readProtectedControllerFile(c.fragmentPath)).digest('hex')
        const release = hash === c.baseline.unitHash ? c.baseline : hash === c.candidate.unitHash ? c.candidate : undefined
        if (!release) return false
        // 'baseline' (rehash of the preserved original) and 'restore' (copy into the
        // third state) are rollback-only phases. There, a crashed / uncleanly exited
        // CANDIDATE unit is acceptable as long as provably no process is left
        // (failed or stopped, MainPID 0). The baseline unit and the forward
        // 'snapshot' phase keep requiring a clean stop.
        const candidateFailure = phase !== 'snapshot' && release === c.candidate
        const observe = () => new NativeSystemdService({unit:c.unit,fragmentPath:c.fragmentPath,fragmentHash:release.unitHash,process:release.process}).inspect({ candidateFailure })
        const state = await observe()
        const halted = state.cleanStopped || candidateFailure && !state.running && state.pid === 0 && (state.stopped === true || state.failed === true)
        if (phase === 'snapshot' && (release !== c.baseline || state.running || !state.cleanStopped)) return false
        if (phase === 'restore' && (state.running || !halted)) return false
        // Never treat a running original as a fenced rollback source. A running
        // candidate may be observed while its distinct ro baseline is rehashed.
        if (phase === 'baseline' && (release === c.baseline && state.running || !state.running && !halted)) return false
        if (!await this.authority.quiescent(t)) return false
        // Re-observe after external IO: no service selection/PID/state change
        // may slip between admission and the final authority check.
        const again = await observe()
        return JSON.stringify(state) === JSON.stringify(again) && t.expiresAt > Date.now()
            && await this.authority.authorized(t) && t.expiresAt > Date.now()
    }
    snapshot(ticket: RepairTicket) { return this.store.snapshot(ticket) }
    baselineUnchanged(ticket: RepairTicket) { return this.store.baselineUnchanged(ticket) }
    verifiedBaseline(ticket: RepairTicket) { return this.store.verifiedBaseline(ticket) }
    cleanStopped(ticket: RepairTicket) { return this.fenced(ticket, 'restore') }
}
