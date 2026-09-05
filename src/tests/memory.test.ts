/**
 * Memory Enhancement Tests
 *
 * Tests for MMR, temporal decay, hybrid search, query expansion,
 * and multi-provider embeddings.
 */

import { describe, it, expect } from 'vitest'
import { mmrRerank, tokenize, jaccardSimilarity } from '../memory/mmr.js'
import { calculateDecayMultiplier, applyDecayToResults } from '../memory/temporal-decay.js'
import { keywordScore, mergeHybridResults } from '../memory/hybrid-search.js'
import { expandQueryRuleBased } from '../memory/query-expansion.js'

// ============================================
// MMR Tests
// ============================================

describe('MMR Re-ranking', () => {
    it('should return items in diversity-balanced order', () => {
        const items = [
            { id: '1', score: 0.9, content: 'the cat sat on the mat' },
            { id: '2', score: 0.85, content: 'the cat sat on the rug' }, // very similar to 1
            { id: '3', score: 0.8, content: 'dogs love to play fetch' }, // diverse
            { id: '4', score: 0.75, content: 'the cat sat on the floor' }, // similar to 1
        ]

        const result = mmrRerank(items, { enabled: true, lambda: 0.5 })

        // First should still be highest score
        expect(result[0].id).toBe('1')
        // Dog item should be promoted due to diversity
        expect(result[1].id).toBe('3')
    })

    it('should return unchanged if disabled', () => {
        const items = [
            { id: '1', score: 0.9, content: 'hello world' },
            { id: '2', score: 0.8, content: 'hello world again' },
        ]

        const result = mmrRerank(items, { enabled: false })
        expect(result).toEqual(items)
    })

    it('should handle empty input', () => {
        expect(mmrRerank([])).toEqual([])
    })

    it('should handle single item', () => {
        const items = [{ id: '1', score: 0.9, content: 'test' }]
        expect(mmrRerank(items, { enabled: true })).toEqual(items)
    })
})

describe('Tokenization', () => {
    it('should tokenize and lowercase', () => {
        const tokens = tokenize('Hello World 123')
        expect(tokens.has('hello')).toBe(true)
        expect(tokens.has('world')).toBe(true)
        expect(tokens.has('123')).toBe(true)
    })

    it('should handle German characters', () => {
        const tokens = tokenize('Über schöne Straße')
        expect(tokens.has('über')).toBe(true)
        expect(tokens.has('schöne')).toBe(true)
        expect(tokens.has('straße')).toBe(true)
    })
})

describe('Jaccard Similarity', () => {
    it('should return 1 for identical sets', () => {
        const a = new Set(['hello', 'world'])
        expect(jaccardSimilarity(a, a)).toBe(1)
    })

    it('should return 0 for disjoint sets', () => {
        const a = new Set(['hello'])
        const b = new Set(['world'])
        expect(jaccardSimilarity(a, b)).toBe(0)
    })

    it('should calculate partial overlap', () => {
        const a = new Set(['a', 'b', 'c'])
        const b = new Set(['b', 'c', 'd'])
        // intersection = {b, c} = 2, union = {a, b, c, d} = 4
        expect(jaccardSimilarity(a, b)).toBe(0.5)
    })
})

// ============================================
// Temporal Decay Tests
// ============================================

describe('Temporal Decay', () => {
    it('should return 1 for fresh items', () => {
        const multiplier = calculateDecayMultiplier(0, 30)
        expect(multiplier).toBe(1)
    })

    it('should return ~0.5 at half-life', () => {
        const multiplier = calculateDecayMultiplier(30, 30)
        expect(multiplier).toBeCloseTo(0.5, 1)
    })

    it('should return small value for old items', () => {
        const multiplier = calculateDecayMultiplier(120, 30) // 4 half-lives
        expect(multiplier).toBeLessThan(0.1)
    })

    it('should apply decay to results', () => {
        const now = Date.now()
        const results = [
            { score: 1.0, timestamp: now }, // fresh
            { score: 1.0, timestamp: now - 30 * 24 * 60 * 60 * 1000 }, // 30 days old
        ]

        const decayed = applyDecayToResults(results, { enabled: true, halfLifeDays: 30 }, now)

        expect(decayed[0].score).toBeCloseTo(1.0, 1)
        expect(decayed[1].score).toBeCloseTo(0.5, 1)
    })

    it('should not decay when disabled', () => {
        const results = [{ score: 1.0, timestamp: 0 }]
        const decayed = applyDecayToResults(results, { enabled: false })
        expect(decayed[0].score).toBe(1.0)
    })
})

// ============================================
// Hybrid Search Tests
// ============================================

describe('Keyword Scoring', () => {
    it('should score matching content higher', () => {
        const score1 = keywordScore('server ip', 'The server IP is 192.168.1.1')
        const score2 = keywordScore('server ip', 'Today I went shopping for groceries')
        expect(score1).toBeGreaterThan(score2)
    })

    it('should return 0 for no matches', () => {
        expect(keywordScore('xyz', 'abc def ghi')).toBe(0)
    })
})

describe('Hybrid Merge', () => {
    it('should combine vector and keyword scores', () => {
        const candidates = [
            { id: '1', content: 'server ip address', timestamp: Date.now(), vectorScore: 0.9, keywordScore: 0.8 },
            { id: '2', content: 'shopping list', timestamp: Date.now(), vectorScore: 0.3, keywordScore: 0.1 },
        ]

        const results = mergeHybridResults(candidates)
        expect(results[0].id).toBe('1')
        expect(results[0].score).toBeGreaterThan(results[1].score)
    })
})

// ============================================
// Query Expansion Tests
// ============================================

describe('Query Expansion (Rule-based)', () => {
    it('should expand IP-related queries', () => {
        const expanded = expandQueryRuleBased('welche IP?')
        expect(expanded).toContain('IP-Adresse')
        expect(expanded).toContain('Server')
    })

    it('should expand password queries', () => {
        const expanded = expandQueryRuleBased('passwort vergessen')
        expect(expanded).toContain('Zugangsdaten')
    })

    it('should expand error queries', () => {
        const expanded = expandQueryRuleBased('fehler beim deploy')
        expect(expanded).toContain('Lösung')
    })

    it('should not expand unrelated queries', () => {
        const query = 'wie geht es dir'
        const expanded = expandQueryRuleBased(query)
        expect(expanded).toBe(query)
    })
})
