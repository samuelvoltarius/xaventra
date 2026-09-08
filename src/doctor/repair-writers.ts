import { existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { repairHash, type RepairTicket } from './repair-activation.js'
import { dockerRepairConfigHash, type DockerRepairEngine } from './docker-repair-driver.js'

export interface RepairWriterHost {
    id: string; engine: DockerRepairEngine
    /** All explicitly enrolled runtime containers, never discovered stop targets. */
    members: readonly { containerId: string; configHash: string }[]
    staged?: readonly { containerId: string; configHash: string }[]
    /** Canonical Engine mount sources containing state being cloned. */
    protectedSources: readonly string[]
    /** Original rollback sources: a peer may NOT resume writing these. */
    preserveSources?: readonly string[]
}
interface WriterState { ticket: RepairTicket; inventoryHash: string; stopped: { host: string; id: string; wasRunning: boolean }[] }
/** Process-level barrier includes background writers that bypass Tool Registry.
 * Unknown volume sharers or unproven external sinks block BEFORE any stop.
 * Engines for remote hosts must be independently authenticated/pinned by operator. */
export class RepairWriterBarrier {
    private state?: WriterState
    private lock: string
    private file: string
    private inventoryHash: string
    constructor(private readonly options: {
        root: string; hosts: readonly RepairWriterHost[]; requiredHosts: readonly string[]; externalSinks: readonly string[]
        hasAuthority(ticket: RepairTicket): Promise<boolean>
        toolDrain(ticket: RepairTicket): Promise<boolean>
        sinkFenced?(sink: string, ticket: RepairTicket): Promise<boolean>
    }) {
        options.hosts = options.hosts.map(h => ({ ...h, members: structuredClone(h.members), staged: structuredClone(h.staged || []), protectedSources: [...h.protectedSources], preserveSources: [...h.preserveSources || []] }))
        options.requiredHosts = [...options.requiredHosts]; options.externalSinks = [...options.externalSinks]
        if (!options.hosts.length || new Set(options.hosts.map(h => h.id)).size !== options.hosts.length
            || repairHash(options.hosts.map(h => h.id).sort()) !== repairHash([...options.requiredHosts].sort())
            || options.hosts.some(h => !h.members.length || h.members.some(m => !/^[a-f0-9]{64}$/.test(m.containerId) || !/^[a-f0-9]{64}$/.test(m.configHash))
                || new Set(h.members.map(m => m.containerId)).size !== h.members.length
                || h.protectedSources.some(p => !p.startsWith('/') || p === '/' || p.includes('..') || p.includes('\0')))) throw Error('Explicit complete writer-host inventory required')
        this.inventoryHash = repairHash(options.hosts.map(({ id, members, staged, protectedSources, preserveSources }) => ({ id, members, staged, protectedSources, preserveSources })))
        mkdirSync(options.root, { recursive: true }); this.lock = join(options.root, 'writers.lock'); this.file = join(options.root, 'writers.json')
        if (existsSync(this.file)) this.state = JSON.parse(readFileSync(this.file, 'utf8'))
    }
    private async authority(ticket: RepairTicket) {
        if (ticket.expiresAt <= Date.now() || !await this.options.hasAuthority(ticket) || !await this.options.toolDrain(ticket)) throw Error('Writer authority/drain unavailable')
        for (const sink of this.options.externalSinks) if (!await this.options.sinkFenced?.(sink, ticket)) throw Error('External sink has no independently verified write fence')
    }
    private async inventory(): Promise<Map<string, any[]>> {
        const result = new Map<string, any[]>()
        for (const host of this.options.hosts) {
            // List ALL containers: an unlabeled/unknown writer sharing the same
            // protected storage must not disappear behind a label/name filter.
            const listed = await host.engine.call('GET', '/containers/json?all=1')
            if (!Array.isArray(listed) || listed.length > 10_000) throw Error('Unbounded or unavailable writer inventory')
            const entries: any[] = []
            for (const item of listed) {
                if (!/^[a-f0-9]{64}$/.test(item.Id)) throw Error('Invalid writer identity')
                const info = await host.engine.call('GET', `/containers/${item.Id}/json`)
                const enrolled = host.members.find(m => m.containerId === info.Id)
                const overlaps = (info.Mounts || []).some((m: any) => m.RW && host.protectedSources.some(p => {
                    const source = String(m.Source || '').replace(/\/$/, ''), protectedPath = p.replace(/\/$/, '')
                    return source === protectedPath || source.startsWith(protectedPath + '/') || protectedPath.startsWith(source + '/')
                }))
                const staged = host.staged?.find(m => m.containerId === info.Id)
                if (staged && (dockerRepairConfigHash(info) !== staged.configHash || info.State?.Running || info.State?.Paused || info.State?.Restarting
                    || info.HostConfig?.RestartPolicy?.Name !== 'no')) throw Error('Staged container changed or started outside controller')
                if (overlaps && !enrolled && !staged) throw Error('Unenrolled container can write protected state; no automatic stop')
                if (enrolled) {
                    if (dockerRepairConfigHash(info) !== enrolled.configHash || info.HostConfig?.RestartPolicy?.Name !== 'no'
                        || info.State?.Paused || info.State?.Restarting) throw Error('Writer config/restart ownership mismatch')
                    entries.push(info)
                }
            }
            if (entries.length !== host.members.length || host.staged?.some(s => !listed.some(i => i.Id === s.containerId))) throw Error('Enrolled writer or staged candidate missing from host inventory')
            result.set(host.id, entries)
        }
        return result
    }
    async halt(ticket: RepairTicket): Promise<void> {
        if (this.state) {
            if (this.state.inventoryHash !== this.inventoryHash || repairHash(this.state.ticket) !== repairHash(ticket)) throw Error('Previous writer transaction requires reconciliation')
            if (!await this.quiescent(ticket)) throw Error('Prior halt incomplete; reconcile without implicit replay')
            return
        }
        mkdirSync(this.lock)
        let changed = false
        try {
            await this.authority(ticket)
            const inventory = await this.inventory()
            this.state = { ticket: structuredClone(ticket), inventoryHash: this.inventoryHash, stopped: [] }
            for (const host of this.options.hosts) for (const info of inventory.get(host.id)!) {
                await this.authority(ticket)
                // Persist intent BEFORE stop. A timeout remains an owned transaction.
                this.state.stopped.push({ host: host.id, id: info.Id, wasRunning: info.State?.Running === true })
                atomicWriteJsonSync(this.file, this.state); changed = true
                if (info.State?.Running) await host.engine.call('POST', `/containers/${info.Id}/stop?t=20`)
                const after = await host.engine.call('GET', `/containers/${info.Id}/json`)
                if (after.State?.Running || after.State?.Paused || after.State?.Restarting) throw Error('Writer exit unconfirmed')
            }
            if (!await this.quiescent(ticket)) throw Error('Writer quiescence not proven after stop')
        } finally { if (!changed) { this.state = undefined; rmdirSync(this.lock) } }
    }
    async quiescent(ticket: RepairTicket): Promise<boolean> {
        try {
            if (!this.state || this.state.inventoryHash !== this.inventoryHash || repairHash(this.state.ticket) !== repairHash(ticket)
                || this.state.stopped.length !== this.options.hosts.reduce((n, h) => n + h.members.length, 0)) return false
            await this.authority(ticket)
            const inventory = await this.inventory()
            return [...inventory.values()].flat().every(i => !i.State?.Running && !i.State?.Paused && !i.State?.Restarting)
        } catch { return false }
    }
    /** Caller is the independently signed receipt path, not a model/tool. The
     * active repair target is managed by the deployment driver and never started
     * again here. Receipt validation must precede this operator-only operation. */
    async resumePeers(ticket: RepairTicket, targetContainerIds: readonly string[], restoredBaseline = false): Promise<void> {
        if (!this.state || this.state.inventoryHash !== this.inventoryHash || repairHash(this.state.ticket) !== repairHash(ticket)) throw Error('Writer resume ownership mismatch')
        // Validate the entire resumption set before starting any peer.
        for (const record of this.state.stopped) {
            if (!record.wasRunning || targetContainerIds.includes(record.id)) continue
            const host = this.options.hosts.find(h => h.id === record.host)!
            const info = await host.engine.call('GET', `/containers/${record.id}/json`)
            if (!restoredBaseline && (info.Mounts || []).some((m: any) => m.RW && host.preserveSources?.some(p => m.Source === p || m.Source?.startsWith(p + '/') || p.startsWith(m.Source + '/')))) {
                throw Error('Peer shares rollback state; verified replacement/state migration required before resume')
            }
        }
        for (const record of this.state.stopped) {
            if (!record.wasRunning || targetContainerIds.includes(record.id)) continue
            const host = this.options.hosts.find(h => h.id === record.host)!, member = host.members.find(m => m.containerId === record.id)!
            const info = await host.engine.call('GET', `/containers/${record.id}/json`)
            if (dockerRepairConfigHash(info) !== member.configHash) throw Error('Writer changed before resume')
            if (!info.State?.Running) { await this.authority(ticket); await host.engine.call('POST', `/containers/${record.id}/start`) }
            if (!(await host.engine.call('GET', `/containers/${record.id}/json`)).State?.Running) throw Error('Writer restart not confirmed')
        }
        // Do not delete evidence/lock or auto-reuse this transaction for another
        // release. Enrollment must advance to the new exact container inventory.
    }
}
