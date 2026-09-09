import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { RepairWriterBarrier } from './repair-writers.js'
import { verifyRepairPeerReplacement } from './repair-peer-migration.js'
import { dockerRepairConfigHash } from './docker-repair-driver.js'
const ticket = () => ({ proposalId: 'p', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), targetId: 't', probeId: 'p', attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 })
function fixture(extra = false) {
    const entries = ['a', 'b', ...(extra ? ['c'] : [])].map(ch => ({ Id: ch.repeat(64), Image: 'sha256:' + ch.repeat(64), Config: {}, HostConfig: { RestartPolicy: { Name: 'no' } },
        Mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/state/_data', RW: true }], State: { Running: true }, NetworkSettings: { Networks: {} } }))
    const call = vi.fn(async (method: string, path: string) => {
        if (path === '/containers/json?all=1') return entries.map(i => ({ Id: i.Id }))
        const item = entries.find(i => path.includes(i.Id))!
        if (method === 'POST') item.State.Running = path.endsWith('/start')
        return structuredClone(item)
    })
    const hosts = [{ id: 'host', engine: { call }, protectedSources: ['/var/lib/docker/volumes/state/_data'], members: entries.slice(0, 2).map(i => ({ containerId: i.Id, configHash: dockerRepairConfigHash(i) })) }]
    const options = { root: join(process.cwd(), '.nova-data', randomUUID()), hosts, requiredHosts: ['host'], externalSinks: [] as string[], hasAuthority: vi.fn(async () => true), toolDrain: vi.fn(async () => true) }
    return { entries, call, options, barrier: new RepairWriterBarrier(options) }
}
it('stops all enrolled background writers, detects rogue restart and resumes only peers', async () => {
    const f = fixture(), t = ticket(); await f.barrier.halt(t)
    expect(await f.barrier.quiescent(t)).toBe(true)
    f.entries[0].State.Running = true; expect(await f.barrier.quiescent(t)).toBe(false); f.entries[0].State.Running = false
    await f.barrier.resumePeers(t, [f.entries[0].Id])
    expect(f.entries.map(i => i.State.Running)).toEqual([false, true])
    f.options.toolDrain.mockResolvedValue(false)
    await f.barrier.resumePeers(t, [f.entries[0].Id]) // Lost acknowledgement: no restart/authority reuse.
    expect(f.call.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/start'))).toHaveLength(1)
})
it('unknown container sharing state blocks every stop, even without a Mesh label', async () => {
    const f = fixture(true)
    await expect(f.barrier.halt(ticket())).rejects.toThrow('Unenrolled')
    expect(f.call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(0)
})
it('missing host, external fence or exclusive restart owner fails closed', async () => {
    const f = fixture()
    expect(() => new RepairWriterBarrier({ ...f.options, requiredHosts: ['host', 'missing'] })).toThrow()
    const barrier = new RepairWriterBarrier({ ...f.options, externalSinks: ['database'] })
    await expect(barrier.halt(ticket())).rejects.toThrow('External sink')
    f.entries[0].HostConfig.RestartPolicy.Name = 'always'
    await expect(f.barrier.halt(ticket())).rejects.toThrow('restart ownership')
    expect(f.call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(0)
})
it('a lost stop response retains transaction and never implicitly repeats incomplete shutdown', async () => {
    const f = fixture(), t = ticket(), original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, path) => { const result = await original(method, path); if (method === 'POST') throw Error('reply lost'); return result })
    await expect(f.barrier.halt(t)).rejects.toThrow('lost')
    expect(await f.barrier.quiescent(t)).toBe(false)
    await expect(new RepairWriterBarrier(f.options).halt(t)).rejects.toThrow('incomplete')
    expect(f.call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
})
it('never resumes a peer against preserved rollback storage after successful activation', async () => {
    const f = fixture(), t = ticket()
    const barrier = new RepairWriterBarrier({ ...f.options, hosts: f.options.hosts.map(h => ({ ...h, preserveSources: [...h.protectedSources] })) })
    await barrier.halt(t)
    await expect(barrier.resumePeers(t, [f.entries[0].Id])).rejects.toThrow('shares rollback')
    expect(f.entries.every(i => !i.State.Running)).toBe(true)
    await barrier.resumePeers(t, [f.entries[0].Id], true)
    expect(f.entries[1].State.Running).toBe(true)
})
it('reopened transaction cannot resume under a changed writer inventory', async () => {
    const f = fixture(), t = ticket(); await f.barrier.halt(t)
    const changed = new RepairWriterBarrier({ ...f.options, hosts: f.options.hosts.map(h => ({ ...h, protectedSources: [...h.protectedSources, '/another-store'] })) })
    await expect(changed.resumePeers(t, [f.entries[0].Id])).rejects.toThrow('ownership mismatch')
    expect(f.entries.every(i => !i.State.Running)).toBe(true)
})
it('checks every peer configuration before restarting even the first peer', async () => {
    const f = fixture(), t = ticket(); await f.barrier.halt(t)
    f.entries[1].Config = { User: '0' }
    await expect(f.barrier.resumePeers(t, [])).rejects.toThrow('ownership mismatch')
    expect(f.entries.every(i => !i.State.Running)).toBe(true)
})
it('rescans unknown protected-state writers before resuming any peer', async () => {
    const f = fixture(), t = ticket(); await f.barrier.halt(t)
    f.entries.push({ ...structuredClone(f.entries[0]), Id: 'c'.repeat(64), State: { Running: true } })
    await expect(f.barrier.resumePeers(t, [])).rejects.toThrow('Unenrolled')
    expect(f.entries.slice(0, 2).every(i => !i.State.Running)).toBe(true)
})
function migrationFixture() {
    const f = fixture(), oldSource = f.options.hosts[0].protectedSources[0], newSource = '/var/lib/docker/volumes/next/_data'
    const mappings = [{ fromSource: oldSource, fromName: 'state', toSource: newSource, toName: 'next' }]
    f.entries.forEach(i => { Object.assign(i.Mounts[0], { Name: 'state', Destination: '/state' }) })
    const next = structuredClone(f.entries[1]); next.Id = 'c'.repeat(64); next.State.Running = false
    Object.assign(next.Mounts[0], { Source: newSource, Name: 'next' }); f.entries.push(next)
    const options = { ...f.options, hosts: f.options.hosts.map(h => ({ ...h, members: f.entries.slice(0, 2).map(i => ({ containerId: i.Id, configHash: dockerRepairConfigHash(i) })),
        protectedSources: [oldSource, newSource], preserveSources: [oldSource], volumeMappings: mappings,
        staged: [{ containerId: next.Id, configHash: dockerRepairConfigHash(next) }],
        replacements: [{ previousContainerId: f.entries[1].Id, containerId: next.Id, configHash: dockerRepairConfigHash(next) }] })) }
    return { ...f, next, options, mappings, barrier: new RepairWriterBarrier(options) }
}
it('migrates only the approved peer storage and reconciles a lost start reply without repeating it', async () => {
    const f = migrationFixture(), t = ticket(); await f.barrier.halt(t)
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, path) => { const result = await original(method, path); if (method === 'POST' && path.endsWith('/start')) throw Error('reply lost'); return result })
    await expect(f.barrier.resumePeers(t, [f.entries[0].Id])).rejects.toThrow('lost')
    f.options.toolDrain.mockResolvedValue(false)
    await new RepairWriterBarrier(f.options).resumePeers(t, [f.entries[0].Id])
    expect(f.entries.map(i => i.State.Running)).toEqual([false, false, true])
    expect(f.call.mock.calls.filter(([m, p]) => m === 'POST' && p.endsWith('/start'))).toHaveLength(1)
    await expect(new RepairWriterBarrier(f.options).resumePeers(t, [f.entries[0].Id], true)).rejects.toThrow('direction changed')
})
it('rollback resumes only original peers and leaves replacement storage stopped', async () => {
    const f = migrationFixture(), t = ticket(); await f.barrier.halt(t)
    await f.barrier.resumePeers(t, [f.entries[0].Id], true)
    expect(f.entries.map(i => i.State.Running)).toEqual([false, true, false])
})
it('refuses an ambiguous start when the peer exited before reconciliation', async () => {
    const f = migrationFixture(), t = ticket(); await f.barrier.halt(t)
    await f.barrier.resumePeers(t, [f.entries[0].Id]); f.next.State.Running = false
    await expect(new RepairWriterBarrier(f.options).resumePeers(t, [f.entries[0].Id])).rejects.toThrow('Ambiguous peer start')
    expect(f.call.mock.calls.filter(([m, p]) => m === 'POST' && p.endsWith('/start'))).toHaveLength(1)
})
it('rejects code, credentials, network or mount substitutions in an enrolled replacement', async () => {
    const f = migrationFixture(), old = f.entries[1]
    verifyRepairPeerReplacement(old, f.next, f.mappings)
    for (const change of [n => { n.Config.Env = ['INJECTED=yes'] }, n => { n.Image = 'sha256:' + 'd'.repeat(64) },
        n => { n.HostConfig.Privileged = true }, n => { n.NetworkSettings.Networks = { host: {} } }, n => { n.Mounts[0].Source = '/other' }]) {
        const next = structuredClone(f.next); change(next)
        expect(() => verifyRepairPeerReplacement(old, next, f.mappings)).toThrow('changed more')
    }
})
it('retains previously stopped peers and rejects wrong generation restarts', async () => {
    const f = migrationFixture(), t = ticket(); f.entries[1].State.Running = false; await f.barrier.halt(t)
    await f.barrier.resumePeers(t, [f.entries[0].Id]); expect(f.next.State.Running).toBe(false)
    f.entries[1].State.Running = true
    await expect(f.barrier.resumePeers(t, [f.entries[0].Id])).rejects.toThrow('Opposite peer generation')
})
