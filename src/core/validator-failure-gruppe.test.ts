import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OutcomeLedger } from './outcome-ledger.js'
import { createTaskContract } from './task-contract.js'
import { detectActionIntent } from './action-intent.js'
import { FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { reconcileValidatorFailures } from './validator-failure-escalation.js'

// Punkt 8 (2.83.0): ein Doctor-Fall je Fehlerbild (Aufgabenart + Kriterien), nicht je Lauf.
const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })

function setup() {
    const path = mkdtempSync(join(tmpdir(), 'validator-gruppe-')); paths.push(path)
    const ledger = new OutcomeLedger(join(path, 'ledger'), false)
    const doctor = new FailureResearchCoordinator(join(path, 'queue.json'))
    const reject = (taskType: string, kind: 'verified_tool' | 'response_present' = 'verified_tool', userId = 'owner@example.com') => {
        const contract = createTaskContract('lies https://example.com/bericht', detectActionIntent('lies https://example.com/bericht'), [], {
            successCriteria: [{ id: 'target', kind, required: true, description: 'privates Ziel example.com' }],
        })
        ledger.start(contract, { userId, channel: 'telegram' })
        ledger.recordRoute(contract.id, { taskType })
        ledger.recordValidation(contract.id, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
            success: false, awaitingApproval: false, criteria: [{ criterionId: 'target', success: false, evidence: [], reason: 'privat-grund' }], violations: [] })
        ledger.fail(contract.id, { reason: 'validator-rejected', diagnosticEligible: true })
        return contract.id
    }
    return { ledger, doctor, reject }
}
const runRefs = (doctor: FailureResearchCoordinator) => doctor.list().flatMap(item => item.evidenceRefs.filter(ref => ref.startsWith('validator-run:')))

describe('Validator-Fehlschläge gruppieren (Punkt 8)', () => {
    it('fünf abgelehnte Läufe mit gleichem Fehlerbild ergeben genau einen Fall mit fünf Belegen', () => {
        const f = setup()
        for (let i = 0; i < 5; i++) f.reject('recherche')
        expect(reconcileValidatorFailures(f.ledger, f.doctor)).toBe(1)
        expect(f.doctor.list()).toHaveLength(1)
        expect(runRefs(f.doctor)).toHaveLength(5)
        const [item] = f.doctor.list()
        expect(item.findingId).toMatch(/^validator-failure-[a-f0-9]{64}$/)
        expect(item.hypothesis).toContain('recherche')
        // Nichts Privates im Fall.
        const serialized = JSON.stringify(f.doctor.list())
        expect(serialized).not.toContain('example.com')
        expect(serialized).not.toContain('privat-grund')
        // Erneuter Zyklus: kein zweiter Fall, keine doppelten Belege.
        expect(reconcileValidatorFailures(f.ledger, f.doctor)).toBe(0)
        expect(f.doctor.list()).toHaveLength(1)
        expect(runRefs(f.doctor)).toHaveLength(5)
        // Ein weiterer Lauf mit demselben Bild hängt nur einen Beleg an.
        f.reject('recherche')
        expect(reconcileValidatorFailures(f.ledger, f.doctor)).toBe(0)
        expect(f.doctor.list()).toHaveLength(1)
        expect(runRefs(f.doctor)).toHaveLength(6)
    })

    it('eine andere Aufgabenart unter der Schwelle legt keinen Fall an', () => {
        const f = setup()
        for (let i = 0; i < 5; i++) f.reject('recherche')
        f.reject('code'); f.reject('code')
        reconcileValidatorFailures(f.ledger, f.doctor)
        expect(f.doctor.list()).toHaveLength(1)
        expect(f.doctor.list()[0].hypothesis).not.toContain('code')
    })

    it('gleiche Kriterien, aber andere Aufgabenart ist ein eigenes Fehlerbild', () => {
        const f = setup()
        for (let i = 0; i < 3; i++) { f.reject('recherche'); f.reject('code') }
        expect(reconcileValidatorFailures(f.ledger, f.doctor)).toBe(2)
        expect(new Set(f.doctor.list().map(item => item.observationHash)).size).toBe(2)
    })

    it('verschiedene Owner mit demselben Fehlerbild teilen den Fall, ohne Identität im Fall', () => {
        const f = setup()
        for (let i = 0; i < 3; i++) f.reject('recherche', 'verified_tool', `owner-${i}@example.com`)
        expect(reconcileValidatorFailures(f.ledger, f.doctor)).toBe(1)
        expect(JSON.stringify(f.doctor.list())).not.toContain('owner-')
    })
})
