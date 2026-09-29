import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQuorumWitnessServer } from './quorum-witness.js'
import { acquireWitnessQuorumLease, resetWitnessEpochHighWaterForTests, type WitnessQuorumConfig } from './witness-quorum.js'

const servers: ReturnType<typeof createQuorumWitnessServer>[] = []
afterEach(async () => {
    resetWitnessEpochHighWaterForTests()
    await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => instance.server.close(() => resolve()))))
})

const expired = new Date(Date.now() - 60_000).toISOString()
const lease = (holderNodeId: string, epoch: number) => ({
    leases: { 'nova-main': { service: 'nova-main', holderNodeId, holderHostname: holderNodeId, epoch, expiresAt: expired, updatedAt: expired } },
    checkpoints: {},
})

describe('CL-07 witness epochs are monotone across quorum changes', () => {
    it('never hands a later term a lower epoch (FENCING_ANALYSE §1.3 example) and keeps the token stable', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-witness-epoch-'))
        // W1/W2 remember A in epoch 5, W3 only an older term 3 (it was down).
        const seeds = [lease('node-a', 5), lease('node-a', 5), lease('node-x', 3)]
        const endpoints: Array<{ id: string; secret: string; url: string }> = []
        for (let index = 0; index < 3; index++) {
            const id = `ew${index + 1}`; const secret = `epoch-secret-${id}-long-enough`
            const stateFile = join(dir, `${id}.json`)
            writeFileSync(stateFile, JSON.stringify(seeds[index]))
            const instance = createQuorumWitnessServer({ witnessId: id, secret, stateFile })
            servers.push(instance)
            endpoints.push({ id, secret, url: `http://127.0.0.1:${await instance.listen()}` })
        }
        const dead = (index: number) => ({ ...endpoints[index], url: `http://127.0.0.1:${index + 1}` })
        const quorum = (witnesses: typeof endpoints): WitnessQuorumConfig => ({ mode: 'witness', witnesses, timeoutMs: 300 })

        // B takes over with W2 + W3 (W1 unreachable). W2 would say 6, W3 4.
        const b = await acquireWitnessQuorumLease('nova-main', 1_200, quorum([dead(0), endpoints[1], endpoints[2]]), 'node-b')
        expect(b.leader).toBe(true)
        expect(b.epoch).toBe(6)
        expect(b.fencingToken).toBe('nova-main:q6:node-b')
        const renewed = await acquireWitnessQuorumLease('nova-main', 1_200, quorum([dead(0), endpoints[1], endpoints[2]]), 'node-b')
        expect(renewed.fencingToken).toBe(b.fencingToken)

        // B dies; A (a fresh process) takes over with W1 + W3 while W2 is down.
        await new Promise(resolve => setTimeout(resolve, 1_300))
        resetWitnessEpochHighWaterForTests()
        const a = await acquireWitnessQuorumLease('nova-main', 1_200, quorum([endpoints[0], dead(1), endpoints[2]]), 'node-a')
        expect(a.leader).toBe(true)
        expect(a.epoch).toBeGreaterThan(b.epoch!)
        expect(a.fencingToken).toBe(`nova-main:q${a.epoch}:node-a`)
    }, 15_000)
})
