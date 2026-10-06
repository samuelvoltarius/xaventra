import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQuorumWitnessServer } from './quorum-witness.js'
import { acquireWitnessQuorumLease, peekWitnessQuorum, raiseWitnessEpochFloor, resetWitnessEpochHighWaterForTests, type WitnessQuorumConfig } from './witness-quorum.js'

const servers: ReturnType<typeof createQuorumWitnessServer>[] = []
afterEach(async () => {
    resetWitnessEpochHighWaterForTests()
    await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => instance.server.close(() => resolve()))))
})

async function witnesses() {
    const dir = mkdtempSync(join(tmpdir(), 'xv-witness-peek-'))
    const endpoints: Array<{ id: string; secret: string; url: string }> = []
    for (const id of ['pw1', 'pw2', 'pw3']) {
        const secret = `peek-secret-${id}-long-enough`
        const instance = createQuorumWitnessServer({ witnessId: id, secret, stateFile: join(dir, `${id}.json`) })
        servers.push(instance)
        endpoints.push({ id, secret, url: `http://127.0.0.1:${await instance.listen()}` })
    }
    return endpoints
}

describe('2.88 read-only witness view and epoch floor', () => {
    it('peeks the majority holder without voting and reports an unreachable majority', async () => {
        const endpoints = await witnesses()
        const config: WitnessQuorumConfig = { mode: 'witness', witnesses: endpoints, timeoutMs: 500 }
        const lease = await acquireWitnessQuorumLease('nova-main', 30_000, config, 'node-a')
        expect(lease.leader).toBe(true)
        expect(lease.quorumReachable).toBe(true)
        const view = await peekWitnessQuorum('nova-main', config)
        expect(view).toMatchObject({ reachable: 3, majority: 2, holder: { nodeId: 'node-a', epoch: lease.epoch } })
        // Peeking twice does not change the term.
        expect((await peekWitnessQuorum('nova-main', config))?.holder?.epoch).toBe(lease.epoch)

        const dead = (index: number) => ({ ...endpoints[index], url: `http://127.0.0.1:${index + 1}` })
        const cut: WitnessQuorumConfig = { mode: 'witness', witnesses: [dead(0), dead(1), endpoints[2]], timeoutMs: 300 }
        const denied = await acquireWitnessQuorumLease('nova-main', 30_000, cut, 'node-b')
        expect(denied.leader).toBe(false)
        expect(denied.quorumReachable).toBe(false)
        const partial = await peekWitnessQuorum('nova-main', cut)
        expect(partial?.reachable).toBe(1)
        expect(partial?.holder).toBeUndefined()
        // A forged witness id is ignored.
        const forged: WitnessQuorumConfig = { mode: 'witness', witnesses: endpoints.map(item => ({ ...item, id: `${item.id}-x` })), timeoutMs: 300 }
        expect((await peekWitnessQuorum('nova-main', forged))?.reachable).toBe(0)
    }, 15_000)

    it('a raised epoch floor puts the next term above it', async () => {
        const endpoints = await witnesses()
        const config: WitnessQuorumConfig = { mode: 'witness', witnesses: endpoints, timeoutMs: 500 }
        raiseWitnessEpochFloor('nova-main', 12)
        const lease = await acquireWitnessQuorumLease('nova-main', 30_000, config, 'node-b')
        expect(lease.leader).toBe(true)
        expect(lease.epoch).toBeGreaterThanOrEqual(12)
        expect(lease.fencingToken).toBe(`nova-main:q${lease.epoch}:node-b`)
    }, 15_000)
})
