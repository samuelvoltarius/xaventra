/**
 * 2.84.0 Punkt 3: Fälle schließen gemessen — ab dem Rollout, für alle
 * Fallarten (auch `aufgabe:` und `mission:`), Altfälle je Lauf über die Form.
 * Geschlossen heißt weiter „nicht mehr beobachtet“, nie „repariert bestätigt“.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FailureResearchCoordinator, type FailureResearchCase } from '../doctor/failure-research-coordinator.js'
import { rolloutMeasureSince, runClaudeHandoffTick } from '../doctor/claude-handoff.js'
import { OutcomeLedger, type OutcomeRunView } from '../core/outcome-ledger.js'
import { createTaskContract } from '../core/task-contract.js'
import { detectActionIntent } from '../core/action-intent.js'
import { reconcileValidatorFailures } from '../core/validator-failure-escalation.js'
import { RegressionCaseStore, regressionErrorSource, setRegressionCaseStore } from '../learning/regression-case-store.js'
import type { Mission } from '../core/missions.js'
import { runBugFinder, type ErrorOccurrence, type ErrorSourcePort } from './bug-finder.js'
import { IntervalSchedule, MemoryThoughtSink, parseThinkingSettings } from './ports.js'
import { missionErrorSource, runThinkingTick, setThinkingConfig } from './thinking-runtime.js'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const NOW = new Date('2026-10-10T12:00:00Z')
const settings = parseThinkingSettings({ enabled: true, bugFinder: { enabled: true, minOccurrences: 5 } })
const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'ab-rollout-')); dirs.push(dir); return dir }
afterEach(() => {
    setThinkingConfig(undefined)
    setRegressionCaseStore(new RegressionCaseStore(join(tmp(), 'reset.json')))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const offline = { config: { enabled: true, url: null }, delegate: async () => ({ ok: false as const, reason: 'aus' }), get: () => null }
const asVerified = (cases: FailureResearchCase[]) => cases.map(item => ({ ...item, investigation: { status: 'verified' as const, runId: 'r1', attempts: 1, nextAttemptAt: 0, report: 'belegt' } }))

/** Quelle mit echten Zeitstempeln: Fehler und Erfolge zählen nur ab `sinceMs`. */
function timed(failures: ErrorOccurrence[], okTimes: Record<string, number[]>): ErrorSourcePort {
    return {
        collect: since => failures.filter(item => item.at >= since),
        successes: since => Object.fromEntries(Object.entries(okTimes).map(([subject, times]) => [subject, times.filter(at => at >= since).length])),
    }
}
const fail = (at: number, i = 0): ErrorOccurrence => ({ source: 'trace', subject: 'web_search', message: `web_search timeout after ${4000 + i} ms`, at, ref: `trace:${at}` })

async function handedOverThenRolledOut(rolloutAgoMs: number) {
    const dir = tmp()
    const doctor = new FailureResearchCoordinator(join(dir, 'failure-research.json'))
    const outbox = join(dir, 'claude-handoff.json')
    const start = NOW.getTime() - 5 * DAY
    const failures = [0, 1, 2, 3, 4].map(i => fail(start - i * 60_000, i))
    await runBugFinder({ settings, source: timed(failures, {}), doctor, sink: new MemoryThoughtSink(), now: new Date(start) })
    expect(doctor.list()).toHaveLength(1)
    await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.0.0', now: new Date(start), path: outbox, delegation: offline })
    const rolloutAt = NOW.getTime() - rolloutAgoMs
    await runClaudeHandoffTick({ cases: asVerified(doctor.list()), node: 'spark', version: '1.1.0', now: new Date(rolloutAt), path: outbox, delegation: offline })
    // Fehler bis kurz vor dem Rollout, danach 0 Fehler und 6 Erfolge.
    failures.push(fail(rolloutAt - HOUR, 9))
    const ok = { web_search: [1, 2, 3, 4, 5, 6].map(i => rolloutAt + i * 60_000) }
    return { doctor, outbox, source: timed(failures, ok), caseId: doctor.list()[0].id, rolloutAt }
}

