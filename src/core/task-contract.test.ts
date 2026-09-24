import { describe, expect, it } from 'vitest'
import { createTaskContract, validateTaskCompletion } from './task-contract.js'

describe('TaskContract', () => {
    it('rejects explicitly incomplete synthesis despite verified tool calls', () => {
        const contract = createTaskContract('Recherchiere einen Fotografen', { requiresTool: true, kind: 'web' })
        const report = validateTaskCompletion(contract, { response: 'Teilbeobachtungen', verifiedTools: ['web_search'], completionStatus: 'incomplete' } as any)
        expect(report.success).toBe(false)
        expect(report.violations).toContain('task synthesis incomplete')
    })
    it('rejects a correction reply repeating the superseded value despite a nonempty response', () => {
        const contract = createTaskContract('Korrektur: Die Projektkennung lautet jetzt ORBIT-42. Die vorherige Kennung ist ungültig. Bestätige nur die neue Kennung.', { requiresTool: false, kind: 'none' })
        expect(validateTaskCompletion(contract, { response: 'Bestätigt: **ORBIT-42**. (ORBIT-41 ist ungültig.)' }).success).toBe(false)
        expect(validateTaskCompletion(contract, { response: 'ORBIT-42' }).success).toBe(true)
    })
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

    it('does not let legacy tool-name evidence bypass explicit target binding', () => {
        const contract = createTaskContract('Lies die Datei required.txt', { requiresTool: true, kind: 'file' }, ['read_file'])
        const report = validateTaskCompletion(contract, { response: 'Erledigt.', verifiedTools: ['read_file'] })
        expect(report.success).toBe(false)
        expect(report.criteria[0].reason).toContain('required.txt')
    })

    it('does not misclassify versions or untyped host names as file targets', () => {
        const install = createTaskContract('Installiere Version 2.78.26 auf node.example.com', { requiresTool: true, kind: 'device-action' }, ['deploy'])
        const web = createTaskContract('Recherchiere https://example.com/status', { requiresTool: true, kind: 'web' }, ['fetch_url'])
        expect(install.requiredToolTargets).toBeUndefined()
        expect(web.requiredToolTargets).toEqual(['https://example.com/status'])
    })

    it('separates multiple Unix paths and preserves a quoted path with spaces', () => {
        const unix = createTaskContract('Lies /home/runner/a.txt und /home/runner/b.txt mit read_file', { requiresTool: true, kind: 'file' }, ['read_file'])
        const quoted = createTaskContract('Lies "C:\\Work Area\\a.txt" mit read_file', { requiresTool: true, kind: 'file' }, ['read_file'])
        expect(unix.requiredToolTargets).toEqual(['/home/runner/a.txt', '/home/runner/b.txt'])
        expect(quoted.requiredToolTargets).toEqual(['c:/work area/a.txt'])
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
