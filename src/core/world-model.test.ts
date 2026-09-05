import { describe, expect, it, vi } from 'vitest'

vi.mock('../mesh/mesh-registry.js', () => ({
    discoverNodes: async () => [{ node_id: 'spark', hostname: 'spark', status: 'online', version: '2.68.0', tools_count: 200, last_heartbeat: new Date().toISOString(), hardware: { ram_mb: 128000 } }],
    getLocalNodeId: () => 'spark',
    getMeshMainAuthority: async () => ({ nodeId: 'spark', hostname: 'spark', services: ['nova-main', 'telegram'], epoch: 9, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
}))
vi.mock('../mesh/capability-graph.js', () => ({ getCapabilityGraph: () => ({ getSnapshot: () => ({ version: 1, updatedAt: new Date().toISOString(), nodes: [], tombstones: [] }) }) }))
vi.mock('./autonomous-executor.js', () => ({ getActiveMission: () => null, getMissionQueue: () => [] }))
vi.mock('../memory/memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => ({ list: () => [], getStats: () => ({ total: 0, candidate: 0, verified: 0, canonical: 0, superseded: 0, rejected: 0, expired: 0 }) }) }))
vi.mock('../memory/session-summarizer.js', () => ({ getSessionContinuityStore: () => ({ getStats: () => ({ sessions: 2, openGoals: 1, verifiedOutcomes: 3, path: 'test' }) }) }))
vi.mock('./outcome-ledger.js', () => ({ getOutcomeLedger: () => ({ listRuns: () => [] }) }))

import { buildNovaWorldModel, formatNovaWorldModel } from './world-model.js'

describe('Nova world model', () => {
    it('combines authoritative state with provenance and freshness', async () => {
        const model = await buildNovaWorldModel()
        expect(model.main.value?.nodeId).toBe('spark')
        expect(model.main.source).toBe('mesh-lease-authority')
        expect(model.nodes.value).toHaveLength(1)
        expect(model.memory.value.openGoals).toBe(1)
        expect(formatNovaWorldModel(model)).toContain('Jede Zahl stammt aus einem kanonischen Store')
    })
})
