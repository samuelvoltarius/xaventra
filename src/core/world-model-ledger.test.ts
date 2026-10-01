import { describe, expect, it, vi } from 'vitest'

// Das frühere Kausal-Gedächtnis (causal-memory.json) war nur eine Kopie der
// validierten Läufe. Das Weltmodell zählt sie jetzt direkt aus dem
// Outcome-Ledger — zurückgezogene (invalidierte) Läufe zählen nicht.
const runs = [
    { runId: 'r1', userId: 'sample', channel: 'telegram', status: 'completed', validation: { success: true }, updatedAt: '2026-10-01T10:00:00.000Z' },
    { runId: 'r2', userId: 'sample', channel: 'telegram', status: 'failed', validation: { success: false }, updatedAt: '2026-10-01T09:00:00.000Z' },
    { runId: 'r3', userId: 'sample', channel: 'telegram', status: 'completed', validation: { success: true }, invalidated: { reason: 'User correction' }, updatedAt: '2026-10-01T08:00:00.000Z' },
    { runId: 'r4', userId: 'sample', channel: 'telegram', status: 'running', updatedAt: '2026-10-01T07:00:00.000Z' },
    { runId: 'r5', userId: 'gast', channel: 'telegram', status: 'completed', validation: { success: true }, updatedAt: '2026-10-01T06:00:00.000Z' },
]
vi.mock('../mesh/mesh-registry.js', () => ({
    discoverNodes: async () => [],
    getLocalNodeId: () => 'spark',
    getMeshMainAuthority: async () => null,
}))
vi.mock('../mesh/capability-graph.js', () => ({ getCapabilityGraph: () => ({ getSnapshot: () => ({ version: 1, updatedAt: new Date().toISOString(), nodes: [], tombstones: [] }) }) }))
vi.mock('./autonomous-executor.js', () => ({ getActiveMission: () => null, getMissionQueue: () => [] }))
vi.mock('../memory/memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => ({ list: () => [], getStats: () => ({ total: 0, candidate: 0, verified: 0, canonical: 0, superseded: 0, rejected: 0, expired: 0 }) }) }))
vi.mock('../memory/session-summarizer.js', () => ({ getSessionContinuityStore: () => ({ getStats: () => ({ sessions: 0, openGoals: 0, verifiedOutcomes: 0, path: 'test' }) }) }))
vi.mock('./outcome-ledger.js', () => ({ getOutcomeLedger: () => ({ listRuns: () => runs }) }))

const { buildNovaWorldModel, formatNovaWorldModel } = await import('./world-model.js')

describe('Weltmodell: verifizierte Abläufe aus dem Outcome-Ledger', () => {
    it('zählt validierte, nicht zurückgezogene Läufe des Nutzers', async () => {
        const model = await buildNovaWorldModel('sample')
        expect(model.personal.value.verifiedRuns).toBe(2)
        expect(formatNovaWorldModel(model)).toContain('2 verifizierte Abläufe')
        expect((await buildNovaWorldModel('gast')).personal.value.verifiedRuns).toBe(1)
    })
})
