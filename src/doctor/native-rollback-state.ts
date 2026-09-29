import { resolve } from 'node:path'
import { NativeSnapshotAdapter, type NativeSnapshotAdapterEnrollment } from './native-snapshot-adapter.js'
import { NativeSnapshotStore } from './native-snapshot-store.js'
import { NativeStateHelper } from './native-state-helper.js'
import { createNativeStateCopyScript } from './docker-repair-state.js'
import { repairHash, type RepairTicket } from './repair-activation.js'
import type { NativeSnapshot } from './native-update-driver.js'

/** Restores into a THIRD independently enrolled state, never the live candidate
 * or readonly original. Reuses the durable copy journal and helper; no remount,
 * deletion, service selection/start or second activation controller. The enclosing
 * canonical controller must hold its activation lock for this operation. */
export class NativeRollbackState {
    private original: NativeSnapshotAdapter
    private store: NativeSnapshotStore
    private stateId: string
    constructor(original: NativeSnapshotAdapterEnrollment,
        restore: { root: string; destination: string; stateId: string },
        authority: { authorized(ticket: RepairTicket): Promise<boolean>; quiescent(ticket: RepairTicket): Promise<boolean> }) {
        const c = structuredClone(original), r = structuredClone(restore)
        if (!r.stateId || [c.snapshot.sourceStateId,c.snapshot.candidateStateId].includes(r.stateId)
            || resolve(r.root) === resolve(c.snapshot.root)) throw Error('Independent rollback enrollment required')
        // Also forbid either direction of nesting with the candidate. The store
        // validates separation from the preserved source independently.
        createNativeStateCopyScript(c.snapshot.destination,r.destination)
        this.stateId = r.stateId
        this.original = new NativeSnapshotAdapter(c,authority)
        const helper = new NativeStateHelper({...c.helper,destination:r.destination})
        this.store = new NativeSnapshotStore({...c.snapshot,root:r.root,destination:r.destination,candidateStateId:r.stateId}, {
            fenced: t => this.original.cleanStopped(t), hash:path => helper.hash(path),
            copy: () => helper.copy(),
        })
    }
    private async source(t: RepairTicket): Promise<NativeSnapshot> {
        if (!await this.original.cleanStopped(t)) throw Error('Rollback restore requires clean stopped writer')
        const proof = await this.original.verifiedBaseline(t)
        if (!proof || proof.bindingHash !== repairHash(t)) throw Error('Rollback original baseline changed')
        if (!await this.original.cleanStopped(t)) throw Error('Rollback restore writer fence lost')
        return proof
    }
    async restore(t: RepairTicket): Promise<NativeSnapshot> {
        const before = await this.source(t)
        const restored = await this.store.snapshot(t,before.sourceHash)
        const after = await this.source(t)
        if (repairHash(before) !== repairHash(after) || restored.bindingHash !== before.bindingHash
            || restored.sourceStateId !== before.sourceStateId || restored.candidateStateId !== this.stateId
            || restored.sourceHash !== before.sourceHash || restored.copyHash !== before.sourceHash
            || restored.sourceAfterHash !== before.sourceHash || restored.sourceReadOnly !== true) throw Error('Rollback restore baseline binding mismatch')
        return restored
    }
}
