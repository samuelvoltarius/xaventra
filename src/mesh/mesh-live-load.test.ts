import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLiveLoad, sanitizeLiveLoad, sanitizeNodeProfile } from '../core/node-profile.js'
import { DirectMeshTransport } from './direct-mesh-transport.js'
import { MeshIdentity } from './mesh-identity.js'
import { MeshTransportRouter } from './mesh-transport-router.js'
import { peerStateWithHeartbeat } from './mesh-transport-runtime.js'
import { isEphemeralMeshKind, type MeshPeer, type MeshPrincipal } from './transport-contracts.js'

// Mesh-Gehirn 2.88: live load rides on the signed heartbeat, latency is the
// measured heartbeat round trip, and repository bundles never rest in a store.

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const principal = (nodeId: string): MeshPrincipal => ({ id: `node:${nodeId}`, role: 'system', channel: 'mesh' })
const identity = (nodeId: string) => new MeshIdentity(nodeId, mkdtempSync(join(tmpdir(), `nova-load-${nodeId}-`)))

describe('live load on the heartbeat', () => {
    it('bounds untrusted load values and drops garbage', () => {
        expect(sanitizeLiveLoad({ cpuPerCore: 0.456, memFreePercent: 140, gpuUtilPercent: -3, diskFreeGB: '512', extra: 'x' }))
            .toEqual({ cpuPerCore: 0.46, memFreePercent: 100, diskFreeGB: 512 })
        expect(sanitizeLiveLoad('busy')).toBeUndefined()
        expect(sanitizeLiveLoad({})).toBeUndefined()
    })

    it('measures locally without blocking (no GPU value when none is known)', () => {
        const load = collectLiveLoad(tmpdir(), () => null)
        expect(load.memFreePercent).toBeGreaterThanOrEqual(0)
        expect(load.gpuUtilPercent).toBeUndefined()
        expect(typeof load.diskFreeGB).toBe('number')
        expect(collectLiveLoad(tmpdir(), () => 42).gpuUtilPercent).toBe(42)
    })

    it('keeps the peer load from the latest heartbeat only', () => {
        const first = peerStateWithHeartbeat(undefined, 'peer-a', { status: 'online', load: { gpuUtilPercent: 12, diskFreeGB: 80 } }, 'fp', 1_000)
        expect(first.load).toEqual({ gpuUtilPercent: 12, diskFreeGB: 80 })
        const older = peerStateWithHeartbeat(first, 'peer-a', { status: 'online' }, 'fp', 31_000)
        expect(older.load).toBeUndefined()
    })

    it('carries the VRAM of a discrete GPU in the signed profile, bounded', () => {
        const base = { schema: 1, nodeId: 'n', cpus: 8, ramGB: 32, selfCheck: { status: 'ok', items: [] } }
        expect(sanitizeNodeProfile({ ...base, gpu: { name: 'NVIDIA RTX', backend: 'cuda', vramGB: 24 } })!.gpu).toEqual({ name: 'NVIDIA RTX', backend: 'cuda', viaVllm: false, vramGB: 24 })
        expect(sanitizeNodeProfile({ ...base, gpu: { name: null, backend: 'cpu', vramGB: 'lots' } })!.gpu).toEqual({ name: null, backend: 'cpu', viaVllm: false })
    })
})

describe('transport: latency and ephemeral repository kinds', () => {
    it('git.* is ephemeral like capture.*', () => {
        expect(isEphemeralMeshKind('git.request')).toBe(true)
        expect(isEphemeralMeshKind('git.response')).toBe(true)
        expect(isEphemeralMeshKind('capture.request')).toBe(true)
        expect(isEphemeralMeshKind('agent.request')).toBe(false)
    })

    it('records the heartbeat round trip per peer over the direct transport', async () => {
        const a = identity('rtt-a'); const b = identity('rtt-b')
        const ta = new DirectMeshTransport(a, principal('rtt-a'), { port: 0, peers: [], ackTimeoutMs: 1000 })
        const tb = new DirectMeshTransport(b, principal('rtt-b'), { port: 0, peers: [], ackTimeoutMs: 1000 })
        ta.start(); tb.start(); await new Promise(resolve => setTimeout(resolve, 20))
        const peerA: MeshPeer = { nodeId: 'rtt-a', url: `ws://127.0.0.1:${ta.listeningPort()}`, transport: 'direct', status: 'unknown', publicKey: a.publicKey, roles: ['system'] }
        const peerB: MeshPeer = { nodeId: 'rtt-b', url: `ws://127.0.0.1:${tb.listeningPort()}`, transport: 'direct', status: 'unknown', publicKey: b.publicKey, roles: ['system'] }
        ta.addPeer(peerB); tb.addPeer(peerA)
        const ra = new MeshTransportRouter(a, principal('rtt-a'), { mode: 'direct', peers: [peerB] }, [ta])
        const rb = new MeshTransportRouter(b, principal('rtt-b'), { mode: 'direct', peers: [peerA] }, [tb])
        cleanup.push(() => ra.close(), () => rb.close())
        expect(ra.peerRoundTrips()).toEqual({})
        const ack = await ra.send('rtt-b', ra.create('node.heartbeat', 'rtt-b', { status: 'online' }))
        expect(ack.status).toBe('delivered')
        const trip = ra.peerRoundTrips()['rtt-b']
        expect(trip.ms).toBeGreaterThanOrEqual(0)
        expect(trip.ms).toBeLessThan(1000)
    })

    it('a git.request to an unreachable peer is not queued for later', async () => {
        const a = identity('eph-a')
        const ta = new DirectMeshTransport(a, principal('eph-a'), { peers: [], ackTimeoutMs: 200 })
        const ra = new MeshTransportRouter(a, principal('eph-a'), { mode: 'direct', peers: [] }, [ta])
        cleanup.push(() => ra.close())
        const ack = await ra.send('nobody', ra.create('git.request', 'nobody', { operation: 'release', repo: 'demo', workId: 'w1' }))
        expect(ack.status).toBe('unreachable')
        expect(ra.health().queued).toBe(0)
    })
})
