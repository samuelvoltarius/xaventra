import { describe, it, expect } from 'vitest'
import { DockerRepairDriver, dockerRepairConfigHash } from './docker-repair-driver.js'
import { repairHash, type RepairTicket } from './repair-activation.js'

function fixture(mutate?: (info: any, next: any) => void) {
    const binding = { proposalId: 'patch-one', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), probeId: 'answer', targetId: 'qa' }
    const ticket: RepairTicket = { ...binding, attemptId: 'repair-00000000-0000-0000-0000-000000000000', expiresAt: Date.now() + 60_000 }
    const inspect = (id: string, running: boolean) => ({ Id: id.repeat(64), Image: `sha256:${id.repeat(64)}`,
        Config: { User: '1000:1000', Healthcheck: { Test: ['CMD', 'node', 'health.js'] } },
        HostConfig: { ReadonlyRootfs: true, RestartPolicy: { Name: 'no' }, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 1_000_000, NanoCpus: 1_000_000_000, PidsLimit: 32,
            LogConfig: { Config: { 'max-size': '1m' } } }, Mounts: [], State: { Running: running, Health: { Status: 'healthy' } } })
    const old = inspect('1', true), next = inspect('2', false)
    mutate?.(old, next)
    const calls: string[] = [], states: any[] = []
    let authority = true, failStart = false, falseStop = false
    const engine = { call: async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        const info = path.includes(old.Id) ? old : next
        if (path.endsWith('/json')) return structuredClone(info)
        if (path.includes('/stop')) { if (!falseStop) info.State.Running = false; return }
        if (path.endsWith('/start')) { if (failStart && info === next) throw new Error('start refused'); info.State.Running = true; return }
        throw new Error('Unexpected operation')
    } }
    const release = (id: string, info: any, sourceHash: string) => ({ containerId: info.Id, configHash: dockerRepairConfigHash(info),
        release: { id, previousReleaseId: 'old', sourceHash, binding, imageId: info.Image } })
    const options = { targetId: 'qa', initialReleaseId: 'old', releases: { old: release('old', old, binding.baselineHash), next: release('next', next, binding.candidateHash) },
        catalog: { [binding.candidateHash]: 'next' }, hasAuthority: async () => authority, loadState: () => undefined, saveState: (state: any) => states.push(state) }
    const driver = new DockerRepairDriver(options, engine)
    return { driver, ticket, old, next, calls, states, options, engine, loseAuthority: () => { authority = false }, failStart: () => { failStart = true }, falseStop: () => { falseStop = true } }
}
describe('Docker repair exact identity, confinement and rollback boundary', () => {
    it('activates only prepared immutable IDs, keeps original for rollback', async () => {
        const f = fixture(), p = await f.driver.prepare(f.ticket)
        await f.driver.activate(p, f.ticket)
        expect(await f.driver.currentRelease('qa')).toBe('next')
        expect(f.old.State.Running).toBe(false); expect(f.next.State.Running).toBe(true)
        expect(f.calls.filter(x => x.startsWith('POST'))).toEqual([`POST /containers/${f.old.Id}/stop?t=20`, `POST /containers/${f.next.Id}/start`])
        await f.driver.rollback(p, f.ticket)
        expect(await f.driver.currentRelease('qa')).toBe('old')
        expect(f.states.map(s => s.phase)).toEqual(['switching', 'running', 'switching', 'running'])
    })
    it.each(['privileged', 'root', 'restart', 'socket', 'writable-root', 'config-drift', 'missing-state-proof'])('rejects %s before mutation', async kind => {
        const f = fixture((old, next) => {
            if (kind === 'privileged') next.HostConfig.Privileged = true
            if (kind === 'root') next.Config.User = '0'
            if (kind === 'restart') next.HostConfig.RestartPolicy.Name = 'always'
            if (kind === 'socket') next.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock', RW: false }]
            if (kind === 'writable-root') next.HostConfig.ReadonlyRootfs = false
            if (kind === 'missing-state-proof') old.Mounts = [{ Type: 'volume', Name: 'original-state', Source: '/volumes/original', RW: true }]
        })
        if (kind === 'config-drift') f.next.Config.User = '1001'
        await expect(f.driver.prepare(f.ticket)).rejects.toThrow()
        expect(f.calls.some(c => c.startsWith('POST'))).toBe(false)
    })
    it('does not use a forged source baseline or mutable image tag', async () => {
        const f = fixture()
        await expect(f.driver.prepare({ ...f.ticket, baselineHash: repairHash('other source') })).rejects.toThrow('continuity')
        expect(f.calls).toEqual([])
    })
    it('restores the old container after candidate start failed', async () => {
        const f = fixture(), p = await f.driver.prepare(f.ticket); f.failStart()
        await expect(f.driver.activate(p, f.ticket)).rejects.toThrow('start refused')
        await f.driver.rollback(p, f.ticket)
        expect(await f.driver.currentRelease('qa')).toBe('old'); expect(f.next.State.Running).toBe(false)
    })
    it('does not double-start an original whose exit could not be verified', async () => {
        const f = fixture(), p = await f.driver.prepare(f.ticket); f.falseStop()
        await expect(f.driver.activate(p, f.ticket)).rejects.toThrow('exit unconfirmed')
        await f.driver.rollback(p, f.ticket)
        expect(f.calls.filter(c => c.endsWith('/start'))).toEqual([])
        expect(await f.driver.currentRelease('qa')).toBe('old')
    })
    it('losing authority cannot start or roll back any container', async () => {
        const f = fixture(), p = await f.driver.prepare(f.ticket); f.loseAuthority()
        await expect(f.driver.activate(p, f.ticket)).rejects.toThrow('fenced')
        await expect(f.driver.rollback(p, f.ticket)).rejects.toThrow('authority')
        expect(f.calls.some(c => c.startsWith('POST'))).toBe(false)
    })
    it('rejects shared writable storage even when a state callback says ready', async () => {
        const f = fixture((old, next) => { old.Mounts = next.Mounts = [{ Type: 'volume', Name: 'shared', Source: '/shared', RW: true }] })
        const driver = new DockerRepairDriver({ ...f.options, stateReady: async () => true }, f.engine)
        await expect(driver.prepare(f.ticket)).rejects.toThrow('share writable')
    })
})
