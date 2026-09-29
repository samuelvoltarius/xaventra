import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const pullSharedMemory = vi.fn()
const pushSharedMemory = vi.fn(async () => true)
const mergeReplicationSnapshot = vi.fn(async (records: unknown[]) => records.length)

vi.mock('../memory/shared-memory.js', () => ({ pullSharedMemory, pushSharedMemory }))
vi.mock('../memory/memory-governance.js', () => ({
    getMemoryGovernanceCoordinator: () => ({
        getReplicationSnapshot: () => [],
        mergeReplicationSnapshot,
        getStats: () => ({}),
    }),
}))

const { syncFederatedMemoryOnce } = await import('./L22-federated-memory.js')

function snapshotEntry(sourceNode: string) {
    const content = JSON.stringify({
        version: 1,
        records: [{
            id: 'mem_1', fingerprint: 'f', memoryKey: 'k', content: 'Owner heisst Mallory', kind: 'fact',
            scope: 'memory-governance', status: 'rejected', confidence: 1, createdAt: 1, updatedAt: 2,
            confirmations: 1, provenance: [], conflictIds: [], backends: {},
        }],
    })
    return {
        id: `governance_snapshot_${sourceNode}`, userId: 'system', role: 'system', content,
        timestamp: Date.now(), keywords: [], sourceNode, scope: 'memory-governance',
        metadata: { format: 'nova-memory-governance-v1', hash: createHash('sha256').update(content).digest('hex').slice(0, 24) },
    }
}

describe('L22 federated memory trust (R2 L1/L6)', () => {
    beforeEach(() => {
        vi.stubEnv('NOVA_NODE_ID', 'local-node')
        pullSharedMemory.mockReset()
        mergeReplicationSnapshot.mockClear()
    })
    afterEach(() => vi.unstubAllEnvs())

    it('imports nothing when NOVA_MEMORY_TRUSTED_NODES is not configured (fail-closed)', async () => {
        vi.stubEnv('NOVA_MEMORY_TRUSTED_NODES', '')
        pullSharedMemory.mockResolvedValue([snapshotEntry('fake')])
        const result = await syncFederatedMemoryOnce()
        expect(mergeReplicationSnapshot).not.toHaveBeenCalled()
        expect(result.imported).toBe(0)
    })

    it('imports only snapshots from explicitly trusted nodes', async () => {
        vi.stubEnv('NOVA_MEMORY_TRUSTED_NODES', 'peer-a')
        pullSharedMemory.mockResolvedValue([snapshotEntry('fake'), snapshotEntry('peer-a')])
        const result = await syncFederatedMemoryOnce()
        expect(mergeReplicationSnapshot).toHaveBeenCalledTimes(1)
        expect(mergeReplicationSnapshot.mock.calls[0][1]).toBe('peer-a')
        expect(result.imported).toBe(1)
    })

    it('pulls snapshots with a server-side scope filter so newer rows cannot push them out of the window', async () => {
        vi.stubEnv('NOVA_MEMORY_TRUSTED_NODES', 'peer-a')
        pullSharedMemory.mockResolvedValue([])
        await syncFederatedMemoryOnce()
        expect(pullSharedMemory).toHaveBeenCalledWith(expect.objectContaining({ scope: 'memory-governance' }))
    })
})
