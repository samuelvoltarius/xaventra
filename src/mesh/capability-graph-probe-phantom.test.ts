import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityGraphSnapshot, CapabilityRuntime } from './capability-graph.js'
import type { MeshNode } from './mesh-registry.js'

// Live 01.10.2026 (Spark, after the 2.80.0 rollout): the capability graph held
// "xaventra-ns2 vllm@xaventra-ns2:8000 verificationSource=probe status=running"
// although only the Spark runs vLLM. The 2.79.x fix only dropped heartbeat
// runtimes. The id format is the AIScan "mesh advertisement" phase: ns2's
// peer state on the Spark held ns2's graph snapshot (the 60 s snapshot
// broadcast overwrote ns2's own runtime list), the snapshot still carried a
// persisted ns2 runtime, and the scanner re-labelled it as a fresh probe with
// ns2's heartbeat time.
const NS2 = 'xaventra-ns2'
const SPARK = 'xaventra-spark'
const NS2_VLLM = 'http://100.86.97.15:8000'
const SPARK_VLLM = 'http://100.86.70.71:8000'

const dataDir = () => join(process.cwd(), '.nova-data')
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

function probeRuntime(id: string, endpoint: string, verifiedAt: string): CapabilityRuntime {
    return { id, name: 'vllm', type: 'llm', endpoint, status: 'running', models: ['qwen3.8-flash-next'], capabilities: ['llm', 'vllm'], verifiedAt, verificationSource: 'probe' }
}

function ns2MeshNode(heartbeat: string): MeshNode {
    return {
        node_id: NS2, hostname: 'ns2', ip: '100.86.97.15', platform: 'linux', version: '2.80.0', tools_count: 1,
        status: 'online', capabilities: [], last_heartbeat: heartbeat,
        software: { node_version: 'v22', package_managers: [], can_install: [], ai_services: [] },
    }
}

function sparkMeshNode(heartbeat: string): MeshNode {
    return {
        node_id: SPARK, hostname: 'gx10-c809', ip: '100.86.70.71', platform: 'linux', version: '2.80.0', tools_count: 1,
        status: 'online', capabilities: [], last_heartbeat: heartbeat,
        software: { node_version: 'v22', package_managers: [], can_install: [], ai_services: [{ name: 'vllm', type: 'llm', endpoint: SPARK_VLLM, status: 'running', models: ['qwen3.8-flash-next'] }] },
    }
}

function runningOnNs2(snapshot: CapabilityGraphSnapshot): CapabilityRuntime[] {
    return snapshot.nodes.filter(node => node.id === NS2).flatMap(node => node.runtimes).filter(runtime => runtime.status === 'running')
}

