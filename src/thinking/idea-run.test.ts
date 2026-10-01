import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceInsights, ToolInsight } from '../learning/trace-analyzer.js'
import { findIdeaCandidates, runIdeaRun, type IdeaCandidate } from './idea-run.js'
import { MemoryThoughtSink, parseThinkingSettings, type LoadProbe, type LoadSample } from './ports.js'

const NIGHT = new Date(2026, 9, 2, 2, 30) // 02:30 local
const DAY = new Date(2026, 9, 2, 14, 0)

const probe = (sample: LoadSample): LoadProbe & { calls: number } => {
    const value = { calls: 0, async sample() { value.calls++; return sample } }
    return value
}
const IDLE: LoadSample = { measured: true, gpuUtilPercent: 3, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }

function tool(name: string, patch: Partial<ToolInsight>): ToolInsight {
    return { name, callCount: 20, avgLatencyMs: 300, p95LatencyMs: 600, errorRate: 0, avgResultSize: 100, cacheCandidates: 0, ...patch }
}
function insights(): TraceInsights {
    return {
        generatedAt: NIGHT.getTime(), tracesAnalyzed: 400, periodDays: 7,
        overall: { avgTotalLatencyMs: 4000, avgLlmLatencyMs: 2000, avgToolLatencyMs: 900, successRate: 0.9, avgToolCallsPerRequest: 2, avgSelfHealingRetries: 0.6 },
        tools: [
            tool('web_search', { avgLatencyMs: 9000, p95LatencyMs: 15000 }),
            tool('browser_fetch', { avgLatencyMs: 7000 }),
            tool('read_file', { errorRate: 0.4 }),
            tool('weather', { cacheCandidates: 6 }),
            tool('ha_state', { errorRate: 0.25 }),
        ],
        models: [{ modelId: 'qwen', provider: 'local', callCount: 300, avgLlmLatencyMs: 2000, avgTotalLatencyMs: 4000, successRate: 0.6, taskTypes: { chat: 300 } }],
        slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
    }
}
const settings = (patch: Record<string, unknown> = {}) => parseThinkingSettings({ enabled: true, ideas: { enabled: true, ...patch } })
const dir = () => mkdtempSync(join(process.cwd(), 'idea-run-'))

