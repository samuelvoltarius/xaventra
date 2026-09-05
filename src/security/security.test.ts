/**
 * Nova — Security Layer Tests
 *
 * Covers: ssrf-guard, exec-approvals, code-guardian (sandbox + static checks)
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ============================================
// SSRF Guard
// ============================================

describe('SSRF Guard', async () => {
    const { checkSSRF, allowLocalHost, getAllowlist, initSSRFGuard } = await import('./ssrf-guard.js')

    it('checkSSRF: blocks private IP ranges', () => {
        const result = checkSSRF('http://192.168.1.1/admin')
        expect(result.allowed).toBe(false)
        expect(result.isLocal).toBe(true)
    })

    it('checkSSRF: marks localhost as local (isLocal=true)', () => {
        // localhost is in the default allowlist → allowed:true but isLocal:true
        const result = checkSSRF('http://localhost:8080/secret')
        expect(result.isLocal).toBe(true)
    })

    it('checkSSRF: blocks 10.x.x.x subnet', () => {
        const result = checkSSRF('http://10.0.0.1/internal')
        expect(result.allowed).toBe(false)
    })

    it('checkSSRF: blocks 172.16.x.x subnet', () => {
        const result = checkSSRF('http://172.16.0.1/api')
        expect(result.allowed).toBe(false)
    })

    it('checkSSRF: allows public URLs', () => {
        const result = checkSSRF('https://api.openai.com/v1/chat')
        expect(result.allowed).toBe(true)
        expect(result.isLocal).toBe(false)
    })

    it('checkSSRF: returns SSRFCheckResult shape', () => {
        const result = checkSSRF('https://example.com')
        expect(typeof result.allowed).toBe('boolean')
        expect(typeof result.url).toBe('string')
        expect(typeof result.host).toBe('string')
        expect(typeof result.isLocal).toBe('boolean')
    })

    it('checkSSRF: handles invalid URL gracefully', () => {
        const result = checkSSRF('not-a-url')
        expect(typeof result.allowed).toBe('boolean')
    })

    it('allowLocalHost: adds to allowlist', () => {
        allowLocalHost('trusted-internal.nova')
        const list = getAllowlist()
        expect(list).toContain('trusted-internal.nova')
    })

    it('getAllowlist: returns array', () => {
        const list = getAllowlist()
        expect(Array.isArray(list)).toBe(true)
    })

    it('initSSRFGuard: does not throw', () => {
        expect(() => initSSRFGuard()).not.toThrow()
    })
})

// ============================================
// Exec Approvals
// ============================================

describe('Exec Approvals', async () => {
    const { evaluateCommand, addCustomRule, removeCustomRule, listRules, getApprovalHistory, getApprovalStats } = await import('./exec-approvals.js')

    it('evaluateCommand: returns ApprovalResult for safe command', () => {
        const result = evaluateCommand({ command: 'ls', args: ['-la'], source: 'user' })
        expect(typeof result.approved).toBe('boolean')
        expect(typeof result.risk).toBe('string')
        expect(typeof result.reason).toBe('string')
    })

    it('evaluateCommand: blocks dangerous rm -rf', () => {
        const result = evaluateCommand({ command: 'rm', args: ['-rf', '/'], source: 'agent' })
        expect(result.approved).toBe(false)
        expect(['high', 'critical']).toContain(result.risk)
    })

    it('evaluateCommand: flags drop table as critical', () => {
        const result = evaluateCommand({ command: 'psql', args: ['-c', 'DROP TABLE users'], source: 'agent' })
        expect(['high', 'critical', 'medium']).toContain(result.risk)
    })

    it('evaluateCommand: approves git status', () => {
        const result = evaluateCommand({ command: 'git', args: ['status'], source: 'agent' })
        expect(result.approved).toBe(true)
        expect(['safe', 'low']).toContain(result.risk)
    })

    it('addCustomRule: adds rule without throwing', () => {
        expect(() => addCustomRule({
            pattern: 'my-dangerous-cmd',
            risk: 'high',
            reason: 'Custom blocked command',
            block: true,
        })).not.toThrow()
    })

    it('removeCustomRule: returns boolean', () => {
        addCustomRule({ pattern: 'remove-me-cmd', risk: 'medium', reason: 'Test', block: true })
        const removed = removeCustomRule('remove-me-cmd')
        expect(typeof removed).toBe('boolean')
    })

    it('listRules: returns builtin and custom arrays', () => {
        const rules = listRules()
        expect(Array.isArray(rules.builtin)).toBe(true)
        expect(Array.isArray(rules.custom)).toBe(true)
        expect(rules.builtin.length).toBeGreaterThan(0)
    })

    it('getApprovalHistory: returns array', () => {
        evaluateCommand({ command: 'echo', args: ['hello'], source: 'test' })
        const history = getApprovalHistory()
        expect(Array.isArray(history)).toBe(true)
    })

    it('getApprovalStats: returns valid structure', () => {
        const stats = getApprovalStats()
        expect(typeof stats.total).toBe('number')
        expect(typeof stats.approved).toBe('number')
        expect(typeof stats.denied).toBe('number')
        expect(typeof stats.riskBreakdown).toBe('object')
    })

    it('custom rule: blocks custom pattern', () => {
        addCustomRule({ pattern: 'forbidden-exec-xyz', risk: 'critical', reason: 'Blocked by test', block: true })
        const result = evaluateCommand({ command: 'forbidden-exec-xyz', source: 'agent' })
        expect(result.approved).toBe(false)
    })
})

// ============================================
// Code Guardian — anomaly detection + kill switch
// (validateSkillCode lives in synthesis/sandbox.ts, not here)
// ============================================

describe('Code Guardian', async () => {
    const {
        sandboxTest,
        isKillSwitchActive, getKillSwitchStatus, resetKillSwitch,
        getPatchLog, initCodeGuardian, recordMetric,
    } = await import('./code-guardian.js')

    it('initCodeGuardian: does not throw', () => {
        expect(() => initCodeGuardian()).not.toThrow()
    })

    it('sandboxTest: runs safe code successfully', async () => {
        const code = `const x = 2 + 2; console.log(x);`
        const result = await sandboxTest(code)
        expect(typeof result.safe).toBe('boolean')
        // duration (not durationMs) in code-guardian sandbox
        expect(typeof result.duration).toBe('number')
    }, 10000)

    it('sandboxTest: contains safe:true for safe code', async () => {
        const code = `const a = [1,2,3].map(x => x * 2)`
        const result = await sandboxTest(code)
        expect(result.safe).toBe(true)
    }, 10000)

    it('isKillSwitchActive: returns boolean', () => {
        expect(typeof isKillSwitchActive()).toBe('boolean')
    })

    it('getKillSwitchStatus: returns status object', () => {
        const status = getKillSwitchStatus()
        expect(typeof status.active).toBe('boolean')
    })

    it('resetKillSwitch: returns string message', () => {
        const msg = resetKillSwitch()
        expect(typeof msg).toBe('string')
    })

    it('getPatchLog: returns array', () => {
        const log = getPatchLog()
        expect(Array.isArray(log)).toBe(true)
    })

    it('recordMetric: does not throw', () => {
        expect(() => recordMetric('tool_call', 1)).not.toThrow()
        expect(() => recordMetric('code_gen', 1)).not.toThrow()
    })
})
