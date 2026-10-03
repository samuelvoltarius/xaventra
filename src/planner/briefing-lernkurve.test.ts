import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBriefing, type BriefingSources } from './briefing.js'
import type { DeliveryPort, PlannerOutgoing } from './delivery-port.js'
import { startPlannerRuntime, stopPlannerRuntime } from './runtime.js'
import { createThoughtStore } from './thoughts.js'
import { getOutcomeRouter, OutcomeRouter } from '../routing/outcome-router.js'

// 2.83.0 Punkt 7: „Wird sie besser?“ — Erfolgsquote je Aufgabenart diese
// Woche gegen letzte Woche, nur im Abendbericht, nur aus Kernel-Proben.
const DAY = 86_400_000
let dir: string
let t: number

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lernkurve-'))
    t = Date.parse('2026-10-01T18:00:00.000Z') // 20:00 Vienna
})
afterEach(() => {
    stopPlannerRuntime()
    rmSync(dir, { recursive: true, force: true })
})

let runCounter = 0
function record(router: OutcomeRouter, taskType: string, ok: number, total: number, daysAgo: number, userId = 'owner@example.com'): string[] {
    const ids: string[] = []
    for (let index = 0; index < total; index++) {
        const runId = `run-${++runCounter}`
        ids.push(runId)
        expect(router.recordValidatedSample({
            runId, userId, taskType, model: 'local-model', success: index < ok, durationMs: 1000, costUsd: 0,
            validatedAt: new Date(t - daysAgo * DAY - index * 60_000).toISOString(),
            validationSource: 'nova-execution-kernel', evidenceRefs: ['tool:web_search'],
        })).toBe(true)
    }
    return ids
}

const newRouter = () => new OutcomeRouter({} as any, join(dir, 'shadow.jsonl'), 'shadow', join(dir, 'samples.json'))

function sources(router: OutcomeRouter, extra: Partial<BriefingSources> = {}): BriefingSources {
    return {
        dataDir: dir, thoughts: createThoughtStore({ dataDir: dir, now: () => t }), runsFile: join(dir, 'planner', 'runs.jsonl'), timeZone: 'Europe/Vienna',
        learning: { successTrend: now => router.successTrend(now) },
        ...extra,
    }
}

