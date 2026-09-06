import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { CapabilityGraph, capabilityRuntimeAvailable } from './capability-graph.js'
import type { CapabilityGraphNode } from './capability-graph.js'

describe('CapabilityGraph', () => {
    it('enforces heartbeat, expiry and runtime-local capabilities without a prune pass', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        const now = new Date().toISOString()
        const node: CapabilityGraphNode = {
            id: 'fixture', hostname: 'fixture', status: 'online', updatedAt: now, lastHeartbeat: now,
            capabilities: ['llm', 'embedding'], runtimes: [{
                id: 'chat', name: 'vLLM', type: 'llm', endpoint: 'http://192.0.2.1:8000',
                status: 'running', models: ['chat'], capabilities: ['llm'], verifiedAt: now, verificationSource: 'probe',
            }],
        }
        graph.merge({ version: 1, updatedAt: now, nodes: [node] })
        expect(graph.findCandidates({ capability: 'llm' })).toHaveLength(1)
        expect(graph.findCandidates({ capability: 'embedding' })).toEqual([])
        const runtime = node.runtimes[0]
        expect(capabilityRuntimeAvailable(node, runtime, Date.parse(now) + 75_001)).toBe(false)
        expect(capabilityRuntimeAvailable({ ...node, lastHeartbeat: 'invalid' }, runtime)).toBe(false)
        expect(capabilityRuntimeAvailable(node, { ...runtime, expiresAt: now })).toBe(false)
        expect(capabilityRuntimeAvailable(node, { ...runtime, expiresAt: 'invalid' })).toBe(false)
        expect(capabilityRuntimeAvailable(node, runtime, Date.parse(now) - 31_000)).toBe(false)
    })
    it('merges scanner evidence with node hardware and returns verified candidates', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        const now = new Date().toISOString()
        graph.ingest({ lastScan: now, scanDurationMs: 10, services: [{
            id: 'spark-vllm', name: 'vllm', type: 'llm', provider: 'vllm', host: '10.0.0.2', port: 8000,
            endpoint: 'http://10.0.0.2:8000', models: ['Qwen-Code'], status: 'running', lastSeen: now, sourceNode: 'spark',
        }] }, [{
            node_id: 'spark', hostname: 'spark', ip: '10.0.0.2', platform: 'linux', version: '1', tools_count: 1,
            status: 'online', capabilities: ['cuda'], last_heartbeat: now,
            hardware: { cpu: 'ARM', cores: 20, arch: 'arm64', ram_gb: 128, disk_gb: 1000, disk_free_gb: 500, gpu: 'NVIDIA', gpu_vram_mb: 128000, os_name: 'Linux', os_version: '1' },
        }])
        const candidates = graph.findCandidates({ type: 'llm', model: 'Qwen' })
        expect(candidates[0].nodeId).toBe('spark')
        expect(graph.getSnapshot().nodes[0].hardware?.gpu).toBe('NVIDIA')
    })

    it('merges newer remote snapshots and honors runtime tombstones', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        const now = new Date().toISOString()
        graph.merge({ version: 1, updatedAt: now, nodes: [{
            id: 'remote', hostname: 'remote', status: 'online', capabilities: ['llm'], updatedAt: now,
            runtimes: [{ id: 'remote:vllm', name: 'vLLM', type: 'llm', endpoint: 'http://remote:8000', status: 'running', models: ['Qwen'], capabilities: ['llm'], verifiedAt: now, verificationSource: 'mesh-heartbeat' }],
        }] })
        graph.merge({ version: 1, updatedAt: now, nodes: [], tombstones: [{ id: 'remote:vllm', deletedAt: new Date(Date.now() + 1000).toISOString(), sourceNode: 'remote' }] })
        expect(graph.getSnapshot().nodes[0].runtimes).toHaveLength(0)
    })

    it('attaches localhost probes to the canonical local node and collapses endpoint aliases', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        const now = new Date().toISOString()
        graph.ingest({ lastScan: now, scanDurationMs: 10, services: [{
            id: 'local-vllm', name: 'vllm', type: 'llm', provider: 'vllm', host: 'localhost', port: 8000,
            endpoint: 'http://localhost:8000', models: ['Qwen'], status: 'running', lastSeen: now, sourceNode: 'local',
        }] }, [{
            node_id: 'nova-spark', hostname: 'gpu-main', ip: '100.64.0.10', platform: 'linux', version: '1',
            tools_count: 1, status: 'online', capabilities: ['cuda'], last_heartbeat: now,
            software: { ai_services: [{
                name: 'vllm', type: 'llm', endpoint: 'http://100.64.0.10:8000', status: 'running', models: ['Qwen'],
            }] },
        }], 'nova-spark')
        const snapshot = graph.getSnapshot()
        expect(snapshot.nodes.map(node => node.id)).toEqual(['nova-spark'])
        expect(snapshot.nodes[0].runtimes).toHaveLength(1)
    })

    it('marks expired heartbeats offline and excludes them from routing', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        const stale = new Date(Date.now() - 2 * 60_000).toISOString()
        graph.merge({ version: 1, updatedAt: stale, nodes: [{
            id: 'stale', hostname: 'stale', status: 'online', capabilities: ['llm'], lastHeartbeat: stale, updatedAt: stale,
            runtimes: [{
                id: 'stale:vllm', name: 'vllm', type: 'llm', endpoint: 'http://stale:8000', status: 'running',
                models: ['Qwen'], capabilities: ['llm'], verifiedAt: new Date().toISOString(), verificationSource: 'mesh-heartbeat',
            }],
        }] })
        graph.pruneStale(24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 75_000)
        expect(graph.getSnapshot().nodes[0].status).toBe('offline')
        expect(graph.findCandidates({ type: 'llm' })).toEqual([])
    })

    it('canonicalizes service aliases onto the live heartbeat node', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        const now = new Date().toISOString()
        graph.merge({
            version: 1,
            updatedAt: now,
            nodes: [
                {
                    id: 'nova-spark', hostname: 'gx10', host: '100.1.2.3', status: 'online',
                    lastHeartbeat: now, capabilities: ['llm'], runtimes: [], updatedAt: now,
                },
                {
                    id: 'vLLM-Server', hostname: 'vLLM-Server', host: '100.1.2.3', status: 'unknown',
                    capabilities: ['llm'], runtimes: [{
                        id: 'vllm', name: 'vllm', type: 'llm', endpoint: 'http://100.1.2.3:8000',
                        status: 'running', models: ['qwen'], capabilities: ['llm'],
                        verifiedAt: now, verificationSource: 'probe',
                    }], updatedAt: now,
                },
            ],
            tombstones: [],
        })
        const snapshot = graph.getSnapshot()
        expect(snapshot.nodes).toHaveLength(1)
        expect(snapshot.nodes[0].id).toBe('nova-spark')
        expect(snapshot.nodes[0].runtimes.map(runtime => runtime.id)).toContain('vllm')
    })
})