describe('Messen ab Rollout statt 7 Tage nach dem letzten Fehler', () => {
    it('Übergabe in v1.0, v1.1 seit 30 h, seitdem 0 Fehler und 6 Erfolge → geschlossen', async () => {
        const f = await handedOverThenRolledOut(30 * HOUR)
        expect(rolloutMeasureSince(f.outbox)(f.caseId)).toBe(f.rolloutAt)
        // Gegenprobe heute (nur Fenster): Fehler von gestern liegen im 7-Tage-Fenster → offen.
        await runBugFinder({ settings, source: f.source, doctor: f.doctor, sink: new MemoryThoughtSink(), now: NOW })
        expect(f.doctor.list()[0].findingOpen).not.toBe(false)
        const result = await runBugFinder({ settings, source: f.source, doctor: f.doctor, sink: new MemoryThoughtSink(), now: NOW, measureSince: rolloutMeasureSince(f.outbox) })
        expect(result.closed).toEqual([f.caseId])
        const [item] = f.doctor.list()
        expect(item.findingOpen).toBe(false)
        expect(item.stage).not.toBe('resolved')
        expect(item.evidenceRefs.some(ref => ref.startsWith('messung:web_search:0-fehler:6-ok:seit-rollout'))).toBe(true)
    })

    it('Rollout erst vor 3 h → offen (24-h-Mindestzeit)', async () => {
        const f = await handedOverThenRolledOut(3 * HOUR)
        await runBugFinder({ settings, source: f.source, doctor: f.doctor, sink: new MemoryThoughtSink(), now: NOW, measureSince: rolloutMeasureSince(f.outbox) })
        expect(f.doctor.list()[0].findingOpen).not.toBe(false)
    })

    it('ein Fehler nach dem Rollout hält den Fall offen', async () => {
        const f = await handedOverThenRolledOut(30 * HOUR)
        const failures = await f.source.collect(0) as ErrorOccurrence[]
        const source = timed([...failures, fail(NOW.getTime() - 2 * HOUR, 11)], { web_search: [1, 2, 3, 4, 5, 6].map(i => f.rolloutAt + i * 60_000) })
        await runBugFinder({ settings, source, doctor: f.doctor, sink: new MemoryThoughtSink(), now: NOW, measureSince: rolloutMeasureSince(f.outbox) })
        expect(f.doctor.list()[0].findingOpen).not.toBe(false)
    })
})

/** Ein echter, vom Kernel validierter Owner-Lauf (wie im Ledger), ohne Anfragetext. */
function ownerRun(i: number, taskType: string, at: number, success = true): OutcomeRunView {
    const runId = `run-${taskType}-${i}`
    return {
        runId, status: success ? 'completed' : 'failed', startedAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
        contract: { id: runId, successCriteria: [{ id: 'target', kind: 'verified_tool', required: true, description: 'Ziel' }] } as any,
        channel: 'telegram', userId: 'owner@example.com', tools: [], tests: [], changes: [], approvals: [], costs: [], feedback: [],
        events: [{ type: 'route.selected', timestamp: new Date(at).toISOString(), payload: { taskType }, runId } as any],
        totalCostUsd: 0, totalTokens: 0, eventCount: 1,
        validation: { validator: 'nova-execution-kernel', validatedAt: '', success, awaitingApproval: false, criteria: [{ criterionId: 'target', success, evidence: [] }], violations: [] } as any,
        finalOutcome: success ? { success: true } : { reason: 'validator-rejected', diagnosticEligible: true },
    }
}
const BUGS_ONLY = { enabled: true, ideas: { enabled: false }, scout: { enabled: false }, bugFinder: { enabled: true }, learning: { enabled: false } }

