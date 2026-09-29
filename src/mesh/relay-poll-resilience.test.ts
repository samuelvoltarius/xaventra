import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { RelayMeshTransport } from './relay-mesh-transport.js'
import { startMeshRelayServer, type MeshRelayServer } from './relay-server.js'

// MI-7: one envelope that the receiver rejects must not abort the relay poll,
// block the queue head or mark the relay unhealthy.

const active: MeshRelayServer[] = []
const transports: RelayMeshTransport[] = []
afterEach(async () => {
    while (transports.length) await transports.pop()!.close()
    while (active.length) await active.pop()!.close()
})

describe('MI-7 relay poll resilience', () => {
    it('keeps delivering after a rejected envelope and acknowledges the rejected one', async () => {
        const token = ['relay-test-', 'credential-value-654321'].join('')
        const relay = await startMeshRelayServer({ host: '127.0.0.1', port: 0, token, dataFile: join(mkdtempSync(join(tmpdir(), 'nova-mi7-')), 'queue.enc.json') })
        active.push(relay)
        const source = new MeshIdentity('relay-a', mkdtempSync(join(tmpdir(), 'nova-mi7-a-')))
        const sender = new RelayMeshTransport('relay-a', { url: relay.url, token, pollMs: 60_000 })
        transports.push(sender)
        // run.result is durable in the relay (heartbeats would be compacted).
        const make = (n: number) => source.create({
            kind: 'run.result', targetNode: 'relay-b',
            principal: { id: 'node:relay-a', role: 'system', channel: 'mesh' },
            payload: { requestId: `request-${n}`, success: true, evidence: [] },
        })
        const poisoned = make(1)
        const good = make(2)
        await sender.send('relay-b', poisoned)
        await sender.send('relay-b', good)

        const receiver = new RelayMeshTransport('relay-b', { url: relay.url, token, pollMs: 25 })
        transports.push(receiver)
        const accepted: string[] = []
        receiver.subscribe(async envelope => {
            if (envelope.id === poisoned.id) throw new Error('expired_or_clock_skew')
            accepted.push(envelope.id)
        })
        await expect.poll(() => accepted, { timeout: 2000 }).toEqual([good.id])
        await expect.poll(() => fetch(`${relay.url}/health`).then(response => response.json()), { timeout: 2000 })
            .toMatchObject({ ok: true, queued: 0 })
        expect(receiver.health()).toMatchObject({ healthy: true })
    })
})
