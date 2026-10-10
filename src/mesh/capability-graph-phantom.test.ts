import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityGraph, type CapabilityGraphSnapshot, type CapabilityRuntime } from './capability-graph.js'
import type { MeshNode } from './mesh-registry.js'

// Reproduces the ns2 phantom observed live on 30.09.2026: node xaventra-ns2
// advertises no AI service, yet its graph node keeps a "running" vLLM runtime
// on its own IP whose verifiedAt follows ns2's heartbeat.
const NS2 = 'xaventra-ns2'
const SPARK = 'xaventra-spark'
const PHANTOM_ENDPOINT = 'http://100.64.0.15:8000'
const REAL_ENDPOINT = 'http://100.64.0.10:8000'

function graphFile(): string {
    return join(mkdtempSync(join(tmpdir(), 'nova-cap-phantom-')), 'capability-graph.json')
}

function heartbeatRuntime(nodeId: string, endpoint: string, verifiedAt: string): CapabilityRuntime {
    return {
        id: `${nodeId}:vllm:${endpoint}`, name: 'vllm', type: 'llm', endpoint, status: 'running',
        models: ['qwen', 'qwen3.8-flash-next'], capabilities: ['llm', 'vllm'], verifiedAt, verificationSource: 'mesh-heartbeat',
    }
}

function seed(file: string, snapshot: CapabilityGraphSnapshot): CapabilityGraph {
    writeFileSync(file, JSON.stringify(snapshot))
    return new CapabilityGraph(file)
}

function ns2MeshNode(heartbeat: string): MeshNode {
    // Matches ns2's mesh.json / Supabase row: software.ai_services = []
    return {
        node_id: NS2, hostname: 'ns2', ip: '100.64.0.15', platform: 'linux', version: '2.79.0', tools_count: 1,
        status: 'online', capabilities: [], last_heartbeat: heartbeat,
        software: { node_version: 'v22', package_managers: [], can_install: [], ai_services: [] },
    }
}

function phantomOn(graph: CapabilityGraph): CapabilityRuntime[] {
    return graph.getSnapshot().nodes
        .filter(node => node.id === NS2)
        .flatMap(node => node.runtimes)
        .filter(runtime => runtime.endpoint.startsWith('http://100.64.0.15'))
}

describe('capability graph phantom runtime (ns2 vLLM that does not exist)', () => {
    const peerStateFile = join(process.cwd(), '.nova-data', 'mesh-peer-state.json')
    let savedNodeId: string | undefined

    beforeEach(() => {
        savedNodeId = process.env.NOVA_NODE_ID
        mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true })
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in test') }))
    })
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.resetModules()
        if (savedNodeId === undefined) delete process.env.NOVA_NODE_ID
        else process.env.NOVA_NODE_ID = savedNodeId
        rmSync(peerStateFile, { force: true })
    })

    it('a node heartbeat with ai_services=[] drops the node\'s previously heartbeat-sourced runtimes', () => {
        const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
        const now = new Date().toISOString()
        const graph = seed(graphFile(), {
            version: 1, updatedAt: old, tombstones: [],
            nodes: [{
                id: NS2, hostname: 'ns2', host: '100.64.0.15', status: 'online', lastHeartbeat: old,
                capabilities: ['llm', 'vllm'], runtimes: [heartbeatRuntime(NS2, PHANTOM_ENDPOINT, old)], updatedAt: old,
            }],
        })
        graph.ingest(null, [ns2MeshNode(now)], NS2)
        expect(phantomOn(graph)).toEqual([])
    })

    it('does not launder the phantom through peer snapshots into a fresh heartbeat on every sync round', async () => {
        const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
        const earlier = new Date(Date.now() - 60_000).toISOString()
        // Starting state as found live: both graphs carry the phantom.
        const ns2Graph = seed(graphFile(), {
            version: 1, updatedAt: old, tombstones: [],
            nodes: [{
                id: NS2, hostname: 'ns2', host: '100.64.0.15', status: 'online', lastHeartbeat: old,
                capabilities: ['llm'], runtimes: [heartbeatRuntime(NS2, PHANTOM_ENDPOINT, old)], updatedAt: old,
            }],
        })
        const sparkGraph = seed(graphFile(), {
            version: 1, updatedAt: earlier, tombstones: [],
            nodes: [
                {
                    id: SPARK, hostname: 'node-a', host: '100.64.0.10', status: 'online', lastHeartbeat: earlier,
                    capabilities: ['llm'], runtimes: [heartbeatRuntime(SPARK, REAL_ENDPOINT, earlier)], updatedAt: earlier,
                },
                {
                    id: NS2, hostname: 'ns2', host: '100.64.0.15', status: 'online', lastHeartbeat: earlier,
                    capabilities: ['llm'], runtimes: [heartbeatRuntime(NS2, PHANTOM_ENDPOINT, earlier)], updatedAt: earlier,
                },
            ],
        })

        // The Spark-side discovery is the real mesh-registry code path.
        process.env.NOVA_NODE_ID = SPARK
        vi.resetModules()
        const { discoverNodes } = await import('./mesh-registry.js')

        for (let round = 0; round < 2; round++) {
            // ns2: syncCapabilityGraphOnce -> ingest(own mesh.json node) -> merge(pulled/received Spark snapshot)
            const heartbeat = new Date().toISOString()
            ns2Graph.ingest(null, [ns2MeshNode(heartbeat)], NS2)
            ns2Graph.merge(sparkGraph.getSnapshot(), SPARK)
            // ns2 broadcasts node.capabilities { snapshot }; Spark stores it as peer state
            writeFileSync(peerStateFile, JSON.stringify({
                [NS2]: { nodeId: NS2, lastSeen: Date.now(), status: 'online', capabilities: { snapshot: ns2Graph.getSnapshot() } },
            }))
            // Spark: syncCapabilityGraphOnce -> ingest(discoverNodes()) -> pruneStale -> merge(ns2 snapshot)
            sparkGraph.ingest(null, await discoverNodes(), SPARK)
            sparkGraph.pruneStale()
            sparkGraph.merge(ns2Graph.getSnapshot(), NS2)
        }

        // No node may still route LLM work to a runtime on ns2.
        expect(ns2Graph.findCandidates({ type: 'llm' }).filter(item => item.nodeId === NS2)).toEqual([])
        expect(sparkGraph.findCandidates({ type: 'llm' }).filter(item => item.nodeId === NS2)).toEqual([])
        expect(phantomOn(ns2Graph)).toEqual([])
        // The real Spark runtime must survive.
        expect(sparkGraph.findCandidates({ type: 'llm' }).map(item => item.endpoint)).toContain(REAL_ENDPOINT)
    })
})
