import { describe, expect, it } from 'vitest'
import { createTaskContract, validateTaskCompletion } from './task-contract.js'

describe('TaskContract', () => {
    it('does not approve a policy-blocked run even after one earlier successful tool', () => {
        const contract = createTaskContract('Lies beide Dateien', { requiresTool: true, kind: 'file' })
        const result = validateTaskCompletion(contract, { response: 'Gesperrt', verifiedTools: ['read_file'], policyBlocked: true })
        expect(result.success).toBe(false)
        expect(result.violations).toContain('execution stopped by policy')
    })
    it('accepts a conversational task only with a real response', () => {
        const contract = createTaskContract('Erkläre Nova', { requiresTool: false, kind: 'none' })
        expect(validateTaskCompletion(contract, { response: '' }).success).toBe(false)
        expect(validateTaskCompletion(contract, { response: 'Nova ist ein Agent OS.' }).success).toBe(true)
    })

    it('does not accept an action without verified tool evidence', () => {
        const contract = createTaskContract('Schreibe eine Datei', { requiresTool: true, kind: 'file' })
        expect(validateTaskCompletion(contract, { response: 'Erledigt.' }).success).toBe(false)
        expect(validateTaskCompletion(contract, { response: 'Erledigt.', verifiedTools: ['write_file'] }).success).toBe(true)
    })

    it('enforces timeout and tool-call budgets', () => {
        const contract = createTaskContract('Prüfe System', { requiresTool: true, kind: 'system-state' }, [], {
            budget: { timeoutMs: 100, maxToolCalls: 1 },
        })
        const report = validateTaskCompletion(contract, {
            response: 'Geprüft', verifiedTools: ['health_status'], durationMs: 101, toolCalls: 2,
        })
        expect(report.success).toBe(false)
        expect(report.violations).toContain('timeout budget exceeded')
        expect(report.violations).toContain('tool-call budget exceeded')
    })
})
