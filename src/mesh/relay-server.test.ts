import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { RelayMeshTransport } from './relay-mesh-transport.js'
import { startMeshRelayServer, type MeshRelayServer } from './relay-server.js'

const active: MeshRelayServer[] = []
afterEach(async () => { while (active.length) await active.pop()!.close() })

function identity(nodeId: string): MeshIdentity {
    return new MeshIdentity(nodeId, mkdtempSync(join(tmpdir(), `nova-relay-${nodeId}-`)))
}

describe('Nova mesh relay', () => {
    it('authenticates, verifies, stores encrypted, delivers and acknowledges signed envelopes', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'nova-relay-store-'))
        const token = ['relay-test-', 'credential-value-123456'].join('')
        const relay = await startMeshRelayServer({ host: '127.0.0.1', port: 0, token, dataFile: join(directory, 'queue.enc.json') })
        active.push(relay)
        const senderIdentity = identity('relay-a')
        const sender = new RelayMeshTransport('relay-a', { url: relay.url, token, pollMs: 25 })
        const receiver = new RelayMeshTransport('relay-b', { url: relay.url, token, pollMs: 25 })
        let received = 0
        receiver.subscribe(envelope => { if (envelope.kind === 'node.heartbeat') received++ })
        const envelope = senderIdentity.create({
            kind: 'node.heartbeat', targetNode: 'relay-b',
            principal: { id: 'node:relay-a', role: 'system', channel: 'mesh' },
            payload: { status: 'online', uptimeMs: 1 },
        })
        expect(await sender.send('relay-b', envelope)).toMatchObject({ status: 'queued', transport: 'relay' })
        await new Promise(resolve => setTimeout(resolve, 120))
        expect(received).toBe(1)
        const health = await fetch(`${relay.url}/health`).then(response => response.json()) as any
        expect(health).toMatchObject({ ok: true, queued: 0, encryptedAtRest: true })
        expect(receiver.health()).toMatchObject({ healthy: true, encrypted: true, authenticated: true })

        const broadcast = senderIdentity.create({
            kind: 'node.heartbeat', targetNode: '*',
            principal: { id: 'node:relay-a', role: 'system', channel: 'mesh' },
            payload: { status: 'online', uptimeMs: 2 },
        })
        expect(await sender.send('relay-b', broadcast)).toMatchObject({ status: 'queued' })
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(received).toBe(2)
        await sender.close(); await receiver.close()
    })

    it('rejects missing credentials and unsigned envelopes', async () => {
        const token = ['relay-test-', 'credential-value-123456'].join('')
        const relay = await startMeshRelayServer({ host: '127.0.0.1', port: 0, token, dataFile: join(mkdtempSync(join(tmpdir(), 'nova-relay-auth-')), 'queue.enc.json') })
        active.push(relay)
        expect((await fetch(`${relay.url}/envelopes?to=node-a`)).status).toBe(401)
        const response = await fetch(`${relay.url}/envelopes`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ to: 'node-a', envelope: { kind: 'node.heartbeat', targetNode: 'node-a' } }),
        })
        expect(response.status).toBe(400)
    })
})
