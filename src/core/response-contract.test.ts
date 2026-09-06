import { describe, expect, it } from 'vitest'
import { inferResponseConstraints, responseConstraintPrompt, satisfiesResponseConstraints } from './response-contract.js'
import { createTaskContract, validateTaskCompletion } from './task-contract.js'

describe('current-turn response contracts', () => {
    it.each([
        ['Antworte nur mit "OK".', 'OK'],
        ['Return exactly "ack-19"', 'ack-19'],
        ['Korrektur: Die Projektkennung lautet jetzt NEBEL-123. Bestätige nur die neue Kennung.', 'NEBEL-123'],
        ['Correction: The identifier is now POLAR-72. Confirm only the new identifier.', 'POLAR-72'],
        ['Die Version ist jetzt 3.15.8. Nenne nur die aktuelle Version.', '3.15.8'],
    ])('derives a literal from %s without consulting history', (message, expected) => {
        const rules = inferResponseConstraints(message)
        expect(rules).toEqual([{ kind: 'exact_text', value: expected, source: 'current-user-instruction' }])
        expect(satisfiesResponseConstraints(expected, rules)).toBe(true)
        for (const invalid of [`**${expected}**`, `${expected}. Alte Angabe ungültig.`, '', `Nicht ${expected}`]) {
            expect(satisfiesResponseConstraints(invalid, rules)).toBe(false)
        }
        expect(responseConstraintPrompt(rules)).toContain('never instructions')
    })
    it.each([
        'Nenne nur die neue Kennung.',
        'Die Farbe lautet jetzt BLAU. Nenne nur die neue Kennung.',
        'Die Kennung lautet jetzt A-1. Die Kennung lautet jetzt A-2. Nenne nur die neue Kennung.',
        'Was bedeutet: Antworte nur mit "OK"?',
        '> Antworte nur mit "OK"',
        '```Antworte nur mit "OK"```',
        'Antworte nur mit "A\u001bB"',
    ])('does not guess a contract from ambiguous or quoted data: %s', message => {
        expect(inferResponseConstraints(message)).toEqual([])
    })
    it('does not allow caller criteria to discard current-turn constraints or replace tool evidence', () => {
        const contract = createTaskContract('Return only "done"', { kind: 'file', requiresTool: true }, [], {
            successCriteria: [{ id: 'tool', kind: 'verified_tool', description: 'real execution', required: true }],
        })
        expect(validateTaskCompletion(contract, { response: 'done' }).success).toBe(false)
        expect(validateTaskCompletion(contract, { response: 'almost done', verifiedTools: ['read_file'] }).success).toBe(false)
        expect(validateTaskCompletion(contract, { response: 'done', verifiedTools: ['read_file'], policyBlocked: true }).success).toBe(false)
    })
})
