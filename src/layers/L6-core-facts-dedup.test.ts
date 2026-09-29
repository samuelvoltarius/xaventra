import { describe, expect, it } from 'vitest'
import { addFact, getAllFacts, removeFactByGovernanceId } from './L6-core-facts.js'

describe('L6 core facts prefix dedup (R2 L14)', () => {
    it('keeps two governed facts with the same prefix as separate projections', () => {
        const now = new Date().toISOString()
        addFact({ category: 'identity', fact: 'Der User heißt R2L14 Alpha Person', source: 'manual', confidence: 1, updatedAt: now, governanceId: 'r2-l14-a' })
        addFact({ category: 'identity', fact: 'Der User heißt R2L14 Alpha Person und wohnt in Linz', source: 'manual', confidence: 1, updatedAt: now, governanceId: 'r2-l14-b' })
        const ids = getAllFacts().map(f => f.governanceId)
        expect(ids).toContain('r2-l14-a')
        expect(ids).toContain('r2-l14-b')
        expect(removeFactByGovernanceId('r2-l14-a')).toBe(true)
        removeFactByGovernanceId('r2-l14-b')
    })
})
