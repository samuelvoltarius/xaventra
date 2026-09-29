import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryGovernanceCoordinator } from './memory-governance.js'

// MA-15, decided 30.09.: forgetting really forgets. The barrier keeps only
// fingerprint + memory key; the text leaves store, backup and audit log.
const SECRET = 'Alfreds Tresorcode im Keller lautet sieben drei neun.'
const root = () => join(process.cwd(), '.nova-test-tmp', `governance-hash-${randomUUID()}`)
const files = (dir: string) => ['records.json', 'records.json.bak', 'audit.jsonl']
    .map(name => join(dir, name)).filter(existsSync).map(path => readFileSync(path, 'utf8')).join('\n')

function remembered(dir: string) {
    const governance = new MemoryGovernanceCoordinator(dir)
    const record = governance.propose({ content: SECRET, kind: 'fact', scope: 'user:owner', source: 'operator', evidence: 'manual', confidence: 1 })!
    return { governance, record }
}

describe('hash-only forget tombstones', () => {
    it('removes the plaintext from store, backup and every audit line', () => {
        const dir = root()
        const { governance, record } = remembered(dir)
        expect(files(dir)).toContain('Tresorcode')
        governance.reject(record.id, 'user-forget:owner')
        expect(files(dir)).not.toContain('Tresorcode')
        expect(governance.get(record.id)!.content).toBe('')
        expect(governance.get(record.id)!.fingerprint).toBeTruthy()
    })

    it('still blocks the identical fact from coming back through inference', () => {
        const dir = root()
        const { governance, record } = remembered(dir)
        governance.reject(record.id)
        const again = governance.propose({ content: SECRET, kind: 'fact', scope: 'user:owner', source: 'distiller', evidence: 'model_inference', confidence: 0.9 })
        expect(again).toBeNull()
    })

    it('survives a restart without the plaintext', () => {
        const dir = root()
        const { governance, record } = remembered(dir)
        governance.reject(record.id)
        const reloaded = new MemoryGovernanceCoordinator(dir)
        expect(reloaded.get(record.id)!.status).toBe('rejected')
        expect(reloaded.get(record.id)!.content).toBe('')
    })

    it('replicates the hash-only tombstone to a peer', async () => {
        const [a, b] = [root(), root()]
        const { governance, record } = remembered(a)
        const peer = new MemoryGovernanceCoordinator(b)
        expect(await peer.mergeReplicationSnapshot(governance.getReplicationSnapshot(), 'node-a')).toBeGreaterThan(0)
        governance.reject(record.id)
        expect(await peer.mergeReplicationSnapshot(governance.getReplicationSnapshot(), 'node-a')).toBe(1)
        expect(peer.get(record.id)!.status).toBe('rejected')
        expect(files(b)).not.toContain('Tresorcode')
    })

    it('scrubs a plaintext tombstone sent by an older peer', async () => {
        const dir = root()
        const peer = new MemoryGovernanceCoordinator(dir)
        const { governance, record } = remembered(root())
        const old = { ...governance.get(record.id)!, status: 'rejected' as const, memoryKeyVersion: 5, updatedAt: Date.now() + 1000 }
        expect(await peer.mergeReplicationSnapshot([old], 'old-node')).toBe(1)
        expect(peer.get(record.id)!.content).toBe('')
        expect(files(dir)).not.toContain('Tresorcode')
    })
})