describe('Phase 3 Ideen-Lauf', () => {
    it('does not start while the GPU is busy (measured), and reads no inputs', async () => {
        const sink = new MemoryThoughtSink()
        const inputs = vi.fn(async () => ({ insights: insights() }))
        const load = probe({ measured: true, gpuUtilPercent: 92, vllmRunning: 0, vllmWaiting: 0, sources: ['nvidia-smi'] })
        const result = await runIdeaRun({ settings: settings(), load, sink, inputs, now: NIGHT, statePath: join(dir(), 's.json') })
        expect(result.ran).toBe(false)
        expect(result.reason).toMatch(/GPU/)
        expect(load.calls).toBe(1)
        expect(inputs).not.toHaveBeenCalled()
        expect(sink.thoughts).toHaveLength(0)
    })

    it('does not start while vLLM has requests in flight, even with low GPU utilisation', async () => {
        const sink = new MemoryThoughtSink()
        const result = await runIdeaRun({ settings: settings(), load: probe({ measured: true, gpuUtilPercent: 4, vllmRunning: 1, vllmWaiting: 2, sources: ['vllm'] }),
            sink, inputs: async () => ({ insights: insights() }), now: NIGHT, statePath: join(dir(), 's.json') })
        expect(result.ran).toBe(false)
        expect(result.reason).toMatch(/vLLM/)
        expect(sink.thoughts).toHaveLength(0)
    })

    it('treats an unmeasurable load as busy (measurement, not assumption)', async () => {
        const sink = new MemoryThoughtSink()
        const result = await runIdeaRun({ settings: settings(), load: probe({ measured: false, sources: [], error: 'kein nvidia-smi' }),
            sink, inputs: async () => ({ insights: insights() }), now: NIGHT, statePath: join(dir(), 's.json') })
        expect(result.ran).toBe(false)
        expect(result.reason).toMatch(/nicht messbar/)
        expect(sink.thoughts).toHaveLength(0)
    })

    it('runs only in the night window', async () => {
        const sink = new MemoryThoughtSink()
        const load = probe(IDLE)
        const result = await runIdeaRun({ settings: settings(), load, sink, inputs: async () => ({ insights: insights() }), now: DAY, statePath: join(dir(), 's.json') })
        expect(result.ran).toBe(false)
        expect(result.reason).toMatch(/Nachtfenster/)
        expect(load.calls).toBe(0)
    })

    it('proposes at most 3 ideas per day, also when the config asks for more', async () => {
        const sink = new MemoryThoughtSink()
        const statePath = join(dir(), 's.json')
        const first = await runIdeaRun({ settings: settings({ maxPerDay: 10 }), load: probe(IDLE), sink, inputs: async () => ({ insights: insights() }), now: NIGHT, statePath })
        expect(findIdeaCandidates({ insights: insights() }).length).toBeGreaterThan(3)
        expect(first.ideas).toHaveLength(3)
        const later = new Date(NIGHT.getTime() + 60 * 60_000)
        const second = await runIdeaRun({ settings: settings({ maxPerDay: 10 }), load: probe(IDLE), sink, inputs: async () => ({ insights: insights() }), now: later, statePath })
        expect(second.ideas).toHaveLength(0)
        expect(second.reason).toMatch(/Tagesgrenze/)
        expect(sink.thoughts).toHaveLength(3)
    })

    it('every idea carries evidence (number before, source) and a measurable target; it only asks', async () => {
        const sink = new MemoryThoughtSink()
        await runIdeaRun({ settings: settings(), load: probe(IDLE), sink, inputs: async () => ({ insights: insights() }), now: NIGHT, statePath: join(dir(), 's.json') })
        expect(sink.thoughts.length).toBeGreaterThan(0)
        for (const thought of sink.thoughts) {
            expect(thought.source).toBe('ideen-lauf')
            expect(thought.stufe).toBe('fragen')
            expect(thought.evidence.length).toBeGreaterThan(0)
            for (const evidence of thought.evidence) {
                expect(typeof evidence.value).toBe('number')
                expect(evidence.source).toMatch(/\S/)
            }
            expect(thought.target).toMatch(/\d/)
            expect(thought.proposal?.autoExecute).toBe(false)
        }
    })

    it('drops a rule candidate without evidence', async () => {
        const sink = new MemoryThoughtSink()
        const rules = (): IdeaCandidate[] => [
            { key: 'x:leer', rule: 'x', subject: 'leer', title: 'Ohne Beleg', evidence: [], target: 'irgendwas besser', severity: 9 },
            { key: 'x:voll', rule: 'x', subject: 'voll', title: 'Mit Beleg', evidence: [{ metric: 'avgLatencyMs', value: 9000, unit: 'ms', source: 'traces' }], target: 'unter 4500 ms', severity: 1 },
        ]
        const result = await runIdeaRun({ settings: settings(), load: probe(IDLE), sink, inputs: async () => ({ insights: insights() }), rules, now: NIGHT, statePath: join(dir(), 's.json') })
        expect(result.ideas.map(item => item.title)).toEqual(['Mit Beleg'])
    })

    it('rules find the candidates, the model only words them', async () => {
        const sink = new MemoryThoughtSink()
        const seen: IdeaCandidate[] = []
        const formulate = vi.fn(async (candidate: IdeaCandidate) => { seen.push(candidate); return 'Latenz ist 1 ms, alles super. Vorschlag: cachen.' })
        const result = await runIdeaRun({ settings: settings(), load: probe(IDLE), sink, inputs: async () => ({ insights: insights() }), formulate, now: NIGHT, statePath: join(dir(), 's.json') })
        expect(formulate).toHaveBeenCalledTimes(3)
        const expected = findIdeaCandidates({ insights: insights() })
        for (const idea of result.ideas) {
            const candidate = expected.find(item => item.key === idea.dedupeKey)!
            expect(idea.evidence).toEqual(candidate.evidence)
            expect(idea.target).toBe(candidate.target)
        }
        expect(Object.keys(seen[0]).sort()).toEqual(['evidence', 'key', 'rule', 'severity', 'subject', 'target', 'title'])
        const failing = await runIdeaRun({ settings: settings(), load: probe(IDLE), sink: new MemoryThoughtSink(), inputs: async () => ({ insights: insights() }),
            formulate: async () => { throw new Error('model down') }, now: NIGHT, statePath: join(dir(), 's.json') })
        expect(failing.ideas).toHaveLength(3)
        expect(failing.ideas.every(idea => idea.text.length > 0 && idea.evidence.length > 0)).toBe(true)
    })

    it('invents nothing from empty traces', () => {
        const empty = { ...insights(), tracesAnalyzed: 0, tools: [], models: [], overall: { ...insights().overall, avgSelfHealingRetries: 0 } }
        expect(findIdeaCandidates({ insights: empty })).toEqual([])
    })

    it('does not repeat the same idea within the dedupe window', async () => {
        const statePath = join(dir(), 's.json')
        const one = await runIdeaRun({ settings: settings(), load: probe(IDLE), sink: new MemoryThoughtSink(), inputs: async () => ({ insights: insights() }), now: NIGHT, statePath })
        const nextNight = new Date(NIGHT.getTime() + 24 * 60 * 60_000)
        const two = await runIdeaRun({ settings: settings(), load: probe(IDLE), sink: new MemoryThoughtSink(), inputs: async () => ({ insights: insights() }), now: nextNight, statePath })
        const firstKeys = new Set(one.ideas.map(item => item.dedupeKey))
        expect(two.ideas.length).toBeGreaterThan(0)
        expect(two.ideas.some(item => firstKeys.has(item.dedupeKey))).toBe(false)
    })

    it('flags a tool that became slower than the stored baseline, with before and after', () => {
        const baseline = insights()
        const now = insights()
        now.tools = [tool('ha_state', { avgLatencyMs: 2400 })]
        baseline.tools = [tool('ha_state', { avgLatencyMs: 800 })]
        const found = findIdeaCandidates({ insights: now, baseline: { tools: { ha_state: 800 }, at: '2026-09-25' } })
        const slower = found.find(item => item.rule === 'werkzeug-langsamer')!
        expect(slower.evidence.map(item => item.value)).toEqual([800, 2400])
    })
})
