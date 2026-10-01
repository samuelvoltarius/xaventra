/**
 * Nova — Synthesis Layer Tests
 *
 * Covers: sandbox (code isolation + static validation),
 *         self-evolution (stats + history, NOT the live evolve() pipeline)
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest'

// ============================================
// Sandbox
// ============================================

describe('Self Evolution', async () => {
    const {
        getEvolutionHistory, getEvolutionStats,
        isEvolutionActive, getActiveEvolution,
        getPatchProposals,
    } = await import('./self-evolution.js')

    it('getEvolutionHistory: returns array', () => {
        const history = getEvolutionHistory()
        expect(Array.isArray(history)).toBe(true)
    })

    it('getEvolutionHistory: respects limit parameter', () => {
        const history = getEvolutionHistory(5)
        expect(history.length).toBeLessThanOrEqual(5)
    })

    it('getEvolutionStats: returns valid structure', () => {
        const stats = getEvolutionStats()
        expect(typeof stats.total).toBe('number')
        expect(typeof stats.successful).toBe('number')
        expect(typeof stats.failed).toBe('number')
        expect(stats.total).toBeGreaterThanOrEqual(0)
        expect(stats.successful + stats.failed).toBeLessThanOrEqual(stats.total)
    })

    it('isEvolutionActive: returns boolean', () => {
        expect(typeof isEvolutionActive()).toBe('boolean')
    })

    it('isEvolutionActive: false when no evolution running in test env', () => {
        // In test env no evolution is triggered
        expect(isEvolutionActive()).toBe(false)
    })

    it('getActiveEvolution: returns null or string', () => {
        const active = getActiveEvolution()
        expect(active === null || typeof active === 'string').toBe(true)
    })

    it('getPatchProposals: returns array', () => {
        const proposals = getPatchProposals()
        expect(Array.isArray(proposals)).toBe(true)
    })

    it('getEvolutionStats: successful <= total', () => {
        const stats = getEvolutionStats()
        expect(stats.successful).toBeLessThanOrEqual(stats.total)
        expect(stats.failed).toBeLessThanOrEqual(stats.total)
    })
})
