/**
 * 2.83.0 Punkt 6: Prozeduren lernen auch aus Misserfolg — im selben Speicher,
 * nach dem Muster der Routine-Skills (Rücknahme bei Ablehnung, Aussetzen nach
 * zwei Fehlschlägen in Folge, Nutzen eines Abrufs gemessen).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcedureStore } from './procedure-store.js'

const PROBLEM = 'Read the amber project report from example.com'
const dirs: string[] = []
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function learn(store: ProcedureStore, runId: string, userId = 'alice') {
    return store.recordVerifiedOutcome({ toolName: 'read_file', request: PROBLEM, params: { path: 'amber.md' }, result: { success: true, content: 'AMBER report delivered' }, success: true, verified: true, userId, runId })
}

describe('Prozeduren lernen aus Misserfolg (2.83.0 Punkt 6)', () => {
    it('eine Prozedur aus einem zurückgewiesenen Lauf wird nicht mehr abgerufen (invalidateValidatedRun)', async () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        learn(store, 'r0'); expect(learn(store, 'r1').remembered).toBe(true)
        expect(store.recall(PROBLEM, 'alice')?.runIds).toEqual(['r1'])
        const { LearningCoordinator } = await import('./learning-coordinator.js')
        const coordinator = new LearningCoordinator(undefined, temp('coord-'), store)
        await coordinator.invalidateValidatedRun({ runId: 'r1', userId: 'alice', request: PROBLEM, taskType: 'lookup', reason: 'falsch' })
        expect(store.recall(PROBLEM, 'alice')).toBeNull()
        // dauerhaft
        expect(new ProcedureStore(store.path).recall(PROBLEM, 'alice')).toBeNull()
    })

    it('mit einem weiteren Beleg bleibt sie; ein fremder Lauf ändert nichts', () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        learn(store, 'r0'); learn(store, 'r1'); learn(store, 'r2')
        expect(store.retractRun('fremd')).toBe(false)
        expect(store.retractRun('r1')).toBe(true)
        expect(store.recall(PROBLEM, 'alice')?.runIds).toEqual(['r2'])
        expect(store.retractRun('r2')).toBe(true)
        expect(store.recall(PROBLEM, 'alice')).toBeNull()
    })

    it('zwei vom Validator abgelehnte Läufe mit abgerufener Prozedur setzen sie aus; ein Erfolg dazwischen setzt die Folge zurück', () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        learn(store, 'r0'); learn(store, 'r1')
        const known = store.recall(PROBLEM, 'alice')!
        store.recordProcedureOutcome(known.problem, 'alice', false, 'u1')
        store.recordProcedureOutcome(known.problem, 'alice', true, 'u2')
        store.recordProcedureOutcome(known.problem, 'alice', false, 'u3')
        expect(store.recall(PROBLEM, 'alice')).not.toBeNull()
        store.recordProcedureOutcome(known.problem, 'alice', false, 'u4')
        expect(store.recall(PROBLEM, 'alice')).toBeNull()
        expect(store.promptBlock(PROBLEM, 'alice')).toBeNull()
        const entry = store.list('alice')[0]
        expect(entry).toMatchObject({ uses: 4, failures: 3, consecutiveFailures: 2 })
        expect(store.getStats()).toMatchObject({ procedures: 0, suspended: 1 })
        // anderer Benutzer kann die Prozedur nicht verändern
        expect(store.recordProcedureOutcome(known.problem, 'bob', false)).toBeNull()
    })

    it('ein später vom Owner zurückgewiesener Lauf, der die Prozedur nutzte, zählt als Fehlschlag', () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        learn(store, 'r0'); learn(store, 'r1')
        store.recordProcedureOutcome(PROBLEM, 'alice', true, 'u1')
        store.recordProcedureOutcome(PROBLEM, 'alice', true, 'u2')
        expect(store.retractRun('u1')).toBe(true)
        expect(store.retractRun('u2')).toBe(true)
        expect(store.recall(PROBLEM, 'alice')).toBeNull()
    })

    it('Altbestand ohne runIds bleibt abrufbar, bis er zweimal scheitert', () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        store.importLegacy([{ userId: 'alice', problem: PROBLEM, solution: 'Tool read_file: {"success":true,"content":"AMBER report delivered"}', toolName: 'read_file', learnedAt: 1, successCount: 1, source: 'verifiziert', verified: true }], [])
        expect(store.retractRun('r1')).toBe(false)
        expect(store.recall(PROBLEM, 'alice')).not.toBeNull()
        store.recordProcedureOutcome(PROBLEM, 'alice', false); store.recordProcedureOutcome(PROBLEM, 'alice', false)
        expect(store.recall(PROBLEM, 'alice')).toBeNull()
    })

    it('nova-runner meldet das Validator-Ergebnis eines Laufs mit abgerufener Prozedur zurück, der Validator-Weg zieht Prozeduren zurück', () => {
        const runner = readFileSync(fileURLToPath(new URL('../agents/nova-runner.ts', import.meta.url)), 'utf8')
        expect(runner).toMatch(/recordProcedureOutcome\(recalledProcedure\.problem, userId, taskValidation\.success, kernel\.contract\.id\)/)
        expect(runner).not.toMatch(/l17KnownSolution/)
        const coordinator = readFileSync(fileURLToPath(new URL('./learning-coordinator.ts', import.meta.url)), 'utf8')
        expect(coordinator).toMatch(/retractRun\(outcome\.runId\)/)
    })

    it('ein vom Validator abgelehnter Lauf zieht die in ihm gelernte Prozedur zurück (recordValidatedRun)', async () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        learn(store, 'r0'); learn(store, 'r1')
        const { LearningCoordinator } = await import('./learning-coordinator.js')
        const coordinator = new LearningCoordinator(undefined, temp('coord-'), store)
        await coordinator.recordValidatedRun({
            runId: 'r1', userId: 'alice', request: PROBLEM, taskType: 'lookup', tools: [], success: false, validated: true, durationMs: 1, costUsd: 0,
            validation: { contractId: 'r1', success: false, criteria: [], violations: ['x'], validatedAt: new Date().toISOString(), validator: 'test' } as any,
        })
        expect(store.recall(PROBLEM, 'alice')).toBeNull()
    })
})
