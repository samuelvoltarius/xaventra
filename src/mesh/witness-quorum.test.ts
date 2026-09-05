import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQuorumWitnessServer } from './quorum-witness.js'
import { acquireWitnessQuorumLease, type WitnessQuorumConfig } from './witness-quorum.js'

const servers: ReturnType<typeof createQuorumWitnessServer>[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => instance.server.close(() => resolve()))))
})

describe('independent witness quorum', () => {
    it('admits one leader, requires two votes, and fences a stale holder after expiry', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-witness-'))
        const endpoints = []
        for (let index = 0; index < 3; index++) {
            const id = `w${index + 1}`
            const secret = `test-secret-${id}-at-least-16`
            const instance = createQuorumWitnessServer({ witnessId: id, secret, stateFile: join(dir, `${id}.json`) })
            servers.push(instance)
            const port = await instance.listen()
            endpoints.push({ id, secret, url: `http://127.0.0.1:${port}` })
        }
        const config: WitnessQuorumConfig = { mode: 'witness', witnesses: endpoints, timeoutMs: 1000 }

        const first = await acquireWitnessQuorumLease('telegram', 1500, config, 'node-a')
        expect(first.leader).toBe(true)
        expect(first.coordinator).toBe('witness')
        expect(first.fencingToken).toContain('telegram:q1:')

        expect((await acquireWitnessQuorumLease('telegram', 1500, config, 'node-b')).leader).toBe(false)

        await new Promise(resolve => setTimeout(resolve, 1600))
        const takeover = await acquireWitnessQuorumLease('telegram', 1500, config, 'node-b')
        expect(takeover.leader).toBe(true)
        expect(takeover.epoch).toBe(2)

        expect((await acquireWitnessQuorumLease('telegram', 1500, config, 'node-a')).leader).toBe(false)
    })

    it('fails closed with only one reachable witness', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-witness-'))
        const secret = ['witness-test-', 'credential'].join('')
        const instance = createQuorumWitnessServer({ witnessId: 'w1', secret, stateFile: join(dir, 'w1.json') })
        servers.push(instance)
        const port = await instance.listen()
        const config: WitnessQuorumConfig = {
            mode: 'witness', timeoutMs: 100,
            witnesses: [
                { id: 'w1', secret, url: `http://127.0.0.1:${port}` },
                { id: 'w2', secret: ['witness-test-', 'credential'].join(''), url: 'http://127.0.0.1:1' },
                { id: 'w3', secret: ['witness-test-', 'credential'].join(''), url: 'http://127.0.0.1:2' },
            ],
        }
        const decision = await acquireWitnessQuorumLease('dashboard', 1500, config, 'node-a')
        expect(decision.leader).toBe(false)
        expect(decision.reason).toContain('1/2 approvals')
    })
})
