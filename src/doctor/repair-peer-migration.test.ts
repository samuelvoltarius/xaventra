import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { dockerRepairConfigHash } from './docker-repair-driver.js'
import { prepareRepairPeerReplacement } from './repair-peer-migration.js'
function fixture() {
    const mappings = [{ fromSource: '/volumes/old/_data', fromName: 'old', toSource: '/volumes/new/_data', toName: 'new' }]
    const old = { Id: 'a'.repeat(64), Image: 'sha256:' + 'b'.repeat(64), State: { Running: true },
        Config: { Image: 'tag', Hostname: 'a'.repeat(12), User: '1000:1000', Cmd: ['node', 'worker.js'], Env: ['SAFE=fixture'] },
        HostConfig: { ReadonlyRootfs: true, RestartPolicy: { Name: 'no' }, NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
            Memory: 128000000, NanoCpus: 1000000000, PidsLimit: 32, LogConfig: { Config: { 'max-size': '1m' } },
            Mounts: [{ Type: 'volume', Source: 'old', Target: '/state', VolumeOptions: { NoCopy: true } }] },
        Mounts: [{ Type: 'volume', Name: 'old', Source: '/volumes/old/_data', Destination: '/state', RW: true }], NetworkSettings: { Networks: { none: {} } } }
    let next: any
    const call = vi.fn(async (method: string, path: string, body?: any) => {
        if (path.startsWith('/volumes/')) { const name = path.split('/').at(-1)!; return { Name: name, Mountpoint: `/volumes/${name}/_data`, Driver: 'local' } }
        if (method === 'POST' && path.startsWith('/containers/create')) {
            const { HostConfig, ...Config } = body
            next = { ...structuredClone(old), Id: 'c'.repeat(64), Config: { ...Config, Hostname: 'c'.repeat(12) }, HostConfig,
                State: { Running: false }, Mounts: old.Mounts.map(m => ({ ...m, Name: 'new', Source: '/volumes/new/_data' })) }
            return { Id: next.Id }
        }
        return structuredClone(path.includes(old.Id) ? old : next)
    })
    const options = { root: mkdtempSync(join(tmpdir(), 'xaventra-peer-unit-')), engine: { call }, mappings, member: { containerId: old.Id, configHash: dockerRepairConfigHash(old) } }
    return { options, old, call }
}
it('prepares a stopped unchanged-image peer and reuses only the exact verified registration', async () => {
    const f = fixture(), result = await prepareRepairPeerReplacement(f.options)
    expect(result.previousContainerId).toBe(f.old.Id)
    expect(await prepareRepairPeerReplacement(f.options)).toEqual(result)
    expect(f.call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(1)
})
it('does not recreate after a lost create response', async () => {
    const f = fixture(), original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (m, p, b) => { const result = await original(m, p, b); if (m === 'POST') throw Error('reply lost'); return result })
    await expect(prepareRepairPeerReplacement(f.options)).rejects.toThrow('lost')
    await expect(prepareRepairPeerReplacement(f.options)).rejects.toThrow('reconciliation')
    expect(f.call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(1)
})
it('remaps read-only aliases of the same state as well as the write mount', async () => {
    const f = fixture()
    f.old.Mounts.push({ ...f.old.Mounts[0], Destination: '/read-alias', RW: false })
    f.old.HostConfig.Mounts.push({ ...f.old.HostConfig.Mounts[0], Target: '/read-alias', ReadOnly: true } as any)
    f.options.member.configHash = dockerRepairConfigHash(f.old)
    const result = await prepareRepairPeerReplacement(f.options)
    const next = await f.call('GET', `/containers/${result.containerId}/json`)
    expect(next.Mounts.every(m => m.Source === '/volumes/new/_data')).toBe(true)
    expect(next.Mounts[1].RW).toBe(false)
})
it('rejects changed old configuration and unverified storage driver before creating a peer', async () => {
    const f = fixture(); f.old.Config.Env.push('CHANGED=1')
    await expect(prepareRepairPeerReplacement(f.options)).rejects.toThrow('enrollment')
    expect(f.call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0)
    const g = fixture(), original = g.call.getMockImplementation()!
    g.call.mockImplementation(async (m, p, b) => { const result = await original(m, p, b); if (p.startsWith('/volumes/')) result.Driver = 'remote'; return result })
    await expect(prepareRepairPeerReplacement(g.options)).rejects.toThrow('Unverified local volume')
    expect(g.call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0)
})
it('denies bind, custom-hostname and privileged peer auto-adoption', async () => {
    for (const change of [o => { o.HostConfig.Privileged = true }, o => { o.Config.Hostname = 'custom-name' }, o => { o.HostConfig.Binds = ['/host:/state'] }]) {
        const f = fixture(); change(f.old); f.options.member.configHash = dockerRepairConfigHash(f.old)
        await expect(prepareRepairPeerReplacement(f.options)).rejects.toThrow('enrollment')
        expect(f.call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0)
    }
})