describe('Lernkurve im Abendbericht (Punkt 7)', () => {
    it('erklärt Metrik, Zeitfenster und nicht klassifizierte Aufgaben ohne Lernbehauptung', () => {
        const router = newRouter()
        record(router, 'none', 3, 5, 10)
        record(router, 'none', 4, 5, 2)
        const briefing = buildBriefing('abend', sources(router), t - DAY, t)
        expect(briefing.text).toContain('Nicht klassifiziert')
        expect(briefing.text).toContain('Erfolgsquote')
        expect(briefing.text).toContain('Vorwoche → diese Woche')
        expect(briefing.text).toContain('kein Lernnachweis')
    })
    it('recherche: Vorwoche 6/10, diese Woche 9/10 → „recherche 60 % → 90 %“', () => {
        const router = newRouter()
        record(router, 'recherche', 6, 10, 10)
        record(router, 'recherche', 9, 10, 2)
        const briefing = buildBriefing('abend', sources(router), t - DAY, t)
        expect(briefing.text).toContain('Lernkurve:')
        expect(briefing.text).toContain('recherche 60 % → 90 %')
        expect(briefing.counts.lernkurve).toBe(1)
    })

    it('unter 5 Proben in einem Fenster: keine Zeile', () => {
        const router = newRouter()
        record(router, 'code', 4, 4, 10)
        record(router, 'code', 3, 6, 2)
        const briefing = buildBriefing('abend', sources(router), t - DAY, t)
        expect(briefing.text).not.toContain('Lernkurve')
        expect(briefing.text).not.toContain('code')
    })

    it('Morgenbericht hat keinen Abschnitt „Lernkurve“', () => {
        const router = newRouter()
        record(router, 'recherche', 6, 10, 10)
        record(router, 'recherche', 9, 10, 2)
        const briefing = buildBriefing('morgen', sources(router), t - DAY, t)
        expect(briefing.text).not.toContain('Lernkurve')
    })

    it('Owner-Zurückweisungen zählen als Fehlschlag und als eigene Zeile', () => {
        t = Date.now() // invalidation is stamped with the real clock
        const router = newRouter()
        record(router, 'recherche', 10, 10, 10)
        const current = record(router, 'recherche', 10, 10, 2)
        expect(router.invalidateValidatedSample(current[0], 'owner@example.com', 'user-correction')).toBe(true)
        expect(router.invalidateValidatedSample(current[1], 'owner@example.com', 'user-correction')).toBe(true)
        t = Date.now() + 1000
        const trend = router.successTrend(t)
        expect(trend.taskTypes).toEqual([{ taskType: 'recherche', previous: { samples: 10, successes: 10 }, current: { samples: 10, successes: 8 } }])
        expect(trend.rejected).toEqual({ previous: 0, current: 2 })
        const briefing = buildBriefing('abend', sources(router), t - DAY, t)
        expect(briefing.text).toContain('recherche 100 % → 80 %')
        expect(briefing.text).toContain('Owner-Zurückweisungen: 2 (Vorwoche 0)')
    })

    it('ältere Proben (> 14 Tage) und Zukunft zählen nicht', () => {
        const router = newRouter()
        record(router, 'recherche', 0, 10, 20)
        record(router, 'recherche', 5, 5, 10)
        record(router, 'recherche', 5, 5, 2)
        record(router, 'recherche', 0, 5, -3)
        expect(router.successTrend(t).taskTypes).toEqual([{ taskType: 'recherche', previous: { samples: 5, successes: 5 }, current: { samples: 5, successes: 5 } }])
    })

    it('optionaler Eingang für Vorschlags-Zeilen (Paket C) erscheint mit; wirft er, bleibt der Rest', () => {
        const router = newRouter()
        record(router, 'recherche', 6, 10, 10)
        record(router, 'recherche', 9, 10, 2)
        const withSuggestions = buildBriefing('abend', sources(router, { learning: {
            successTrend: now => router.successTrend(now),
            suggestionLines: () => ['Vorschläge angenommen: 3/5', 'unterdrückt: idee:werkzeug-cache'],
        } }), t - DAY, t)
        expect(withSuggestions.text).toContain('Vorschläge angenommen: 3/5')
        expect(withSuggestions.text).toContain('unterdrückt: idee:werkzeug-cache')
        expect(withSuggestions.text).toContain('recherche 60 % → 90 %')
        const broken = buildBriefing('abend', sources(router, { learning: {
            successTrend: now => router.successTrend(now),
            suggestionLines: () => { throw new Error('getter fehlt') },
        } }), t - DAY, t)
        expect(broken.text).toContain('recherche 60 % → 90 %')
    })

    it('höchstens 5 Zeilen, die Zusatzzeilen bleiben sichtbar', () => {
        const router = newRouter()
        for (const task of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) { record(router, task, 5, 5, 10); record(router, task, 5, 5, 2) }
        const briefing = buildBriefing('abend', sources(router, { learning: {
            successTrend: now => router.successTrend(now),
            suggestionLines: () => ['Vorschläge angenommen: 1/2'],
        } }), t - DAY, t)
        const section = briefing.text.split('Lernkurve:')[1].split('\n\n')[0].trim().split('\n')
        expect(section).toHaveLength(5)
        expect(section.at(-1)).toContain('Vorschläge angenommen: 1/2')
    })

    it('Planer-Laufzeit schließt den Outcome-Router an (Abendbericht über den Planer)', async () => {
        record(getOutcomeRouter(), 'recherche', 6, 10, 10)
        record(getOutcomeRouter(), 'recherche', 9, 10, 2)
        const sent: PlannerOutgoing[] = []
        const port: DeliveryPort = { name: 'test-port', deliver: async msg => { sent.push(msg); return { status: 'zugestellt' } } }
        t = Date.parse('2026-10-01T16:00:00.000Z')
        const runtime = await startPlannerRuntime({ briefing: { enabled: true, evening: '20:00', morning: '07:00' } }, { dataDir: dir, now: () => t, authority: () => true, startTimer: false, port })
        await runtime!.planner.tick()
        t = Date.parse('2026-10-01T18:00:30.000Z')
        await runtime!.planner.tick()
        await runtime!.planner.tick()
        expect(sent).toHaveLength(1)
        expect(sent[0].text).toContain('recherche 60 % → 90 %')
    })
})
