import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryGovernanceCoordinator, OPERATIONAL_RETENTION_MS, type GovernedMemory } from './memory-governance.js'
import { isReplicatedMemory } from '../layers/L22-federated-memory.js'

// Live 30.09.2026: 1010 of 1012 governed records were operational tool notes
// (health_status, nova_introspect, mesh_nodes; 30-minute TTL). Each new note
// changed the snapshot, so every peer re-received up to 500 full records.

const root = () => join(process.cwd(), '.nova-test-tmp', `governance-churn-${randomUUID()}`)
const record = (overrides: Partial<GovernedMemory>): GovernedMemory => ({
    id: `mem_${randomUUID()}`, memoryKey: `key-${randomUUID()}`, memoryKeyVersion: 1, content: 'x', kind: 'fact',
    scope: 'user:churn', status: 'verified', confidence: 1, confirmations: 1, createdAt: 1, updatedAt: 1,
    fingerprint: randomUUID(), provenance: [], backends: {}, ...overrides,
} as GovernedMemory)

afterEach(() => vi.restoreAllMocks())

describe('operational notes do not churn replication', () => {
    it('ships only memories that mean something on another node', () => {
        expect(isReplicatedMemory(record({ kind: 'operational', status: 'canonical' }))).toBe(false)
        expect(isReplicatedMemory(record({ kind: 'operational', status: 'superseded' }))).toBe(false)
        expect(isReplicatedMemory(record({ kind: 'fact', status: 'expired' }))).toBe(false)
        expect(isReplicatedMemory(record({ kind: 'preference', status: 'candidate' }))).toBe(false)
        // Real memories and forget tombstones still converge.
        expect(isReplicatedMemory(record({ kind: 'fact', status: 'verified' }))).toBe(true)
        expect(isReplicatedMemory(record({ kind: 'identity', status: 'canonical' }))).toBe(true)
        expect(isReplicatedMemory(record({ kind: 'preference', status: 'superseded' }))).toBe(true)
        expect(isReplicatedMemory(record({ kind: 'preference', status: 'rejected', content: '' }))).toBe(true)
    })

    it('prunes terminal operational notes a day after they ended, and nothing else', () => {
        const dir = root()
        const node = new MemoryGovernanceCoordinator(dir)
        const now = 10 * OPERATIONAL_RETENTION_MS
        const old = now - OPERATIONAL_RETENTION_MS - 1
        const store = (node as any).store
        const keep = {
            recentOperational: record({ kind: 'operational', status: 'superseded', updatedAt: now - 60_000 }),
            liveOperational: record({ kind: 'operational', status: 'canonical', updatedAt: old, expiresAt: now + 60_000 }),
            expiredFact: record({ kind: 'fact', status: 'expired', updatedAt: old }),
            forgotten: record({ kind: 'operational', status: 'rejected', content: '', updatedAt: old }),
        }
        const drop = [record({ kind: 'operational', status: 'superseded', updatedAt: old }),
            record({ kind: 'operational', status: 'expired', updatedAt: old })]
        store.records.push(...Object.values(keep), ...drop)
        vi.spyOn(Date, 'now').mockReturnValue(now)

        const ids = node.getReplicationSnapshot().map(item => item.id)
        for (const item of Object.values(keep)) expect(ids).toContain(item.id)
        for (const item of drop) expect(ids).not.toContain(item.id)
        const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(audit.at(-1)).toMatchObject({ event: 'operational-pruned', count: 2 })
        // Persisted: a restart does not bring them back.
        const restarted = new MemoryGovernanceCoordinator(dir).getReplicationSnapshot().map(item => item.id)
        for (const item of drop) expect(restarted).not.toContain(item.id)
    })
})
