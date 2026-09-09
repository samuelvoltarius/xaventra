import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { repairHash } from './repair-activation.js'
import { dockerRepairConfigHash, type DockerRepairEngine } from './docker-repair-driver.js'

export interface RepairVolumeMapping { fromSource: string; fromName: string; toSource: string; toName: string }
export interface RepairPeerReplacement { previousContainerId: string; containerId: string; configHash: string }
const id = /^[a-f0-9]{64}$/
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

/** Mapping is supplied by the protected controller after inspecting the old and
 * candidate main. No copy is performed here: the existing quiescent state cloner
 * must complete before any replacement starts. */
export function validateRepairVolumeMappings(mappings: readonly RepairVolumeMapping[]) {
    const paths = mappings.flatMap(m => [m.fromSource, m.toSource])
    const names = mappings.flatMap(m => [m.fromName, m.toName])
    if (!mappings.length || mappings.length > 32 || names.some(n => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(n))
        || new Set(names).size !== names.length || paths.some(p => !p.startsWith('/') || p === '/' || p.endsWith('/') || p.includes('..') || p.includes('\0'))
        || paths.some((p, i) => paths.some((other, j) => i !== j && overlaps(p, other)))) throw Error('Distinct canonical named-volume mappings required')
}
function mappedMounts(mounts: any[], mappings: readonly RepairVolumeMapping[]) {
    return mounts.map(m => {
        const replacement = mappings.find(v => v.fromSource === m.Source)
        if (mappings.some(v => overlaps(m.Source || '', v.fromSource)) && !replacement) throw Error('Partial shared mount migration is unsupported')
        if (!replacement) return m
        if (m.Type !== 'volume' || m.Name !== replacement.fromName) throw Error('Only exact named-volume peers may migrate')
        return { ...m, Source: replacement.toSource, Name: replacement.toName }
    })
}
function remappedHost(host: any, mappings: readonly RepairVolumeMapping[]) {
    return { ...host, OomKillDisable: host.OomKillDisable === true, Mounts: (host.Mounts || []).map((m: any) => {
        const v = mappings.find(v => m.Type === 'volume' && v.fromName === m.Source)
        return v ? { ...m, Source: v.toName } : m
    }) }
}
/** A peer migration changes storage, not code, credentials, privileges or
 * network membership. Compare all other immutable fields, not selected flags. */
export function verifyRepairPeerReplacement(old: any, next: any, mappings: readonly RepairVolumeMapping[]) {
    validateRepairVolumeMappings(mappings)
    const config = (info: any) => ({ ...info.Config, Image: info.Image, Hostname: '' })
    if (!id.test(old.Id) || !id.test(next.Id) || old.Id === next.Id || old.Image !== next.Image
        || repairHash(config(old)) !== repairHash(config(next))
        || repairHash(remappedHost(old.HostConfig, mappings)) !== repairHash(remappedHost(next.HostConfig, []))
        || repairHash(mappedMounts(old.Mounts || [], mappings)) !== repairHash(next.Mounts || [])
        || repairHash(Object.keys(old.NetworkSettings?.Networks || {}).sort()) !== repairHash(Object.keys(next.NetworkSettings?.Networks || {}).sort())
        || !(old.Mounts || []).some((m: any) => m.RW && mappings.some(v => m.Source === v.fromSource))) throw Error('Peer migration changed more than approved storage')
}

/** Root-owned caller supplies a per-attempt protected directory. Persist the
 * creation intent first; an ambiguous Docker create is never implicitly replayed.
 * This creates a STOPPED same-image peer and never updates/stops the original. */
