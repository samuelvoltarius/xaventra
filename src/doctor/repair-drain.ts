import { existsSync, mkdirSync, readFileSync, rmdirSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { repairHash, type RepairTicket } from './repair-activation.js'

export interface DrainAction {
    id: string; actor: string; tool: string; epoch: number; token: string
    state: 'running' | 'settled' | 'uncertain'; bounded: boolean
}
interface DrainState { version: 1; epoch: number; membersHash: string; hold?: RepairTicket; actions: DrainAction[]; completed: string[] }
/** One independently owned durable admission authority. Timeouts, restarts and
 * vanished peers NEVER turn unresolved actions into successful completion. */
export class RepairDrain {
    private state: DrainState
    private readonly file: string
    private readonly lock: string
    private closed = false
    private failed = false
    constructor(root: string, private readonly members: readonly string[]) {
        if (!members.length || new Set(members).size !== members.length || members.some(x => x === 'operator' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(x))) throw Error('Explicit unique drain membership required')
        this.members = Object.freeze([...members])
        mkdirSync(root, { recursive: true }); this.lock = join(root, 'drain-owner.lock'); mkdirSync(this.lock)
        this.file = join(root, 'drain-state.json')
        try {
            this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, epoch: 1, membersHash: repairHash([...members].sort()), actions: [], completed: [] }
            if (this.state.version !== 1 || !Number.isSafeInteger(this.state.epoch) || this.state.epoch < 1
                || this.state.membersHash !== repairHash([...members].sort()) || !Array.isArray(this.state.actions) || !Array.isArray(this.state.completed)
                || this.state.actions.some(a => !members.includes(a.actor) || !['running', 'settled', 'uncertain'].includes(a.state)
                    || !a.id || !a.token || typeof a.bounded !== 'boolean' || !Number.isSafeInteger(a.epoch))) throw Error('Invalid persisted drain state or changed membership')
            this.save()
        } catch (error) { rmdirSync(this.lock); throw error }
    }
    private ensureOpen() { if (this.closed || this.failed) throw Error('Drain authority closed or persistence uncertain') }
    private save() {
        this.ensureOpen()
        try {
            atomicWriteJsonSync(this.file, this.state)
            const file = openSync(this.file, 'r+')
            try { fsyncSync(file) } finally { closeSync(file) }
            // Production authority is Linux; persist the directory rename before
            // granting execution. Windows cannot fsync directories this way.
            if (process.platform !== 'win32') {
                const directory = openSync(join(this.file, '..'), 'r')
                try { fsyncSync(directory) } finally { closeSync(directory) }
            }
        } catch (error) { this.failed = true; throw error }
    }
    admit(actor: string, id: string, tool: string, bounded = false): DrainAction {
        this.ensureOpen()
        if (!this.members.includes(actor) || !/^[a-f0-9-]{36}$/.test(id) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(tool)) throw Error('Invalid drain admission')
        if (this.state.hold) throw Error('Repair maintenance active; new actions are paused')
        // A reply lost in transit is ambiguous, not authorization to execute twice.
        if (this.state.actions.some(a => a.id === id)) throw Error('Action ID already used; reconcile, never replay')
        if (this.state.actions.length >= 100_000) throw Error('Drain ledger capacity reached; archive through operator recovery')
        const action: DrainAction = { id, actor, tool, epoch: this.state.epoch, token: randomUUID(), state: 'running', bounded }
        this.state.actions.push(action); this.save(); return structuredClone(action)
    }
    settle(actor: string, id: string, token: string, epoch: number, certain: boolean): void {
        this.ensureOpen()
        const action = this.state.actions.find(a => a.id === id)
        if (!action || action.actor !== actor || action.token !== token || action.epoch !== epoch) throw Error('Stale or foreign completion fence')
        const next = certain && action.bounded ? 'settled' : 'uncertain'
        if (action.state !== 'running' && action.state !== next) throw Error('Uncertain completion requires independent reconciliation')
        action.state = next; this.save()
    }
    begin(ticket: RepairTicket): void {
        this.ensureOpen()
        if (!/^repair-[a-f0-9-]{36}$/.test(ticket?.attemptId || '') || ![ticket?.patchHash, ticket?.baselineHash, ticket?.candidateHash].every(h => /^[a-f0-9]{64}$/.test(h || ''))
            || !ticket.proposalId || !ticket.probeId || !ticket.targetId || !Number.isFinite(ticket.expiresAt)
            || ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 600_000) throw Error('Invalid drain repair ticket')
        if (this.state.completed.includes(repairHash(ticket))) throw Error('Completed maintenance ticket cannot replay')
        if (this.state.hold) { if (repairHash(this.state.hold) !== repairHash(ticket)) throw Error('Another repair owns maintenance'); return }
        this.state.hold = structuredClone(ticket); this.state.epoch++; this.save()
    }
    status(ticket: RepairTicket) {
        this.ensureOpen()
        const matching = this.state.hold && repairHash(this.state.hold) === repairHash(ticket)
        const pending = this.state.actions.filter(a => a.state !== 'settled')
        return { bindingHash: repairHash(ticket), epoch: this.state.epoch, membersHash: this.state.membersHash,
            toolActionsDrained: Boolean(matching && ticket.expiresAt > Date.now() && pending.length === 0),
            pending: pending.length, uncertain: pending.filter(a => a.state === 'uncertain').length,
            // Never promote tool admission to a claim about background processes or remote APIs.
            externalWritersQuiesced: false as const }
    }
    /** Only the trusted operator/controller calls this after verifying the
     * independent recovery receipt. Neither nodes nor an elapsed TTL release it. */
    release(ticket: RepairTicket): void {
        this.ensureOpen()
        // A lost release reply can be reconciled with the same signed receipt;
        // this must never open a subsequent maintenance owner's hold.
        if (this.state.completed.includes(repairHash(ticket))) return
        if (!this.state.hold || repairHash(this.state.hold) !== repairHash(ticket) || this.state.actions.some(a => a.state !== 'settled')) throw Error('Maintenance cannot be released with uncertain work or wrong ownership')
        this.state.completed.push(repairHash(ticket)); delete this.state.hold; this.state.epoch++; this.save()
    }
    close(): void { if (!this.closed) { this.closed = true; if (!this.failed) rmdirSync(this.lock) } }
}
