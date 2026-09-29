import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryGovernanceCoordinator, type MemoryEvidence } from './memory-governance.js'

function coordinator(root = join(process.cwd(), '.nova-test-tmp', `governance-forget-${randomUUID()}`)) {
    return new MemoryGovernanceCoordinator(root)
}

const fact = 'Alice arbeitet dienstags immer im Homeoffice in Salzburg.'

function forgotten(governance: MemoryGovernanceCoordinator) {
    const record = governance.propose({
        content: fact, kind: 'fact', scope: 'user:alice', source: 'alice',
        evidence: 'explicit_user_instruction', confidence: 1, verified: true,
        subject: 'alice', predicate: 'homeoffice_day',
    })!
    governance.reject(record.id, 'user-forget:alice')
    return record
}

describe('forgetting is a durable barrier against weaker evidence (H8)', () => {
    for (const evidence of ['distillation', 'user_statement', 'model_inference'] as MemoryEvidence[]) {
        it(`does not recreate a rejected fact from ${evidence} with the same content`, () => {
            const governance = coordinator()
            forgotten(governance)
            const revived = governance.propose({
                content: fact, kind: 'fact', scope: 'user:alice', source: `replay:${evidence}`,
                evidence, confidence: 0.95, verified: true,
            })
            expect(revived).toBeNull()
            expect(governance.getContextForPrompt('user:alice', 'Homeoffice dienstags')).toBe('')
            expect(governance.list().filter(item => item.status !== 'rejected')).toEqual([])
        })
    }

    it('does not recreate a rejected memory key from weak evidence with reworded content', () => {
        const governance = coordinator()
        forgotten(governance)
        const revived = governance.propose({
            content: 'Alice ist jeden Dienstag im Homeoffice in Salzburg tätig.', kind: 'fact', scope: 'user:alice',
            source: 'distiller:2026-09-30', evidence: 'distillation', confidence: 0.9, verified: true,
            subject: 'alice', predicate: 'homeoffice_day',
        })
        expect(revived).toBeNull()
    })

    it('keeps the barrier across a restart', () => {
        const root = join(process.cwd(), '.nova-test-tmp', `governance-forget-${randomUUID()}`)
        forgotten(coordinator(root))
        const restarted = coordinator(root)
        expect(restarted.propose({
            content: fact, kind: 'fact', scope: 'user:alice', source: 'distiller:replay',
            evidence: 'distillation', confidence: 0.9, verified: true,
        })).toBeNull()
    })

    it('still lets an explicit instruction deliberately re-enter the fact', () => {
        const governance = coordinator()
        const old = forgotten(governance)
        const reentered = governance.propose({
            content: fact, kind: 'fact', scope: 'user:alice', source: 'alice-again',
            evidence: 'explicit_user_instruction', confidence: 1, verified: true,
            subject: 'alice', predicate: 'homeoffice_day',
        })
        expect(reentered?.status).toBe('canonical')
        expect(reentered?.supersedes).toBe(old.id)
    })

    it('does not let another scope\'s rejection block this scope', () => {
        const governance = coordinator()
        forgotten(governance)
        const other = governance.propose({
            content: fact, kind: 'fact', scope: 'user:bob', source: 'bob',
            evidence: 'user_statement', confidence: 0.9, verified: true,
        })
        expect(other?.status).toBe('verified')
    })
})