export async function prepareRepairPeerReplacement(options: { root: string; engine: DockerRepairEngine;
    member: { containerId: string; configHash: string }; mappings: readonly RepairVolumeMapping[] }): Promise<RepairPeerReplacement> {
    const { engine, member, mappings } = options
    if (!id.test(member.containerId) || !id.test(member.configHash)) throw Error('Exact enrolled peer identity required')
    validateRepairVolumeMappings(mappings)
    const old = await engine.call('GET', `/containers/${member.containerId}/json`)
    if (dockerRepairConfigHash(old) !== member.configHash || old.State?.Paused || old.State?.Restarting
        || old.Config?.Hostname !== old.Id.slice(0, 12) || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(old.Config?.User || '')
        || old.HostConfig?.RestartPolicy?.Name !== 'no' || old.HostConfig.AutoRemove || old.HostConfig.Privileged
        || !old.HostConfig.ReadonlyRootfs || old.HostConfig.Binds?.length || old.HostConfig.VolumesFrom?.length
        || old.HostConfig.CapAdd?.length || !old.HostConfig.CapDrop?.includes('ALL')
        || !old.HostConfig.SecurityOpt?.length || old.HostConfig.SecurityOpt.some((s: string) => !/^no-new-privileges(?::true)?$/.test(s))
        || old.HostConfig.Devices?.length || old.HostConfig.DeviceRequests?.length || old.HostConfig.PidMode
        || old.HostConfig.IpcMode === 'host' || old.HostConfig.UsernsMode === 'host'
        || !(old.HostConfig.Memory > 0) || !(old.HostConfig.PidsLimit > 0) || !(old.HostConfig.NanoCpus > 0)
        || !old.HostConfig.LogConfig?.Config?.['max-size']
        || (old.Mounts || []).some((m: any) => !['volume','bind','tmpfs'].includes(m.Type) || /docker\.sock|containerd\.sock/.test(m.Source || '') || (m.Type === 'bind' && (m.RW || m.Source === '/')))
        || !['bridge', 'none'].includes(old.HostConfig.NetworkMode)
        || Object.keys(old.NetworkSettings?.Networks || {}).length !== 1) throw Error('Peer needs explicit exclusive, confined, default-network enrollment')
    mappedMounts(old.Mounts || [], mappings)
    if (!(old.Mounts || []).some((m: any) => m.RW && mappings.some(v => v.fromSource === m.Source))) throw Error('Peer has no mapped shared state')
    for (const v of mappings) for (const [name, source] of [[v.fromName, v.fromSource], [v.toName, v.toSource]]) {
        const volume = await engine.call('GET', `/volumes/${encodeURIComponent(name)}`)
        if (volume.Name !== name || volume.Mountpoint !== source || volume.Driver !== 'local' || Object.keys(volume.Options || {}).length) throw Error('Unverified local volume mapping')
    }
    mkdirSync(options.root, { recursive: true })
    const file = join(options.root, member.containerId + '.json'), lock = join(options.root, member.containerId + '.lock')
    const binding = repairHash({ member, mappings })
    if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'))
        if (saved.binding !== binding || !saved.result) throw Error('Peer creation requires reconciliation; no implicit retry')
        const next = await engine.call('GET', `/containers/${saved.result.containerId}/json`)
        if (dockerRepairConfigHash(next) !== saved.result.configHash || next.State?.Running || next.State?.Paused || next.State?.Restarting) throw Error('Prepared peer changed or already started')
        verifyRepairPeerReplacement(old, next, mappings); return saved.result
    }
    mkdirSync(lock)
    atomicWriteJsonSync(file, { binding, phase: 'creating' })
    const body = { ...structuredClone(old.Config), Hostname: '', Image: old.Image, HostConfig: remappedHost(old.HostConfig, mappings) }
    const created = await engine.call('POST', `/containers/create?name=xaventra-repair-peer-${randomUUID()}`, body)
    if (!id.test(created.Id)) throw Error('Invalid replacement identity')
    const next = await engine.call('GET', `/containers/${created.Id}/json`)
    if (next.State?.Running || next.State?.Paused || next.State?.Restarting) throw Error('Replacement must remain stopped')
    verifyRepairPeerReplacement(old, next, mappings)
    const result = { previousContainerId: old.Id, containerId: next.Id, configHash: dockerRepairConfigHash(next) }
    atomicWriteJsonSync(file, { binding, phase: 'prepared', result })
    return result
}