describe('Erfolge für Aufgabenarten und Missionen', () => {
    it('5 Owner-Zurückweisungen aufgabe:recherche, danach 5 validierte Erfolge → Fall geschlossen, Regressionsfall erledigt', async () => {
        setThinkingConfig(BUGS_ONLY)
        const dir = tmp()
        const t0 = NOW.getTime() - 8 * DAY
        let tick = t0
        const store = new RegressionCaseStore(join(dir, 'regression-cases.json'), () => tick += 60_000)
        setRegressionCaseStore(store)
        for (let i = 0; i < 5; i++) store.record({ userId: 'owner@example.com', taskType: 'recherche', request: `Frage ${i} an https://example.com`, runId: `r-${i}`, failureClass: 'user-correction' })
        const runs: OutcomeRunView[] = []
        const ledger = { listRuns: () => runs }
        const doctor = new FailureResearchCoordinator(join(dir, 'research.json'))
        const source = regressionErrorSource(store, ledger)
        await runThinkingTick({ isMain: true, now: new Date(t0 + HOUR), sink: new MemoryThoughtSink(), schedule: new IntervalSchedule(join(dir, 's1.json')), doctor, errorSource: source, measureSince: () => undefined })
        expect(doctor.list()).toHaveLength(1)
        expect(store.list().every(item => item.status === 'promoted')).toBe(true)
        // Erfolge einer anderen Aufgabenart und interne Läufe zählen nicht.
        for (let i = 0; i < 5; i++) runs.push(ownerRun(i, 'code', NOW.getTime() - DAY))
        runs.push({ ...ownerRun(99, 'recherche', NOW.getTime() - DAY), userId: 'Nova-Autonomy', channel: 'internal' })
        expect((await source.successes!(t0))['aufgabe:recherche'] || 0).toBe(0)
        for (let i = 0; i < 5; i++) runs.push(ownerRun(i, 'recherche', NOW.getTime() - DAY + i))
        expect((await source.successes!(t0))['aufgabe:recherche']).toBe(5)
        await runThinkingTick({ isMain: true, now: NOW, sink: new MemoryThoughtSink(), schedule: new IntervalSchedule(join(dir, 's2.json')), doctor, errorSource: source, measureSince: () => undefined })
        expect(doctor.list()[0].findingOpen).toBe(false)
        expect(store.list().map(item => item.status)).toEqual(Array(5).fill('resolved'))
    })

    it('resolve nimmt eine Messung als Beleg an, aber keinen Freitext', () => {
        const store = new RegressionCaseStore(join(tmp(), 'cases.json'))
        const item = store.record({ userId: 'owner@example.com', taskType: 'mail', request: 'x', runId: 'r', failureClass: 'user-correction' })
        store.promote(item.id, 'test:doctor:abc')
        expect(store.resolve(item.id, 'irgendwas')).toBeNull()
        expect(store.resolve(item.id, 'messung:doctor:abc')?.status).toBe('resolved')
    })

    it('Mission: 5× fehlgeschlagen, danach 3× abgeschlossen → geschlossen; Gegenprobe ohne Abschlüsse offen', async () => {
        const small = parseThinkingSettings({ enabled: true, bugFinder: { enabled: true, minOccurrences: 3 } })
        const mission = (i: number, status: Mission['status'], at: number): Mission => {
            const iso = new Date(at).toISOString()
            return { id: `m-${i}`, responsibilityId: 'backup-aktuell', titel: 'Backup aktuell', anlass: [], vertrag: { doneWhen: [], darf: '', fragenBei: '', nie: '' },
                steps: [], cursor: 0, versuche: 3, maxVersuche: 3, diagnosen: [], budget: { startedAt: iso, deadlineAt: iso, maxToolCalls: 1, toolCalls: 0, maxKosten: 0, kosten: 0 },
                status, node: 'main', createdAt: iso, updatedAt: iso, grund: 'Ziel nicht erreicht', log: [] }
        }
        const t0 = NOW.getTime() - 8 * DAY
        const failed = [0, 1, 2, 3, 4].map(i => mission(i, 'fehlgeschlagen', t0 + i * 60_000))
        let done: Mission[] = []
        const source = missionErrorSource(since => failed.filter(item => Date.parse(item.updatedAt) >= since), since => done.filter(item => Date.parse(item.updatedAt) >= since))
        const doctor = new FailureResearchCoordinator(join(tmp(), 'research.json'))
        await runBugFinder({ settings: small, source, doctor, sink: new MemoryThoughtSink(), now: new Date(t0 + HOUR) })
        expect(doctor.list()).toHaveLength(1)
        await runBugFinder({ settings: small, source, doctor, sink: new MemoryThoughtSink(), now: NOW })
        expect(doctor.list()[0].findingOpen).not.toBe(false)
        done = [10, 11, 12].map(i => mission(i, 'abgeschlossen', NOW.getTime() - DAY + i))
        expect(await source.successes!(t0)).toEqual({ 'mission:backup-aktuell': 3 })
        await runBugFinder({ settings: small, source, doctor, sink: new MemoryThoughtSink(), now: NOW })
        expect(doctor.list()[0].findingOpen).toBe(false)
    })
})

