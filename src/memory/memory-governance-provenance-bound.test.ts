import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_PROVENANCE_ENTRIES, MemoryGovernanceCoordinator, type MemoryProvenance } from './memory-governance.js'

// Live 30.09.2026: one NAS record carried 1566 provenance entries, the governance
// snapshot was 32 MB (upload always failed) and audit.jsonl grew to 16 GB because
// every federated merge appended provenance and audited the whole record.

const root = () => join(process.cwd(), '.nova-test-tmp', `governance-provenance-${randomUUID()}`)
const entries = (count: number): MemoryProvenance[] => Array.from({ length: count }, (_, index) => ({
    source: index === 0 ? 'origin' : `federated:peer-${index % 3}`, evidence: 'manual', timestamp: 1_000 + index, verified: true,
}))

describe('governance provenance stays bounded', () => {
    it('bounds a bloated remote record on merge, keeping origin and newest entries', async () => {
        const source = new MemoryGovernanceCoordinator(root())
        const record = source.propose({ content: 'Prefers local models for private data.', kind: 'preference',
            scope: 'user:bound', source: 'operator', evidence: 'manual', confidence: 1 })!
        const [remote] = source.getReplicationSnapshot().filter(item => item.id === record.id)
        remote.provenance = entries(1566)
        remote.updatedAt += 1

        const dir = root()
        const peer = new MemoryGovernanceCoordinator(dir)
        expect(await peer.mergeReplicationSnapshot([remote], 'nas')).toBe(1)
        const stored = peer.get(record.id)!
        expect(stored.provenance).toHaveLength(MAX_PROVENANCE_ENTRIES)
        expect(stored.provenance[0].source).toBe('origin')
        expect(stored.provenance.at(-1)!.source).toBe('federated:nas')

        const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(audit.at(-1).record.provenance.length).toBeLessThanOrEqual(MAX_PROVENANCE_ENTRIES)
    })

    it('never ships more than the bound in a replication snapshot, even for stored legacy records', async () => {
        const dir = root()
        const node = new MemoryGovernanceCoordinator(dir)
        const record = node.propose({ content: 'Uses the Spark as main node.', kind: 'fact',
            scope: 'user:bound', source: 'operator', evidence: 'manual', confidence: 1 })!
        // Simulate a legacy record loaded from disk with unbounded provenance.
        ;(node as any).store.records.find((item: any) => item.id === record.id).provenance = entries(900)
        const shipped = node.getReplicationSnapshot().find(item => item.id === record.id)!
        expect(shipped.provenance).toHaveLength(MAX_PROVENANCE_ENTRIES)
        expect(JSON.stringify(shipped).length).toBeLessThan(10_000)
    })

    it('stays bounded across repeated merges between peers', async () => {
        const a = new MemoryGovernanceCoordinator(root())
        const b = new MemoryGovernanceCoordinator(root())
        const record = a.propose({ content: 'Answers in German.', kind: 'preference',
            scope: 'user:bound', source: 'operator', evidence: 'manual', confidence: 1 })!
        let current = a.getReplicationSnapshot().find(item => item.id === record.id)!
        for (let round = 0; round < 80; round++) {
            current = { ...current, updatedAt: current.updatedAt + 1 }
            const target = round % 2 ? a : b
            await target.mergeReplicationSnapshot([current], round % 2 ? 'node-b' : 'node-a')
            current = target.getReplicationSnapshot().find(item => item.id === record.id)!
        }
        expect(current.provenance.length).toBeLessThanOrEqual(MAX_PROVENANCE_ENTRIES)
    })
})
