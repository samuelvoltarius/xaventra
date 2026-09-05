import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DirectMeshTransport } from './direct-mesh-transport.js'
import { MeshIdentity, MeshReplayGuard } from './mesh-identity.js'
import { MeshPolicy } from './mesh-policy.js'
import { MeshTransportRouter } from './mesh-transport-router.js'
import { LocalMeshTransport } from './local-mesh-transport.js'
import type { MeshAck, MeshEnvelope, MeshHandler, MeshPeer, MeshPrincipal, MeshTransport, MeshTransportHealth } from './transport-contracts.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

function identity(nodeId: string): MeshIdentity {
    return new MeshIdentity(nodeId, mkdtempSync(join(tmpdir(), `nova-mesh-${nodeId}-`)))
}

const principal = (nodeId: string): MeshPrincipal => ({ id: `node:${nodeId}`, role: 'system', channel: 'mesh' })

describe('secure mesh envelopes', () => {
    it('detects payload tampering and replay', () => {
        const source = identity('a')
        const envelope = source.create({ kind: 'node.heartbeat', targetNode: 'b', principal: principal('a'), payload: { status: 'online' } })
        expect(MeshIdentity.verify(envelope)).toBe(true)
        expect(MeshIdentity.verify({ ...envelope, payload: { status: 'busy' } })).toBe(false)
        const guard = new MeshReplayGuard()
        expect(guard.accept(envelope).accepted).toBe(true)
        expect(guard.accept(envelope)).toMatchObject({ accepted: false, reason: 'replay' })
    })

    it('pins peer keys, blocks unsafe tools and requires a fence in HA', () => {
        const a = identity('a')
        const b = identity('b')
        const c = identity('c')
        const peer: MeshPeer = { nodeId: 'a', transport: 'direct', status: 'online', publicKey: a.publicKey, roles: ['system'], allowedTools: ['read_file'] }
        const policy = new MeshPolicy({ mode: 'ha', peers: [peer], allowedTools: ['read_file'] }, 'b')
        const safe = a.create({ kind: 'tool.request', targetNode: 'b', principal: principal('a'), payload: { tool: 'read_file', arguments: { path: 'README.md' }, idempotencyKey: 'safe-one' } })
        expect(policy.verify(safe).accepted).toBe(true)
        const codexProbe = a.create({ kind: 'codex.status.request', targetNode: 'b', principal: { id: 'user-123', role: 'system' }, payload: { idempotencyKey: 'codex-status-123' } })
        expect(policy.verify(codexProbe).accepted).toBe(true)
        const codexCompletion = a.create({ kind: 'codex.complete.request', targetNode: 'b', principal: { id: 'user-123', role: 'system' }, payload: { idempotencyKey: 'codex-complete-123', messages: [{ role: 'user', content: 'hello' }], tools: [] } })
        expect(policy.verify(codexCompletion).accepted).toBe(true)
        const nestedShell = a.create({ kind: 'tool.request', targetNode: 'b', principal: principal('a'), payload: { tool: 'read_file', arguments: { options: { command: 'whoami' } }, idempotencyKey: 'nested-shell' } })
        expect(policy.verify(nestedShell)).toMatchObject({ accepted: false, reason: 'free_shell_payload' })
        const unsafe = a.create({ kind: 'tool.request', targetNode: 'b', principal: principal('a'), payload: { tool: 'run_command', arguments: { command: 'whoami' }, idempotencyKey: 'unsafe-two' } })
        expect(policy.verify(unsafe)).toMatchObject({ accepted: false, reason: 'tool_never_remote' })
        const mission = a.create({ kind: 'mission.request', targetNode: 'b', principal: principal('a'), payload: { missionId: 'm', checkpoint: '{}', phase: 'run', pendingActions: [], idempotencyKey: 'm' } })
        expect(policy.verify(mission)).toMatchObject({ accepted: false, reason: 'missing_fence' })
        const impostor = c.create({ kind: 'node.heartbeat', targetNode: 'b', principal: principal('c'), payload: { status: 'online' } })
        expect(policy.verify(impostor)).toMatchObject({ accepted: false, reason: 'untrusted_node' })
    })
})