describe('Validator-Formfall ab Rollout', () => {
    it('Ablehnungen vor dem Rollout im Fenster, danach 3 Erfolge → geschlossen; ohne Rollout offen', () => {
        const dir = tmp()
        const doctor = new FailureResearchCoordinator(join(dir, 'queue.json'))
        const rejectedAt = NOW.getTime() - 2 * DAY
        const runs: OutcomeRunView[] = [0, 1, 2].map(i => ownerRun(i + 50, 'recherche', rejectedAt + i, false))
        const ledger = { listRuns: () => runs }
        expect(reconcileValidatorFailures(ledger, doctor, NOW.getTime())).toBe(1)
        const caseId = doctor.list()[0].id
        const rolloutAt = NOW.getTime() - 30 * HOUR
        runs.push(...[0, 1, 2].map(i => ownerRun(i, 'recherche', rolloutAt + HOUR + i)))
        reconcileValidatorFailures(ledger, doctor, NOW.getTime())
        expect(doctor.list()[0].findingOpen).not.toBe(false)
        reconcileValidatorFailures(ledger, doctor, NOW.getTime(), id => id === caseId ? NOW.getTime() - 3 * HOUR : undefined)
        expect(doctor.list()[0].findingOpen).not.toBe(false)
        reconcileValidatorFailures(ledger, doctor, NOW.getTime(), id => id === caseId ? rolloutAt : undefined)
        expect(doctor.list()[0].findingOpen).toBe(false)
        expect(doctor.list()[0].evidenceRefs.some(ref => ref.startsWith('messung:validator:recherche:3-ok:0-abgelehnt:seit-rollout'))).toBe(true)
    })
})

describe('Altfälle je Lauf (vor 2.83) über die Form', () => {
    it('Altfall plus Formfall derselben Form → Altfall geschlossen, sein Lauf als Beleg am Formfall', () => {
        const dir = tmp()
        const ledger = new OutcomeLedger(join(dir, 'ledger'), false)
        const doctor = new FailureResearchCoordinator(join(dir, 'queue.json'))
        const reject = () => {
            const contract = createTaskContract('lies https://example.com', detectActionIntent('lies https://example.com'), [], {
                successCriteria: [{ id: 'target', kind: 'verified_tool', required: true, description: 'Ziel' }],
            })
            ledger.start(contract, { userId: 'owner@example.com', channel: 'telegram' })
            ledger.recordRoute(contract.id, { taskType: 'recherche' })
            ledger.recordValidation(contract.id, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
                success: false, awaitingApproval: false, criteria: [{ criterionId: 'target', success: false, evidence: [] }], violations: [] })
            ledger.fail(contract.id, { reason: 'validator-rejected', diagnosticEligible: true })
            return contract.id
        }
        // Altfall wie vor 2.83: eine ID je Lauf.
        const oldRun = reject()
        const digest = createHash('sha256').update(JSON.stringify(['owner@example.com', oldRun])).digest('hex')
        const legacy = doctor.ingest({ id: `validator-failure-${digest}`, title: 'Execution Kernel completion evidence rejected', category: 'tools', severity: 'warning',
            source: 'execution-kernel', status: 'open', createdAt: '', updatedAt: '', detail: 'Committed validator rejection. Cause not yet established.', recommendation: 'Inspect', evidence: {} })
        // Ohne Formfall bleibt der Altfall wie heute.
        reconcileValidatorFailures(ledger, doctor)
        expect(doctor.list().find(item => item.id === legacy.id)?.findingOpen).toBe(true)
        for (let i = 0; i < 3; i++) reject()
        reconcileValidatorFailures(ledger, doctor)
        const shape = doctor.list().find(item => item.id !== legacy.id)!
        expect(shape).toBeDefined()
        const merged = doctor.list().find(item => item.id === legacy.id)!
        expect(merged.findingOpen).toBe(false)
        expect(merged.evidenceRefs).toContain(`zusammengefuehrt:${shape.id}`)
        expect(shape.evidenceRefs).toContain(`validator-run:${digest.slice(0, 24)}`)
        expect(shape.findingOpen).not.toBe(false)
    })
})
