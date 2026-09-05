import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryGovernanceCoordinator } from './memory-governance.js'
import { MemoryRetrievalEvaluator } from './retrieval-evaluator.js'

describe('memory retrieval evaluator', () => {
    it('measures recall and cross-user leakage with real governed records', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-memory-eval-'))
        const governance = new MemoryGovernanceCoordinator(dir)
        const alice = governance.propose({ content: 'Alice bevorzugt für Code immer TypeScript und Vitest.', kind: 'preference', scope: 'user:alice', source: 'alice', evidence: 'manual', confidence: 1 })!
        const bob = governance.propose({ content: 'Bob bevorzugt für Code immer Python und Pytest.', kind: 'preference', scope: 'user:bob', source: 'bob', evidence: 'manual', confidence: 1 })!
        const report = new MemoryRetrievalEvaluator(governance).run([{ id: 'alice-pref', scope: 'user:alice', query: 'Welche Sprache bevorzuge ich für Code?', expectedIds: [alice.id], forbiddenIds: [bob.id] }])
        expect(report.recallAtK).toBe(1)
        expect(report.scopeLeakageRate).toBe(0)
        expect(report.passed).toBe(true)
        rmSync(dir, { recursive: true, force: true })
    })
})
