import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FailureResearchCoordinator, type FailureResearchCase } from '../doctor/failure-research-coordinator.js'
import { runClaudeHandoffTick } from '../doctor/claude-handoff.js'
import { OutcomeLedger, type OutcomeRunView } from '../core/outcome-ledger.js'
import { createTaskContract } from '../core/task-contract.js'
import { detectActionIntent } from '../core/action-intent.js'
import { reconcileValidatorFailures } from '../core/validator-failure-escalation.js'
import { runBugFinder, tracesErrorSource, type ErrorOccurrence, type ErrorSourcePort } from './bug-finder.js'
import { MemoryThoughtSink, parseThinkingSettings } from './ports.js'

// Punkt 1 (2.83.0): Fälle schließen sich, wenn der Fehler gemessen weg ist.
const DAY = 24 * 60 * 60_000
const NOW = new Date('2026-10-01T03:00:00Z')
const LATER = new Date(NOW.getTime() + 8 * DAY)
const settings = parseThinkingSettings({ enabled: true, bugFinder: { enabled: true, minOccurrences: 5 } })
const fail = (i: number, at = NOW.getTime()): ErrorOccurrence => ({
    source: 'trace', subject: 'web_search', message: `web_search timeout after ${4000 + i} ms`, at: at - i * 60_000, ref: `trace:${i}`,
})
const source = (failures: ErrorOccurrence[], ok: Record<string, number> = {}): ErrorSourcePort => ({ collect: async () => failures, successes: async () => ok })

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'nachkontrolle-')); dirs.push(dir); return dir }
const outboxRecords = (path: string) => JSON.parse(readFileSync(path, 'utf8')).records
/** No Agentic-OS URL: only the outbox works, as before. */
const offline = { config: { enabled: true, url: null }, delegate: async () => ({ ok: false as const, reason: 'aus' }), get: () => null }

function thoughtsPort() {
    const added: Array<{ source: string; title: string; evidence?: string }> = []
    const status: Array<{ id: string; status: string }> = []
    return {
        added, status,
        port: {
            add: (input: { source: string; title: string; evidence?: string }) => { added.push(input); return { thought: { id: `th-${String(added.length).padStart(12, '0')}` } } },
            setStatus: (id: string, value: string) => { status.push({ id, status: value }); return null },
        },
    }
}
const asVerified = (cases: FailureResearchCase[]) => cases.map(item => ({ ...item, investigation: { status: 'verified' as const, runId: 'r1', attempts: 1, nextAttemptAt: 0, report: 'belegt' } }))

async function handedOver() {
    const dir = tmp()
    const doctor = new FailureResearchCoordinator(join(dir, 'failure-research.json'))
    const outbox = join(dir, 'claude-handoff.json')
    await runBugFinder({ settings, source: source([0, 1, 2, 3, 4].map(i => fail(i))), doctor, sink: new MemoryThoughtSink(), now: NOW })
    expect(doctor.list()).toHaveLength(1)
    const first = await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.0.0', now: NOW, path: outbox, delegation: offline })
    expect(first.queued).toBe(1)
    return { doctor, outbox }
}

