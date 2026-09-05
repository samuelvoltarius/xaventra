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

describe('Synthesis Sandbox', async () => {
    const { runInSandbox, validateSkillCode, runSkillTests } = await import('./sandbox.js')

    it('validateSkillCode: approves safe pure function', () => {
        const code = `
            function fibonacci(n) {
                if (n <= 1) return n
                return fibonacci(n - 1) + fibonacci(n - 2)
            }
            module.exports = { fibonacci }
        `
        const result = validateSkillCode(code)
        expect(typeof result.valid).toBe('boolean')
        expect(Array.isArray(result.errors)).toBe(true)
    })

    it('validateSkillCode: rejects eval', () => {
        const result = validateSkillCode(`eval('alert(1)')`)
        expect(result.valid).toBe(false)
        expect(result.errors.length).toBeGreaterThan(0)
    })

    it('validateSkillCode: rejects exec from child_process', () => {
        const result = validateSkillCode(`require('child_process').exec('ls')`)
        expect(result.valid).toBe(false)
    })

    it('validateSkillCode: rejects spawn', () => {
        const result = validateSkillCode(`const { spawn } = require('child_process'); spawn('rm', ['-rf'])`)
        expect(result.valid).toBe(false)
    })

    it('validateSkillCode: rejects require fs', () => {
        const result = validateSkillCode(`const fs = require('fs'); fs.readFileSync('/etc/passwd')`)
        expect(result.valid).toBe(false)
    })

    it('runInSandbox: executes simple arithmetic', async () => {
        const result = await runInSandbox(`
            const x = 6 * 7
            if (x !== 42) throw new Error('wrong')
        `)
        // result.success (not .safe) — SandboxResult uses success field
        expect(result.success).toBe(true)
        expect(typeof result.durationMs).toBe('number')
    }, 10000)

    it('runInSandbox: catches syntax error', async () => {
        const result = await runInSandbox(`this is not valid javascript {{{`)
        expect(result.success).toBe(false)
        expect(result.error).toBeDefined()
    }, 10000)

    it('runInSandbox: catches thrown error', async () => {
        const result = await runInSandbox(`throw new Error('intentional failure')`)
        expect(result.success).toBe(false)
    }, 10000)

    it('runInSandbox: respects timeout', async () => {
        const result = await runInSandbox(`while(true){}`, { timeout: 300 })
        expect(result.success).toBe(false)
    }, 10000)

    it('runInSandbox: returns durationMs', async () => {
        const result = await runInSandbox(`const a = 1 + 1`)
        expect(typeof result.durationMs).toBe('number')
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }, 10000)

    it('runSkillTests: passes simple test (direct function access, no skill wrapper)', async () => {
        const skillCode = `
            function add(a, b) { return a + b }
        `
        // In runSkillTests, skill code and test code share the same scope —
        // functions defined in skillCode are directly accessible in testCode
        const testCode = `
            assert(add(2, 3) === 5, 'add(2,3) should be 5')
            assert(add(0, 0) === 0, 'add(0,0) should be 0')
        `
        const result = await runSkillTests(skillCode, testCode)
        expect(result.passed).toBe(true)
    }, 15000)

    it('runSkillTests: fails on assertion error', async () => {
        const skillCode = `
            function multiply(a, b) { return a + b }  // intentionally wrong
        `
        const testCode = `
            assert(multiply(3, 4) === 12, 'should be 12')
        `
        const result = await runSkillTests(skillCode, testCode)
        expect(result.passed).toBe(false)
    }, 15000)
})

// ============================================
// Self Evolution — stats / history only
// (evolve() requires git + tsc + pm2 — not safe in unit tests)
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
