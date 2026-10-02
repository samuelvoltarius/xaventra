/**
 * 2.83.0 Punkt 4: Das Ziel einer angenommenen Idee wird nach 7 Tagen mit
 * derselben Kennzahl nachgemessen. Ergebnis: Gedanke + Befund in den
 * Entscheidungen (Quelle „messung", nicht bindend). Kein Modell entscheidet.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceInsights, ToolInsight } from '../learning/trace-analyzer.js'
import { judgeIdeaTarget, measureIdeaTarget, noteIdeaAccepted, runIdeaRun } from './idea-run.js'
import { MemoryThoughtSink, parseThinkingSettings, type LoadProbe } from './ports.js'

const DAY = 24 * 60 * 60_000
const ACCEPTED = new Date(2026, 8, 20, 12, 0)
const LATER = new Date(ACCEPTED.getTime() + 7 * DAY + 60_000) // 7 Tage später, mittags (außerhalb Nachtfenster)
const BUSY: LoadProbe = { async sample() { return { measured: true, gpuUtilPercent: 99, vllmRunning: 3, vllmWaiting: 2, sources: ['test'] } } }

function tool(name: string, patch: Partial<ToolInsight>): ToolInsight {
    return { name, callCount: 20, avgLatencyMs: 300, p95LatencyMs: 600, errorRate: 0, avgResultSize: 100, cacheCandidates: 0, ...patch }
}
function insights(tools: ToolInsight[]): TraceInsights {
    return {
        generatedAt: LATER.getTime(), tracesAnalyzed: 300, periodDays: 7,
        overall: { avgTotalLatencyMs: 1000, avgLlmLatencyMs: 500, avgToolLatencyMs: 200, successRate: 0.95, avgToolCallsPerRequest: 1, avgSelfHealingRetries: 0 },
        tools, models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
    }
}
const settings = () => parseThinkingSettings({ enabled: true, ideas: { enabled: true } })
const statePath = () => join(mkdtempSync(join(process.cwd(), 'nachmessung-')), 'ideas-state.json')
const accept = (path: string) => noteIdeaAccepted({ key: 'werkzeug-langsam:web_search', regel: 'werkzeug-langsam', subjekt: 'web_search', metrik: 'avgLatencyMs', vorher: 8000, ziel: 4000, richtung: 'unter', einheit: 'ms' }, { now: ACCEPTED, statePath: path })

describe('Punkt 4: Ideen-Ziel nachmessen', () => {
    it('after 7 days the same metric is measured again: „Ziel erreicht (vorher 8000, jetzt 3000)" + a finding with source messung', async () => {
        const path = statePath()
        accept(path)
        const sink = new MemoryThoughtSink()
        const findings: any[] = []
        // Mittag + GPU belegt: das Nachmessen ist billig und läuft trotzdem; neue Ideen nicht.
        const result = await runIdeaRun({ settings: settings(), load: BUSY, sink, now: LATER, statePath: path,
            inputs: async () => ({ insights: insights([tool('web_search', { avgLatencyMs: 3000 })]) }),
            recordMeasurement: item => { findings.push(item) } })
        expect(result.ran).toBe(false)
        expect(sink.thoughts).toHaveLength(1)
        const thought = sink.thoughts[0]
        expect(thought.title).toMatch(/Ziel erreicht/)
        expect(thought.text).toContain('8000')
        expect(thought.text).toContain('3000')
        expect(thought.stufe).toBe('selbst')
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({ key: 'werkzeug-langsam:web_search', ergebnis: 'erreicht', vorher: 8000, jetzt: 3000, ziel: 4000 })
        const state = JSON.parse(readFileSync(path, 'utf8'))
        expect(state.angenommen?.['werkzeug-langsam:web_search']).toBeUndefined()
    })

    it('the default finding lands in decisions.ts with quelle.art === "messung" (not binding)', async () => {
        const { _setDecisionMainCheckForTest, listDecisions } = await import('../core/decisions.js')
        _setDecisionMainCheckForTest(() => true)
        try {
            const path = statePath()
            accept(path)
            await runIdeaRun({ settings: settings(), load: BUSY, sink: new MemoryThoughtSink(), now: LATER, statePath: path,
                inputs: async () => ({ insights: insights([tool('web_search', { avgLatencyMs: 3000 })]) }) })
            const entry = listDecisions().filter(item => item.quelle.art === 'messung').pop()!
            expect(entry).toBeTruthy()
            expect(entry.bindend).toBe(false)
            expect(entry.text).toMatch(/Ziel erreicht/)
            expect(entry.warum).toContain('8000')
            expect(entry.warum).toContain('3000')
        } finally { _setDecisionMainCheckForTest(null) }
    })

    it('too little data (callCount 2) is „nicht messbar", never „erreicht"', async () => {
        const path = statePath()
        accept(path)
        const sink = new MemoryThoughtSink()
        const findings: any[] = []
        await runIdeaRun({ settings: settings(), load: BUSY, sink, now: LATER, statePath: path,
            inputs: async () => ({ insights: insights([tool('web_search', { avgLatencyMs: 3000, callCount: 2 })]) }),
            recordMeasurement: item => { findings.push(item) } })
        expect(sink.thoughts[0].title).toMatch(/nicht messbar/)
        expect(sink.thoughts[0].title).not.toMatch(/erreicht/)
        expect(findings[0].ergebnis).toBe('nicht-messbar')
    })

    it('missed target: „verfehlt"; the same idea may come again later with the hint „letzter Versuch verfehlt"', async () => {
        const path = statePath()
        accept(path)
        const sink = new MemoryThoughtSink()
        await runIdeaRun({ settings: settings(), load: BUSY, sink, now: LATER, statePath: path,
            inputs: async () => ({ insights: insights([tool('web_search', { avgLatencyMs: 7000 })]) }) , recordMeasurement: () => {} })
        expect(sink.thoughts[0].title).toMatch(/verfehlt/)
        const night = new Date(LATER.getTime() + 20 * DAY); night.setHours(2, 30, 0, 0)
        const again = new MemoryThoughtSink()
        const idle: LoadProbe = { async sample() { return { measured: true, gpuUtilPercent: 1, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] } } }
        const result = await runIdeaRun({ settings: settings(), load: idle, sink: again, now: night, statePath: path,
            inputs: async () => ({ insights: insights([tool('web_search', { avgLatencyMs: 7000 })]) }), recordMeasurement: () => {} })
        expect(result.ideas.map(item => item.dedupeKey)).toContain('werkzeug-langsam:web_search')
        expect(result.ideas.find(item => item.dedupeKey === 'werkzeug-langsam:web_search')!.text).toMatch(/letzter Versuch verfehlt/)
    })

    it('not due yet (day 3): nothing is measured', async () => {
        const path = statePath()
        accept(path)
        const sink = new MemoryThoughtSink()
        const findings: any[] = []
        await runIdeaRun({ settings: settings(), load: BUSY, sink, now: new Date(ACCEPTED.getTime() + 3 * DAY), statePath: path,
            inputs: async () => ({ insights: insights([tool('web_search', { avgLatencyMs: 3000 })]) }), recordMeasurement: item => { findings.push(item) } })
        expect(sink.thoughts).toHaveLength(0)
        expect(findings).toHaveLength(0)
    })

    it('measureIdeaTarget / judgeIdeaTarget are pure and use the same fields as the rules', () => {
        const inputs = { insights: insights([tool('read_file', { errorRate: 0.05 })]) }
        expect(measureIdeaTarget('werkzeug-fehler', 'read_file', inputs)).toEqual({ value: 5 })
        expect(measureIdeaTarget('werkzeug-fehler', 'fehlt', inputs).value).toBeNull()
        expect(judgeIdeaTarget({ richtung: 'unter', ziel: 10 }, { value: 5 })).toBe('erreicht')
        expect(judgeIdeaTarget({ richtung: 'ueber', ziel: 90 }, { value: 80 })).toBe('verfehlt')
        expect(judgeIdeaTarget({ richtung: 'unter', ziel: 10 }, { value: null, reason: 'zu wenig Aufrufe' })).toBe('nicht-messbar')
    })
})
