/**
 * 2.84 Punkt 6: Lern-Puls — Zufluss je Lernspeicher diese Woche gegen die
 * Vorwoche und Nutzen des Gelernten, im vorhandenen Lernkurven-Abschnitt des
 * Abendberichts. Ein wachstumspflichtiger Speicher, der 7 Tage trotz Betrieb
 * nicht wächst, wird über den einen Bug-Finder ein Fall.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBriefing, createBriefingHandler, type BriefingSources } from '../planner/briefing.js'
import { createThoughtStore } from '../planner/thoughts.js'
import { groupRecurring } from '../thinking/bug-finder.js'

const DAY = 86_400_000
const t = Date.parse('2026-10-01T18:00:00.000Z')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lern-puls-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const days = (...ago: number[]) => ago.map(value => t - value * DAY)
const spread = (count: number, spanDays: number) => Array.from({ length: count }, (_, index) => t - Math.floor((index * spanDays * DAY) / count) - 1_000)

function briefingSources(flowLines: BriefingSources['learning'] extends infer L ? L extends { flowLines?: infer F } ? F : never : never): BriefingSources {
    return {
        dataDir: dir, thoughts: createThoughtStore({ dataDir: dir, now: () => t }), runsFile: join(dir, 'planner', 'runs.jsonl'), timeZone: 'Europe/Vienna',
        learning: { successTrend: () => ({ taskTypes: [], rejected: { current: 0, previous: 0 } }), flowLines },
    } as BriefingSources
}

describe('Lern-Puls im Abendbericht', () => {
    it('Zufluss: 4 neue Prozeduren diese Woche, 1 in der Vorwoche → „Prozeduren 4 (Vorwoche 1)“', async () => {
        const { learningFlow, learningFlowLines } = await import('./learning-flow.js')
        const flow = await learningFlow(t, {
            channels: { prozeduren: () => days(1, 2, 3, 6, 9), gedaechtnis: () => days(0.5, 8, 10) },
            usage: () => ({ prozeduren: { uses: 9, ok: 8 } }),
        })
        const lines = learningFlowLines(flow)
        expect(lines.length).toBeLessThanOrEqual(2)
        expect(lines[0]).toContain('Prozeduren 4 (Vorwoche 1)')
        expect(lines[0]).toContain('Gedächtnis 1 (Vorwoche 2)')
        expect(lines[1]).toContain('Prozeduren 9× (8 ok)')

        const briefing = buildBriefing('abend', briefingSources(() => lines), t - DAY, t)
        expect(briefing.text).toContain('Lernkurve:')
        expect(briefing.text).toContain('Prozeduren 4 (Vorwoche 1)')
        // Morgens kein Lern-Puls (wie die Lernkurve).
        expect(buildBriefing('morgen', briefingSources(() => lines), t - DAY, t).text).not.toContain('Prozeduren 4')
    })

    it('der Bericht-Job holt den Puls asynchron (LanceDB-Zählung) und zeigt ihn', async () => {
        const handler = createBriefingHandler({ kind: 'abend', sources: briefingSources(async () => ['Gelernt diese Woche: Gedächtnis 12 (Vorwoche 3)']) })
        const result: any = await handler.run({} as any, { now: t } as any)
        expect(result.outgoing.text).toContain('Gedächtnis 12 (Vorwoche 3)')
    })

    it('ohne Daten keine Zeile', async () => {
        const { learningFlow, learningFlowLines } = await import('./learning-flow.js')
        expect(learningFlowLines(await learningFlow(t, { channels: { prozeduren: () => null }, usage: () => ({}) }))).toEqual([])
    })
})

describe('Stummer Lernkanal → Bug-Finder', () => {
    it('30 validierte Owner-Läufe, 0 neue Gedächtnis-Einträge in 7 Tagen → Vorkommen lernkanal:gedaechtnis', async () => {
        const { learningFlowErrorSource } = await import('./learning-flow.js')
        const source = learningFlowErrorSource({ now: () => t, sources: { channels: { gedaechtnis: () => [], prozeduren: () => null }, ownerRuns: () => spread(30, 7) } })
        const occurrences = await source.collect(t - 7 * DAY)
        expect(occurrences.length).toBeGreaterThan(0)
        expect(new Set(occurrences.map(item => item.subject))).toEqual(new Set(['lernkanal:gedaechtnis']))
        expect(occurrences[0].message).not.toMatch(/Owner sagt|Kaffee/) // nur Zahlen, keine Inhalte
    })

    it('mit nur 2 Läufen kein Vorkommen', async () => {
        const { learningFlowErrorSource } = await import('./learning-flow.js')
        const source = learningFlowErrorSource({ now: () => t, sources: { channels: { gedaechtnis: () => [] }, ownerRuns: () => spread(2, 7) } })
        expect(await source.collect(t - 7 * DAY)).toEqual([])
    })

    it('jeden Tag ein Vorkommen: ab minOccurrences Tagen eine Gruppe für den einen Bug-Finder', async () => {
        const { learningFlowErrorSource } = await import('./learning-flow.js')
        const source = learningFlowErrorSource({ now: () => t, sources: { channels: { gedaechtnis: () => [], graph: () => days(0.5, 3, 6, 9, 12) }, ownerRuns: () => spread(90, 14) } })
        const occurrences = await source.collect(t - 7 * DAY)
        expect(occurrences.filter(item => item.subject === 'lernkanal:gedaechtnis').length).toBeGreaterThanOrEqual(5)
        const groups = groupRecurring(occurrences, 5)
        expect(groups.map(group => group.subject)).toEqual(['lernkanal:gedaechtnis'])
        // Schmiede und Routine-Skills melden nie „stumm“.
        const quiet = learningFlowErrorSource({ now: () => t, sources: { channels: { skills: () => [], werkzeuge: () => [] }, ownerRuns: () => spread(90, 14) } })
        expect(await quiet.collect(t - 7 * DAY)).toEqual([])
    })

    it('Schließen: danach 3 neue Einträge → successes()[lernkanal:gedaechtnis] === 3', async () => {
        const { learningFlowErrorSource } = await import('./learning-flow.js')
        const source = learningFlowErrorSource({ now: () => t, sources: { channels: { gedaechtnis: () => days(0.1, 0.2, 0.3, 9) }, ownerRuns: () => spread(30, 7) } })
        expect((await source.successes!(t - DAY))['lernkanal:gedaechtnis']).toBe(3)
        // wieder Zufluss: keine Vorkommen mehr, der Fall kann gemessen schließen
        expect(await source.collect(t - 7 * DAY)).toEqual([])
    })

    it('ist eine der Quellen des einen Bug-Finders', async () => {
        const { defaultErrorSources } = await import('../thinking/thinking-runtime.js')
        const { isLearningFlowSource } = await import('./learning-flow.js')
        expect(defaultErrorSources().filter(isLearningFlowSource)).toHaveLength(1)
    })
})
