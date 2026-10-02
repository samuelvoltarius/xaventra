/**
 * 2.83.0 Punkt 10: Owner-„Nein" wirkt messbar. Ab 3× Nein (Faktor < 0,45)
 * bringt der Ideen-Lauf diese Art nicht mehr; darunter wird der Gedanke nur
 * noch eine Idee im Bericht (niedrig, keine Karte). Fragen sind nicht
 * automatisch „wichtig". Alarme werden nie gedämpft.
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TraceInsights, ToolInsight } from '../learning/trace-analyzer.js'
import { _setDecisionMainCheckForTest, recordThoughtAnswer, thoughtAcceptance, thoughtImportanceFactor, THOUGHT_SUPPRESS_BELOW } from './decisions.js'
import { createSensingThoughtSink, createThinkingThoughtSink } from './thought-hub.js'
import { listThoughts } from '../planner/index.js'
import { rateImportance } from '../planner/thoughts.js'
import { runIdeaRun } from '../thinking/idea-run.js'
import { MemoryThoughtSink, parseThinkingSettings } from '../thinking/ports.js'

const NIGHT = new Date(2026, 9, 2, 2, 30)
const IDLE = { async sample() { return { measured: true, gpuUtilPercent: 1, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] } } }
const tool = (name: string, patch: Partial<ToolInsight>): ToolInsight => ({ name, callCount: 20, avgLatencyMs: 300, p95LatencyMs: 600, errorRate: 0, avgResultSize: 100, cacheCandidates: 0, ...patch })
const insights = (tools: ToolInsight[]): TraceInsights => ({
    generatedAt: NIGHT.getTime(), tracesAnalyzed: 300, periodDays: 7,
    overall: { avgTotalLatencyMs: 1000, avgLlmLatencyMs: 500, avgToolLatencyMs: 200, successRate: 0.95, avgToolCallsPerRequest: 1, avgSelfHealingRetries: 0 },
    tools, models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
})
const run = (tools: ToolInsight[], sink = new MemoryThoughtSink()) => runIdeaRun({
    settings: parseThinkingSettings({ enabled: true, ideas: { enabled: true } }), load: IDLE, sink, now: NIGHT,
    statePath: join(mkdtempSync(join(process.cwd(), 'nein-wirkt-')), 's.json'),
    inputs: async () => ({ insights: insights(tools) }), importanceFactor: kind => thoughtImportanceFactor(kind),
})

beforeAll(() => _setDecisionMainCheckForTest(() => true))
afterAll(() => _setDecisionMainCheckForTest(null))

describe('Punkt 10: drei Nein unterdrücken diese Art Vorschlag', () => {
    it('3× Nein on idee:werkzeug-cache → a new idea run brings 0 ideas of that kind (today: 1 with „wichtig")', async () => {
        for (let i = 0; i < 3; i++) recordThoughtAnswer('idee:werkzeug-cache', 'nein')
        expect(thoughtImportanceFactor('idee:werkzeug-cache')).toBeLessThan(THOUGHT_SUPPRESS_BELOW)
        const result = await run([tool('weather', { cacheCandidates: 6 })])
        expect(result.ideas.filter(item => item.kind === 'idee:werkzeug-cache')).toHaveLength(0)
    })

    it('Gegenprobe: another kind without Nein still comes', async () => {
        const result = await run([tool('weather', { cacheCandidates: 6, errorRate: 0.5 })])
        expect(result.ideas.map(item => item.kind)).toEqual(['idee:werkzeug-fehler'])
    })

    it('a Ja lifts the penalty slowly: after 3× Nein + 1× Ja the kind comes back, but only as a report idea', async () => {
        for (let i = 0; i < 3; i++) recordThoughtAnswer('idee:werkzeug-langsamer', 'nein')
        recordThoughtAnswer('idee:werkzeug-langsamer', 'ja')
        expect(thoughtImportanceFactor('idee:werkzeug-langsamer')).toBeGreaterThanOrEqual(THOUGHT_SUPPRESS_BELOW)
        expect(thoughtImportanceFactor('idee:werkzeug-langsamer')).toBeLessThan(1)
    })
})

describe('Punkt 10: nach einem Nein nur noch Idee im Bericht, keine Karte', () => {
    it('after 1× Nein the thought is created as „idee" with „niedrig" and no notice (no card)', async () => {
        recordThoughtAnswer('idee:werkzeug-fehler', 'nein')
        await run([tool('ha_state', { errorRate: 0.6 })], { emit: thought => createThinkingThoughtSink().emit(thought) } as any)
        const thought = listThoughts({ limit: 500 }).find(item => item.title.includes('ha_state'))!
        expect(thought.kind).toBe('idee')
        expect(thought.importance).toBe('niedrig')
        expect(thought.notice).toBe('keine')
    })

    it('Gegenprobe: without any Nein the idea is a proposal (vorschlag) that asks', async () => {
        await run([tool('kalender_lesen', { avgLatencyMs: 9000, p95LatencyMs: 12000 })], { emit: thought => createThinkingThoughtSink().emit(thought) } as any)
        const thought = listThoughts({ limit: 500 }).find(item => item.title.includes('kalender_lesen'))!
        expect(thought.kind).toBe('vorschlag')
        expect(thought.permission).toBe('fragen')
    })

    it('alarms are never dampened: a sensing alarm with the same words stays urgent', async () => {
        recordThoughtAnswer('wahrnehmen', 'nein')
        await createSensingThoughtSink().writeThought({ source: 'watch', title: 'Platte voll auf nas', summary: '98 %', importance: 'dringend', level: 'selbst', dedupeKey: 'alarm:nas-voll' })
        const thought = listThoughts({ limit: 500 }).find(item => item.title.includes('Platte voll'))!
        expect(thought.importance).toBe('dringend')
    })
})

describe('Punkt 10: Bewertung in thoughts.ts — Fragen sind nicht automatisch „wichtig"', () => {
    it('a question with an owner-feedback weight below 1 is not „wichtig" (also not via severity warning)', () => {
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen', severity: 'info', weight: 0.75 }).importance).not.toBe('wichtig')
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen', severity: 'warning', weight: 0.75 }).importance).not.toBe('wichtig')
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen', weight: 0.5 }).rule).toBe('regel:owner-nein-gedaempft')
    })
    it('Gegenprobe: unweighted questions and critical alarms keep their rating', () => {
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen', severity: 'info' }).importance).toBe('wichtig')
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen', weight: 1 }).importance).toBe('wichtig')
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen', severity: 'critical', weight: 0.2 }).importance).toBe('dringend')
        expect(rateImportance({ kind: 'ereignis', permission: 'selbst', severity: 'warning', weight: 0.2 }).importance).toBe('wichtig')
    })
})

describe('Punkt 10: Lesefunktion thoughtAcceptance (für Paket D, Lernkurve)', () => {
    it('counts Ja/Nein per kind within the window', () => {
        const dir = mkdtempSync(join(process.cwd(), 'acceptance-'))
        let now = Date.parse('2026-09-20T10:00:00Z')
        const opts = { dataDir: dir, now: () => now, isMain: () => true }
        recordThoughtAnswer('idee:werkzeug-cache', 'ja', opts)          // vor dem Fenster
        now = Date.parse('2026-09-28T10:00:00Z')
        for (let i = 0; i < 3; i++) recordThoughtAnswer('idee:werkzeug-cache', 'nein', opts)
        recordThoughtAnswer('modell-wechsel', 'spaeter', opts)          // weder Ja noch Nein
        expect(thoughtAcceptance(Date.parse('2026-09-25T00:00:00Z'), opts)).toEqual({ 'idee:werkzeug-cache': { ja: 0, nein: 3 } })
        expect(thoughtAcceptance(Date.parse('2026-09-01T00:00:00Z'), opts)).toEqual({ 'idee:werkzeug-cache': { ja: 1, nein: 3 } })
    })
})
