/**
 * 2.84 Punkt 9: Eine ausgesetzte Prozedur kommt zurück — durch einen neuen
 * Beleg (zwei frische verifizierte Erfolge derselben Form) oder per
 * Owner-Befehl /prozeduren an <nr>. Ohne Beleg bleibt sie aus; das Aus des
 * Owners wirkt stärker als jeder Beleg.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcedureStore, setProcedureStore } from './procedure-store.js'

const PROBLEM = 'Read the amber project report from example.com'
const dirs: string[] = []
const events: Array<{ kind: string; problem: string }> = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'proc-an-')); dirs.push(dir); return dir }
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    events.length = 0
    setProcedureStore(null)
})

function store(): ProcedureStore {
    return new ProcedureStore(join(temp(), 'procedures.json'), { notify: event => events.push({ kind: event.kind, problem: event.procedure.problem }) } as any)
}

function learn(s: ProcedureStore, runId: string, userId = 'owner-1') {
    return s.recordVerifiedOutcome({ toolName: 'read_file', request: PROBLEM, params: { path: 'amber.md' }, result: { success: true, content: 'AMBER report delivered' }, success: true, verified: true, userId, runId })
}

function suspend(s: ProcedureStore, userId = 'owner-1') {
    s.recordProcedureOutcome(PROBLEM, userId, false, 'u1')
    s.recordProcedureOutcome(PROBLEM, userId, false, 'u2')
    expect(s.recall(PROBLEM, userId)).toBeNull()
}

const owner = { principalId: 'owner-1', permission: 'owner' }

describe('Prozeduren wieder einschalten (2.84 Punkt 9)', () => {
    it('neuer Beleg: zwei frische verifizierte Erfolge derselben Form heben die Aussetzung auf', () => {
        const s = store()
        learn(s, 'r0'); learn(s, 'r1')
        suspend(s)
        learn(s, 'r2')
        expect(s.recall(PROBLEM, 'owner-1')).toBeNull() // ein Erfolg reicht nicht
        learn(s, 'r3')
        const back = s.recall(PROBLEM, 'owner-1')
        expect(back).not.toBeNull()
        expect(back!.consecutiveFailures).toBe(0)
        expect(back!.runIds).toContain('r3')
        expect(events).toEqual([{ kind: 'wieder-aktiv', problem: PROBLEM }])
    })

    it('/prozeduren an 1 als Owner macht sie wieder abrufbar; als Nicht-Owner abgelehnt', async () => {
        const s = store()
        setProcedureStore(s)
        learn(s, 'r0'); learn(s, 'r1')
        suspend(s)
        const { handleProzedurenCommand } = await import('./procedure-store.js') as any
        expect(await handleProzedurenCommand('an 1', { principalId: 'owner-1', permission: 'user' })).toMatch(/Owner/)
        expect(s.recall(PROBLEM, 'owner-1')).toBeNull()
        expect(await handleProzedurenCommand('an 1', owner)).toMatch(/an/)
        expect(s.recall(PROBLEM, 'owner-1')).not.toBeNull()

        const { getCommandMinimumRole } = await import('../core/slash-commands.js')
        expect(getCommandMinimumRole('prozeduren')).toBe('owner')
    })

    it('zurückgenommen (ohne Beleg) bleibt aus, auch mit /prozeduren an', async () => {
        const s = store()
        setProcedureStore(s)
        learn(s, 'r0'); learn(s, 'r1')
        s.retractRun('r1')
        const { handleProzedurenCommand } = await import('./procedure-store.js') as any
        expect(await handleProzedurenCommand('an 1', owner)).toMatch(/ohne Beleg/)
        expect(s.recall(PROBLEM, 'owner-1')).toBeNull()
    })

    it('/prozeduren aus wirkt stärker als jeder Beleg; nur der Owner hebt es auf', async () => {
        const s = store()
        setProcedureStore(s)
        learn(s, 'r0'); learn(s, 'r1')
        const { handleProzedurenCommand } = await import('./procedure-store.js') as any
        expect(await handleProzedurenCommand('aus 1', owner)).toMatch(/aus/)
        expect(s.recall(PROBLEM, 'owner-1')).toBeNull()
        learn(s, 'r2'); learn(s, 'r3')
        expect(s.recall(PROBLEM, 'owner-1')).toBeNull()
        expect(await handleProzedurenCommand('an 1', owner)).toMatch(/an/)
        expect(s.recall(PROBLEM, 'owner-1')).not.toBeNull()
    })

    it('/prozeduren listet Problem, Werkzeug, Abrufe/ok und Status', async () => {
        const s = store()
        setProcedureStore(s)
        learn(s, 'r0'); learn(s, 'r1')
        s.recordProcedureOutcome(PROBLEM, 'owner-1', true, 'u1')
        const { handleProzedurenCommand } = await import('./procedure-store.js') as any
        const text = await handleProzedurenCommand('', owner)
        expect(text).toContain('1. Read the amber project report')
        expect(text).toContain('read_file')
        expect(text).toContain('1× (1 ok)')
        expect(text).toContain('aktiv')
        expect(text).toContain('/prozeduren an <nr>')
    })
})
