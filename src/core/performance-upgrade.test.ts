import { describe, expect, it } from 'vitest'
import { selectAgentTriggers } from './autonomy-loop.js'
import { nodesFromCapabilityGraph } from '../mesh/capability-orchestrator.js'
import { isFullInventoryDue } from '../mesh/ai-scanner.js'
import type { CapabilityGraphSnapshot } from '../mesh/capability-graph.js'

describe('performance and activity upgrade', () => {
    it('keeps mission autonomy but suppresses duplicate operational and social LLM runs by default', () => {
        const triggers = [
            { type: 'mission' },
            { type: 'health' },
            { type: 'reminder' },
            { type: 'evening' },
        ]
        expect(selectAgentTriggers(triggers, false)).toEqual([{ type: 'mission' }])
        expect(selectAgentTriggers(triggers, true)).toEqual([{ type: 'mission' }, { type: 'evening' }])
    })

    it('uses cheap refreshes between full mesh inventories', () => {
        const now = 2_000_000
        expect(isFullInventoryDue(0, now, 30_000)).toBe(true)
        expect(isFullInventoryDue(now - 29_999, now, 30_000)).toBe(false)
        expect(isFullInventoryDue(now - 30_000, now, 30_000)).toBe(true)
    })

    it('projects the canonical graph without probing hardcoded nodes', () => {
        const snapshot: CapabilityGraphSnapshot = {
            version: 1,
            updatedAt: new Date().toISOString(),
            nodes: [{
                id: 'nova-spark',
                hostname: 'gx10',
                host: '100.1.2.3',
                status: 'online',
                hardware: {
                    cpu: 'GB10', cores: 20, arch: 'arm64', ram_gb: 128,
                    disk_gb: 1000, disk_free_gb: 500, gpu: 'NVIDIA GB10',
                    os_name: 'linux', os_version: '',
                },
                capabilities: ['llm'],
                runtimes: [{
                    id: 'vllm', name: 'vllm', type: 'llm',
                    endpoint: 'http://100.1.2.3:8000', status: 'running',
                    models: ['qwen'], capabilities: ['llm', 'tools'],
                    verifiedAt: new Date().toISOString(), verificationSource: 'probe',
                    metadata: { performance: { qwen: { online: true, avgLatencyMs: 200 } } },
                }],
                updatedAt: new Date().toISOString(),
            }],
            tombstones: [],
        }
        const projected = nodesFromCapabilityGraph(snapshot)
        expect(projected).toHaveLength(1)
        expect(projected[0].name).toBe('nova-spark')
        expect(projected[0].ollamaModels).toEqual(['qwen'])
        expect(projected[0].capabilities.map(capability => capability.name)).toEqual(
            expect.arrayContaining(['llm', 'tools']),
        )
    })
})
