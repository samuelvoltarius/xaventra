import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { NativeSystemdService, localSystemdTransport } from './native-systemd-service.js'
import type { NativeProcessProfile } from './native-process-identity.js'
import { protectControllerDirectory, readProtectedControllerFile as read } from './repair-controller-files.js'
import { writeUpdateState } from '../core/update-store.js'
import { repairHash, type RepairTicket } from './repair-activation.js'
export interface NativeSelectedRelease { unitFile: string; unitHash: string; process: NativeProcessProfile }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
/** Protected stopped-service unit CAS. Caller holds the shared activation lock.
 * This component never starts/stops a service, acquires a lease or chooses an
 * artifact. Enrollment contains complete operator-approved unit files only. */
export class NativeReleaseSelection {
    constructor(private config: { root: string; unit: string; fragmentPath: string; releases: Record<string, NativeSelectedRelease> },
        private authorized: (ticket: RepairTicket) => Promise<boolean>) {
        this.config = structuredClone(config)
        protectControllerDirectory(config.root)
        protectControllerDirectory(dirname(config.fragmentPath))
    }
    private service(id: string): NativeSystemdService {
        const r = this.config.releases[id]
        if (!r || !/^[a-f0-9]{64}$/.test(r.unitHash)) throw Error('Unknown enrolled native release')
        return new NativeSystemdService({ unit: this.config.unit, fragmentPath: this.config.fragmentPath, fragmentHash: r.unitHash, process: r.process })
    }
    private async stopped(id: string): Promise<void> {
        const state = await this.service(id).inspect()
        if (state.running || !state.cleanStopped) throw Error('Native selection requires clean stopped service')
    }
    private async authority(ticket: RepairTicket): Promise<void> {
        const observed = structuredClone(ticket), binding = repairHash(observed)
        if (ticket.expiresAt <= Date.now() || !await this.authorized(observed)
            || repairHash(observed) !== binding || ticket.expiresAt <= Date.now()) throw Error('Native selection fenced')
    }
    async select(next: string, expected: string, ticket: RepairTicket): Promise<void> {
        ticket = structuredClone(ticket)
        if (!/^repair-[a-f0-9-]{36}$/.test(ticket.attemptId) || next === expected) throw Error('Invalid native selection')
        const old = this.config.releases[expected], candidate = this.config.releases[next]
        if (!old || !candidate || old.unitHash === candidate.unitHash) throw Error('Distinct enrolled native releases required')
        const binding = { ticketHash: repairHash(ticket), next, expected, oldHash: old.unitHash, nextHash: candidate.unitHash }
        // Direction separates activation and rollback within the same attempt.
        const receiptPath = join(this.config.root, `${repairHash(binding)}.selection.json`)
        await this.authority(ticket)
        if (existsSync(receiptPath)) {
            const prior = JSON.parse(read(receiptPath, true))
            if (repairHash(prior.binding) !== repairHash(binding)) throw Error('Native selection replay mismatch')
            // An intent is ambiguous. Never repeat rename/reload after a crash.
            // Independently inspect disk + loaded unit in reconcile(), below.
            if (prior.status !== 'selected') throw Error('Native selection intent requires reconciliation')
            await this.stopped(next); await this.authority(ticket)
            this.releaseLock(repairHash(binding)); return
        }
        const lock = join(this.config.root, 'selection.lock'); mkdirSync(lock, { mode: 0o700 })
        writeUpdateState(join(lock, 'owner.json'), { bindingHash: repairHash(binding) })
        let finished = false
        try {
            await this.stopped(expected)
            const text = read(candidate.unitFile)
            if (hash(text) !== candidate.unitHash || hash(read(this.config.fragmentPath)) !== old.unitHash) throw Error('Native unit CAS mismatch')
            await this.authority(ticket)
            writeUpdateState(receiptPath, { binding, status: 'intent' })
            const temp = `${this.config.fragmentPath}.${randomUUID()}.pending`
            const fd = openSync(temp, 'wx', 0o600)
            try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
            // Check after disk IO and immediately before synchronous replacement.
            await this.stopped(expected); await this.authority(ticket)
            if (hash(read(this.config.fragmentPath)) !== old.unitHash) throw Error('Native unit CAS changed')
            renameSync(temp, this.config.fragmentPath)
            if (process.platform !== 'win32') {
                const directory = openSync(dirname(this.config.fragmentPath), 'r')
                try { fsyncSync(directory) } finally { closeSync(directory) }
            }
            await this.authority(ticket)
            await localSystemdTransport().run(['daemon-reload'])
            await this.stopped(next); await this.authority(ticket)
            writeUpdateState(receiptPath, { binding, status: 'selected' })
            finished = true
        } finally {
            if (finished) this.releaseLock(repairHash(binding))
        }
    }
    /** Read-only reconciliation of an interrupted selection, then durable mark.
     * Does not rename or reload. If the loaded manager differs, stop for operator
     * reconciliation. Releases only a lock owned by this exact selection. */
    async reconcile(next: string, expected: string, ticket: RepairTicket): Promise<void> {
        ticket = structuredClone(ticket)
        const old = this.config.releases[expected], candidate = this.config.releases[next]
        if (!old || !candidate) throw Error('Unknown enrolled native release')
        const binding = { ticketHash: repairHash(ticket), next, expected, oldHash: old.unitHash, nextHash: candidate.unitHash }
        const path = join(this.config.root, `${repairHash(binding)}.selection.json`)
        const prior = JSON.parse(read(path, true))
        if (repairHash(prior.binding) !== repairHash(binding) || !['intent', 'selected'].includes(prior.status)) throw Error('Native reconciliation mismatch')
        await this.authority(ticket); await this.stopped(next); await this.authority(ticket)
        writeUpdateState(path, { binding, status: 'selected' })
        this.releaseLock(repairHash(binding))
    }
    private releaseLock(bindingHash: string): void {
        const lock = join(this.config.root, 'selection.lock'), owner = join(lock, 'owner.json')
        if (!existsSync(owner) || JSON.parse(read(owner, true)).bindingHash !== bindingHash) return
        unlinkSync(owner); rmdirSync(lock)
    }
}
