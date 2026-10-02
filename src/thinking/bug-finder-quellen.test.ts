/**
 * 2.83.0 Punkt 5: Der eine Bug-Finder hört zusätzlich Owner-Zurückweisungen
 * (Regressionsfälle) und wiederholt gescheiterte Missionen — als weitere
 * Quellen, kein zweiter Bug-Finder.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { RegressionCaseStore, regressionErrorSource, setRegressionCaseStore } from '../learning/regression-case-store.js'
import { failedMissionsSince } from '../core/responsibility-runtime.js'
import type { Mission } from '../core/missions.js'
import { IntervalSchedule, MemoryThoughtSink } from './ports.js'
import { combineErrorSources, defaultErrorSources, missionErrorSource, runThinkingTick, setThinkingConfig } from './thinking-runtime.js'

const BUGS_ONLY = { enabled: true, ideas: { enabled: false }, scout: { enabled: false }, bugFinder: { enabled: true }, learning: { enabled: false } }
const PRIVATE = 'Bitte prüfe das Angebot von kunde@example.com zum Projekt Seerose'
const dirs: string[] = []
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }

afterEach(() => {
    setThinkingConfig(undefined)
    setRegressionCaseStore(new RegressionCaseStore(join(temp('reg-reset-'), 'cases.json')))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function mission(i: number, status: Mission['status'], grund: string, at: number): Mission {
    const iso = new Date(at).toISOString()
    return {
        id: `m-${i}`, responsibilityId: 'backup-aktuell', titel: 'Backup aktuell', anlass: [], vertrag: { doneWhen: [], darf: '', fragenBei: '', nie: '' },
        steps: [], cursor: 0, versuche: 3, maxVersuche: 3, diagnosen: [], budget: { startedAt: iso, deadlineAt: iso, maxToolCalls: 1, toolCalls: 0, maxKosten: 0, kosten: 0 },
        status, node: 'main', createdAt: iso, updatedAt: iso, grund, log: [],
    }
}

function tickDeps(dir: string, doctor: FailureResearchCoordinator, now: Date) {
    return { isMain: true, now, sink: new MemoryThoughtSink(), schedule: new IntervalSchedule(join(dir, 'schedule.json')), doctor }
}

describe('Bug-Finder-Quellen (2.83.0 Punkt 5)', () => {
    it('fünf Owner-Korrekturen derselben Aufgabenart werden genau ein Doctor-Fall, ohne Anfragetext, und die Regressionsfälle gelten als in Arbeit', async () => {
        setThinkingConfig(BUGS_ONLY)
        const dir = temp('quellen-')
        const store = new RegressionCaseStore(join(dir, 'regression-cases.json'))
        setRegressionCaseStore(store)
        for (let i = 0; i < 5; i++) store.record({ userId: 'owner', taskType: 'recherche', request: `${PRIVATE} Nr ${i}`, runId: `run-${i}`, failureClass: 'user-correction' })
        const doctor = new FailureResearchCoordinator(join(dir, 'research.json'))
        const deps = tickDeps(dir, doctor, new Date())
        // Standard-Verdrahtung (ohne errorSource): Trace-Quelle + Regressionsfälle + Missionen.
        const result = await runThinkingTick(deps)
        expect(result.ran).toContain('bugs')
        const cases = doctor.list().filter(item => item.title.includes('aufgabe:recherche'))
        expect(cases).toHaveLength(1)
        const text = JSON.stringify(doctor.list()) + JSON.stringify(deps.sink.thoughts)
        expect(text).not.toContain('Seerose')
        expect(text).not.toContain('example.com')
        expect(cases[0].evidenceRefs.some(ref => ref.startsWith('regression:'))).toBe(true)
        // promote() hat endlich einen Aufrufer: alle fünf gelten als in Arbeit.
        expect(store.list().map(item => item.status)).toEqual(Array(5).fill('promoted'))
        // zweiter Lauf: kein zweiter Fall
        await runThinkingTick({ ...deps, schedule: new IntervalSchedule(join(dir, 'schedule-2.json')) })
        expect(doctor.list().filter(item => item.title.includes('aufgabe:recherche'))).toHaveLength(1)
    })

    it('ein mehrfach korrigierter Fall zählt jedes Vorkommen (times), Validator-Ablehnungen kommen nicht doppelt über diese Quelle', async () => {
        const dir = temp('quellen-')
        let t = Date.parse('2026-10-01T08:00:00.000Z')
        const store = new RegressionCaseStore(join(dir, 'regression-cases.json'), () => t += 60_000)
        for (let i = 0; i < 4; i++) store.record({ userId: 'owner', taskType: 'mail', request: PRIVATE, runId: `run-${i}`, failureClass: 'negative-user-feedback' })
        for (let i = 0; i < 6; i++) store.record({ userId: 'owner', taskType: 'mail', request: `${PRIVATE} ${i}`, runId: `v-${i}`, failureClass: 'validator-rejected:mail' })
        expect(store.list().find(item => item.failureClass === 'negative-user-feedback')?.times).toHaveLength(4)
        const occurrences = await regressionErrorSource(store).collect(0)
        expect(occurrences).toHaveLength(4)
        expect(occurrences.every(item => item.source === 'owner-rueckmeldung' && item.subject === 'aufgabe:mail' && item.message === 'negative-user-feedback' && item.ref.startsWith('regression:'))).toBe(true)
        expect(JSON.stringify(occurrences)).not.toContain('example.com')
        // Fenster: ältere Vorkommen fallen raus
        expect(await regressionErrorSource(store).collect(t + 1)).toHaveLength(0)
    })

    it('fünf gescheiterte Missionen derselben Verantwortung werden ein Fall; fünf vom Owner abgelehnte (blockiert) keiner', async () => {
        setThinkingConfig(BUGS_ONLY)
        const now = new Date()
        const base = now.getTime() - 60 * 60_000
        const failed = Array.from({ length: 5 }, (_, i) => mission(i, 'fehlgeschlagen', `Backup prüfen — Zeitbudget (${10 + i} min) aufgebraucht`, base + i * 60_000))
        const dir = temp('quellen-')
        const doctor = new FailureResearchCoordinator(join(dir, 'research.json'))
        await runThinkingTick({ ...tickDeps(dir, doctor, now), errorSource: missionErrorSource(() => failed) })
        expect(doctor.list()).toHaveLength(1)
        expect(doctor.list()[0].title).toContain('mission:backup-aktuell')

        const dir2 = temp('quellen-')
        const doctor2 = new FailureResearchCoordinator(join(dir2, 'research.json'))
        const refused = Array.from({ length: 5 }, (_, i) => mission(i, 'blockiert', 'Backup prüfen (Alfred hat Nein gesagt)', base + i * 60_000))
        await runThinkingTick({ ...tickDeps(dir2, doctor2, now), errorSource: missionErrorSource(() => refused) })
        expect(doctor2.list()).toHaveLength(0)
    })

    it('Standard-Quellen: Traces, Owner-Rückmeldungen und Missionen; ohne Laufzeit liefert der Missions-Getter nichts', async () => {
        expect(defaultErrorSources()).toHaveLength(3)
        expect(failedMissionsSince(0)).toEqual([])
        const combined = combineErrorSources([
            { collect: () => [{ source: 'a', subject: 'x', message: 'm', at: 1, ref: 'r' }] },
            { collect: () => { throw new Error('kaputt') } },
            { collect: async () => [{ source: 'b', subject: 'y', message: 'm', at: 2, ref: 'r' }] },
        ])
        expect((await combined.collect(0)).map(item => item.source)).toEqual(['a', 'b'])
    })

    it('nach dem signierten Repair-Weg (stage resolved) gilt der Regressionsfall als erledigt', async () => {
        setThinkingConfig(BUGS_ONLY)
        const dir = temp('quellen-')
        const store = new RegressionCaseStore(join(dir, 'regression-cases.json'))
        setRegressionCaseStore(store)
        const item = store.record({ userId: 'owner', taskType: 'recherche', request: PRIVATE, runId: 'run-1', failureClass: 'user-correction' })
        store.promote(item.id, 'test:doctor:c1')
        const doctor = { list: () => [{ id: 'c1', stage: 'resolved', evidenceRefs: [`regression:${item.id}`] }], ingest: () => { throw new Error('kein neuer Fall') } } as any
        await runThinkingTick({ isMain: true, now: new Date(), sink: new MemoryThoughtSink(), schedule: new IntervalSchedule(join(dir, 'schedule.json')), doctor, errorSource: { collect: () => [] } })
        expect(store.list()[0].status).toBe('resolved')
    })
})