describe('phantom probe vLLM on ns2 (Hotfix 2.80.1, Befund 3)', () => {
    let savedNodeId: string | undefined
    beforeEach(() => {
        savedNodeId = process.env.NOVA_NODE_ID
        mkdirSync(dataDir(), { recursive: true })
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in test') }))
    })
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.resetModules()
        if (savedNodeId === undefined) delete process.env.NOVA_NODE_ID
        else process.env.NOVA_NODE_ID = savedNodeId
        for (const file of ['mesh-peer-state.json', 'capability-graph.json', 'ns2-capability-graph.json']) rmSync(join(dataDir(), file), { force: true })
    })

    it('never resolves the vLLM fallback to ns2 after the live sync loop', async () => {
        // ns2 starts with its graph as persisted by an older version: its own
        // node still carries the phantom runtime.
        const old = iso(-2 * 60 * 60_000)
        writeFileSync(join(dataDir(), 'ns2-capability-graph.json'), JSON.stringify({
            version: 1, updatedAt: old, tombstones: [],
            nodes: [{ id: NS2, hostname: 'ns2', host: '100.86.97.15', status: 'online', lastHeartbeat: old, capabilities: ['llm'], runtimes: [probeRuntime(`vllm@${NS2}:8000`, NS2_VLLM, old)], updatedAt: old }],
        }))
        writeFileSync(join(dataDir(), 'capability-graph.json'), JSON.stringify({ version: 1, updatedAt: old, tombstones: [], nodes: [] }))

        process.env.NOVA_NODE_ID = SPARK
        vi.resetModules()
        const { CapabilityGraph, getCapabilityGraph } = await import('./capability-graph.js')
        const { peerStateWithCapabilities } = await import('./mesh-transport-runtime.js')
        const { discoverNodes } = await import('./mesh-registry.js')
        const { servicesFromMeshAdvertisements } = await import('./ai-scanner.js')
        const { resolveVllmFallback } = await import('../auth/codex-runtime.js')
        const ns2Graph = new CapabilityGraph(join(dataDir(), 'ns2-capability-graph.json'))
        const sparkGraph = getCapabilityGraph()

        let ns2PeerState: any
        for (let round = 0; round < 3; round++) {
            // ns2: own heartbeat ingest, then its two broadcasts (30 s runtimes, 60 s snapshot)
            ns2Graph.ingest(null, [ns2MeshNode(iso())], NS2)
            ns2Graph.merge(sparkGraph.getSnapshot(), SPARK)
            ns2PeerState = peerStateWithCapabilities(ns2PeerState, NS2, { hostname: 'ns2', platform: 'linux', capabilities: [], runtimes: [] }, 'fp')
            ns2PeerState = peerStateWithCapabilities(ns2PeerState, NS2, { snapshot: ns2Graph.getSnapshot() }, 'fp')
            ns2PeerState = { ...ns2PeerState, status: 'online' }
            writeFileSync(join(dataDir(), 'mesh-peer-state.json'), JSON.stringify({ [NS2]: ns2PeerState }))

            // Spark: AIScan phase 4 (mesh advertisements) -> graph ingest -> merge of ns2's snapshot
            const nodes = await discoverNodes()
            const scan = { lastScan: iso(), scanDurationMs: 1, services: servicesFromMeshAdvertisements(nodes) }
            sparkGraph.ingest(scan, [...nodes, sparkMeshNode(iso())], SPARK)
            sparkGraph.merge(ns2Graph.getSnapshot(), NS2)
        }

        expect(runningOnNs2(sparkGraph.getSnapshot())).toEqual([])
        expect(sparkGraph.findCandidates({ type: 'llm' }).filter(candidate => candidate.nodeId === NS2)).toEqual([])
        const fallback = resolveVllmFallback({} as any)
        expect(fallback?.nodeId).not.toBe(NS2)
        expect(fallback?.endpoint).toBe(SPARK_VLLM)
    })

    it('a snapshot broadcast does not replace the peer\'s own runtime advertisement', async () => {
        const { peerStateWithCapabilities } = await import('./mesh-transport-runtime.js')
        const own = peerStateWithCapabilities(undefined, NS2, { hostname: 'ns2', capabilities: [], runtimes: [] }, 'fp', 1_000)
        const after = peerStateWithCapabilities(own, NS2, { snapshot: { version: 1, updatedAt: iso(), nodes: [] } }, 'fp', 31_000)
        expect((after.capabilities as any).runtimes).toEqual([])
        expect((after.capabilities as any).snapshot).toBeUndefined()
        expect(after.lastSeen).toBe(31_000)
    })

    it('mesh-advertised services are bound to the advertising node and are not probe evidence', async () => {
        const { servicesFromMeshAdvertisements } = await import('./ai-scanner.js')
        const { CapabilityGraph } = await import('./capability-graph.js')
        const node = { ...ns2MeshNode(iso()), software: { node_version: 'v22', package_managers: [], can_install: [], ai_services: [{ name: 'vllm', type: 'llm', endpoint: NS2_VLLM, status: 'running' as const, models: ['m'] }] } }
        const services = servicesFromMeshAdvertisements([node])
        expect(services).toHaveLength(1)
        const graph = new CapabilityGraph(join(dataDir(), 'ns2-capability-graph.json'))
        graph.ingest({ lastScan: iso(), scanDurationMs: 1, services }, [node], SPARK)
        const runtime = graph.getSnapshot().nodes.find(item => item.id === NS2)?.runtimes[0]
        expect(runtime?.verificationSource).toBe('mesh-heartbeat')
        // ns2 stops advertising: the stale scan result must not re-add it.
        graph.ingest({ lastScan: iso(), scanDurationMs: 1, services }, [ns2MeshNode(iso())], SPARK)
        expect(runningOnNs2(graph.getSnapshot())).toEqual([])
    })

    it('does not accept another node\'s probe runtimes, or our own node, from a peer snapshot', async () => {
        const { CapabilityGraph } = await import('./capability-graph.js')
        const now = iso()
        const graph = new CapabilityGraph(join(dataDir(), 'ns2-capability-graph.json'))
        graph.setLocalNodeId(SPARK)
        graph.merge({
            version: 1, updatedAt: now, tombstones: [],
            nodes: [
                { id: NS2, hostname: 'ns2', status: 'online', lastHeartbeat: now, capabilities: [], runtimes: [probeRuntime(`vllm@${NS2}:8000`, NS2_VLLM, now)], updatedAt: now },
                { id: SPARK, hostname: 'gx10-c809', status: 'online', lastHeartbeat: now, capabilities: [], runtimes: [probeRuntime('old-spark', 'http://100.86.70.71:9999', now)], updatedAt: now },
            ],
        }, 'xaventra-ns1')
        const snapshot = graph.getSnapshot()
        expect(runningOnNs2(snapshot)).toEqual([])
        expect(snapshot.nodes.find(node => node.id === SPARK)).toBeUndefined()
    })
})