describe('DirectMeshTransport', () => {
    it('authenticates both peers, acknowledges delivery and deduplicates replay', async () => {
        const a = identity('direct-a')
        const b = identity('direct-b')
        const transportA = new DirectMeshTransport(a, principal('direct-a'), { port: 0, peers: [], ackTimeoutMs: 1000 })
        const transportB = new DirectMeshTransport(b, principal('direct-b'), { port: 0, peers: [], ackTimeoutMs: 1000 })
        transportA.start(); transportB.start()
        await new Promise(resolve => setTimeout(resolve, 20))
        const portA = transportA.listeningPort()!
        const portB = transportB.listeningPort()!
        const peerA: MeshPeer = { nodeId: 'direct-a', url: `ws://127.0.0.1:${portA}`, transport: 'direct', status: 'unknown', publicKey: a.publicKey, roles: ['system'] }
        const peerB: MeshPeer = { nodeId: 'direct-b', url: `ws://127.0.0.1:${portB}`, transport: 'direct', status: 'unknown', publicKey: b.publicKey, roles: ['system'] }
        transportA.addPeer(peerB)
        transportB.addPeer(peerA)
        const routerA = new MeshTransportRouter(a, principal('direct-a'), { mode: 'direct', peers: [peerB] }, [transportA])
        const routerB = new MeshTransportRouter(b, principal('direct-b'), { mode: 'direct', peers: [peerA] }, [transportB])
        cleanup.push(() => routerA.close(), () => routerB.close())
        let received = 0
        routerB.subscribe(envelope => { if (envelope.kind === 'node.heartbeat') received++ })
        const envelope = routerA.create('node.heartbeat', 'direct-b', { status: 'online', uptimeMs: 1 })
        const first = await routerA.send('direct-b', envelope)
        const replay = await routerA.send('direct-b', envelope)
        expect(first).toMatchObject({ status: 'delivered', transport: 'direct', peerId: 'direct-b' })
        expect(replay.status).toBe('delivered')
        expect(received).toBe(1)
        expect(transportA.health()).toMatchObject({ encrypted: true, authenticated: true, connectedPeers: 1 })
    })

    it('returns a signed rejection for a tampered envelope', async () => {
        const a = identity('tamper-a')
        const b = identity('tamper-b')
        const ta = new DirectMeshTransport(a, principal('tamper-a'), { port: 0, peers: [], ackTimeoutMs: 1000 })
        const tb = new DirectMeshTransport(b, principal('tamper-b'), { port: 0, peers: [], ackTimeoutMs: 1000 })
        ta.start(); tb.start(); await new Promise(resolve => setTimeout(resolve, 20))
        const peerA: MeshPeer = { nodeId: 'tamper-a', url: `ws://127.0.0.1:${ta.listeningPort()}`, transport: 'direct', status: 'unknown', publicKey: a.publicKey, roles: ['system'] }
        const peerB: MeshPeer = { nodeId: 'tamper-b', url: `ws://127.0.0.1:${tb.listeningPort()}`, transport: 'direct', status: 'unknown', publicKey: b.publicKey, roles: ['system'] }
        ta.addPeer(peerB); tb.addPeer(peerA)
        const ra = new MeshTransportRouter(a, principal('tamper-a'), { mode: 'direct', peers: [peerB] }, [ta])
        const rb = new MeshTransportRouter(b, principal('tamper-b'), { mode: 'direct', peers: [peerA] }, [tb])
        cleanup.push(() => ra.close(), () => rb.close())
        const valid = ra.create('node.heartbeat', 'tamper-b', { status: 'online' })
        const tampered = { ...valid, payload: { status: 'busy' } } as MeshEnvelope
        const ack = await ra.send('tamper-b', tampered)
        expect(ack).toMatchObject({ status: 'rejected', transport: 'direct' })
        expect(ack.reason).toContain('invalid_signature')
    })
})

describe('transport routing', () => {
    it('delivers between multiple Nova processes on the same host through LocalMeshTransport', async () => {
        const a = identity('local-a'); const b = identity('local-b')
        const la = new LocalMeshTransport('local-a'); const lb = new LocalMeshTransport('local-b')
        const peerA: MeshPeer = { nodeId: 'local-a', transport: 'local', status: 'online', publicKey: a.publicKey, roles: ['system'] }
        const peerB: MeshPeer = { nodeId: 'local-b', transport: 'local', status: 'online', publicKey: b.publicKey, roles: ['system'] }
        const ra = new MeshTransportRouter(a, principal('local-a'), { mode: 'direct', peers: [peerB] }, [la])
        const rb = new MeshTransportRouter(b, principal('local-b'), { mode: 'direct', peers: [peerA] }, [lb])
        cleanup.push(() => ra.close(), () => rb.close())
        let received = false
        rb.subscribe(() => { received = true })
        const ack = await ra.send('local-b', ra.create('node.heartbeat', 'local-b', { status: 'online' }))
        expect(ack).toMatchObject({ status: 'delivered', transport: 'local' })
        expect(received).toBe(true)
    })

    it('uses the durable transport after direct delivery becomes unreachable', async () => {
        class FakeTransport implements MeshTransport {
            handlers = new Set<MeshHandler>()
            constructor(readonly name: MeshAck['transport'], private readonly status: MeshAck['status']) {}
            async discover() { return [] }
            async connect() {}
            async send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck> { return { envelopeId: envelope.id, peerId, status: this.status, transport: this.name, timestamp: Date.now() } }
            async broadcast() {}
            subscribe(handler: MeshHandler) { this.handlers.add(handler) }
            health(): MeshTransportHealth { return { name: this.name, healthy: true, connectedPeers: 0, queued: 0, encrypted: true, authenticated: true } }
        }
        const a = identity('route-a')
        const direct = new FakeTransport('direct', 'unreachable')
        const durable = new FakeTransport('supabase', 'queued')
        const router = new MeshTransportRouter(a, principal('route-a'), { mode: 'ha', peers: [] }, [direct, durable])
        cleanup.push(() => router.close())
        const ack = await router.send('route-b', router.create('agent.request', 'route-b', { prompt: 'test', idempotencyKey: 'x' }))
        expect(ack).toMatchObject({ status: 'queued', transport: 'supabase' })
    })
})
