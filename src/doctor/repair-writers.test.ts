import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { RepairWriterBarrier } from './repair-writers.js'
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