describe('Nachkontrolle mit Messung (Punkt 1)', () => {
    it('Bug-Finder-Fall: 0 Fehlschläge und genug erfolgreiche Aufrufe nach dem Rollout → GESCHLOSSEN mit erledigtem Gedanken', async () => {
        const { doctor, outbox } = await handedOver()
        await runBugFinder({ settings, source: source([], { web_search: 6 }), doctor, sink: new MemoryThoughtSink(), now: LATER })
        const [item] = doctor.list()
        expect(item.findingOpen).toBe(false)
        expect(item.stage).not.toBe('resolved') // nie „repariert bestätigt“
        expect(item.evidenceRefs.some(ref => ref.startsWith('messung:'))).toBe(true)
        const thoughts = thoughtsPort()
        const result = await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.1.0', now: LATER, path: outbox, thoughts: thoughts.port, delegation: offline })
        expect(result.reconciled).toBe(1)
        expect(outboxRecords(outbox)[0]).toMatchObject({ state: 'closed', checkedInVersion: '1.1.0' })
        expect(thoughts.added).toHaveLength(1)
        expect(thoughts.added[0]).toMatchObject({ source: 'bug-finder' })
        expect(thoughts.added[0].title).toMatch(/nach Rollout v?1\.1\.0 nicht mehr beobachtet/)
        expect(thoughts.added[0].title).not.toContain('behoben')
        expect(thoughts.status).toEqual([{ id: 'th-000000000001', status: 'erledigt' }])
    })

    it('Gegenprobe: ohne Aufrufe des Werkzeugs bleibt der Fall offen (nicht genutzt heißt nicht geheilt)', async () => {
        const { doctor, outbox } = await handedOver()
        await runBugFinder({ settings, source: source([], {}), doctor, sink: new MemoryThoughtSink(), now: LATER })
        expect(doctor.list()[0].findingOpen).not.toBe(false)
        await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.1.0', now: LATER, path: outbox, delegation: offline })
        expect(outboxRecords(outbox)[0].state).toBe('still-open')
    })

    it('ein noch offener Fall wird in derselben Version weiter gemessen und schließt später', async () => {
        const { doctor, outbox } = await handedOver()
        await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.1.0', now: LATER, path: outbox, delegation: offline })
        expect(outboxRecords(outbox)[0].state).toBe('still-open')
        await runBugFinder({ settings, source: source([], { web_search: 9 }), doctor, sink: new MemoryThoughtSink(), now: LATER })
        const result = await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.1.0', now: LATER, path: outbox, delegation: offline })
        expect(result.reconciled).toBe(1)
        expect(outboxRecords(outbox)[0].state).toBe('closed')
    })

    it('kehrt der Fehler zurück, öffnet sich derselbe Fall wieder; kein zweiter entsteht', async () => {
        const { doctor } = await handedOver()
        await runBugFinder({ settings, source: source([], { web_search: 6 }), doctor, sink: new MemoryThoughtSink(), now: LATER })
        expect(doctor.list()[0].findingOpen).toBe(false)
        const again = new Date(LATER.getTime() + DAY)
        await runBugFinder({ settings, source: source([0, 1, 2, 3, 4].map(i => fail(i, again.getTime())), { web_search: 6 }), doctor, sink: new MemoryThoughtSink(), now: again })
        expect(doctor.list()).toHaveLength(1)
        expect(doctor.list()[0].findingOpen).toBe(true)
    })

    it('die Trace-Quelle zählt erfolgreiche Aufrufe je Werkzeug', async () => {
        const dir = tmp()
        mkdirSync(dir, { recursive: true })
        const line = (i: number, success: boolean) => JSON.stringify({ id: `t${i}`, timestamp: NOW.getTime() - i * 1000, success,
            toolCalls: [{ name: 'web_search', success, latencyMs: 5, resultSize: 1, ...(success ? {} : { errorMessage: 'timeout' }) }] })
        writeFileSync(join(dir, '2026-10-01.jsonl'), [line(0, true), line(1, true), line(2, false), line(3, true)].join('\n') + '\n')
        const port = tracesErrorSource(dir)
        expect(await port.successes?.(NOW.getTime() - DAY)).toEqual({ web_search: 3 })
        expect(await port.collect(NOW.getTime() - DAY)).toHaveLength(1)
    })
})

describe('Nachkontrolle für Validator-Fälle (Punkt 1 mit dem Schlüssel aus Punkt 8)', () => {
    function ledgerWithRejections() {
        const dir = tmp()
        const ledger = new OutcomeLedger(join(dir, 'ledger'), false)
        const doctor = new FailureResearchCoordinator(join(dir, 'queue.json'))
        const run = (taskType: string, success: boolean) => {
            const contract = createTaskContract('lies https://example.com', detectActionIntent('lies https://example.com'), [], {
                successCriteria: [{ id: 'target', kind: 'verified_tool', required: true, description: 'Ziel' }],
            })
            ledger.start(contract, { userId: 'owner@example.com', channel: 'telegram' })
            ledger.recordRoute(contract.id, { taskType })
            ledger.recordValidation(contract.id, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
                success, awaitingApproval: false, criteria: [{ criterionId: 'target', success, evidence: [] }], violations: [] })
            if (success) ledger.completeValidated(contract.id, { success: true })
            else ledger.fail(contract.id, { reason: 'validator-rejected', diagnosticEligible: true })
        }
        for (let i = 0; i < 3; i++) run('recherche', false)
        expect(reconcileValidatorFailures(ledger, doctor)).toBe(1)
        // Spätere Läufe liegen 8 Tage nach den Fehlschlägen.
        const shifted = (): Pick<OutcomeLedger, 'listRuns'> => ({ listRuns: (n?: number) => ledger.listRuns(n).map((item: OutcomeRunView) =>
            item.status === 'completed' ? { ...item, updatedAt: new Date(Date.now() + 8 * DAY).toISOString() } : item) })
        return { doctor, run, shifted }
    }

    it('schließt den Fall, wenn dieselbe Aufgabenart wieder genug validierte Erfolge ohne Ablehnung hat', () => {
        const f = ledgerWithRejections()
        for (let i = 0; i < 3; i++) f.run('recherche', true)
        reconcileValidatorFailures(f.shifted(), f.doctor, Date.now() + 8 * DAY)
        expect(f.doctor.list()[0].findingOpen).toBe(false)
        expect(f.doctor.list()[0].evidenceRefs.some(ref => ref.startsWith('messung:validator:recherche'))).toBe(true)
    })

    it('Erfolge einer anderen Aufgabenart schließen nichts', () => {
        const f = ledgerWithRejections()
        for (let i = 0; i < 3; i++) f.run('code', true)
        reconcileValidatorFailures(f.shifted(), f.doctor, Date.now() + 8 * DAY)
        expect(f.doctor.list()[0].findingOpen).not.toBe(false)
    })
})
