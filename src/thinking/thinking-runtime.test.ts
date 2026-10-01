import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IntervalSchedule, JsonlThoughtSink, MemoryThoughtSink, parseThinkingSettings, parseVllmMetrics, type LoadSample } from './ports.js'
import { runThinkingTick, setThinkingConfig } from './thinking-runtime.js'

const NIGHT = new Date(2026, 9, 2, 2, 0)
const IDLE: LoadSample = { measured: true, gpuUtilPercent: 1, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }
const ALL_ON = { enabled: true, ideas: { enabled: true }, scout: { enabled: true }, bugFinder: { enabled: true }, learning: { enabled: true } }
const insights = () => ({
    generatedAt: 0, tracesAnalyzed: 100, periodDays: 7,
    overall: { avgTotalLatencyMs: 1, avgLlmLatencyMs: 1, avgToolLatencyMs: 1, successRate: 1, avgToolCallsPerRequest: 1, avgSelfHealingRetries: 0 },
    tools: [{ name: 'web_search', callCount: 30, avgLatencyMs: 9000, p95LatencyMs: 12000, errorRate: 0, avgResultSize: 1, cacheCandidates: 0 }],
    models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
})

function deps(dir: string) {
    return {
        sink: new MemoryThoughtSink(),
        schedule: new IntervalSchedule(join(dir, 'schedule.json')),
        load: { sample: vi.fn(async () => IDLE) },
        ideaInputs: vi.fn(async () => ({ insights: insights() })),
        errorSource: { collect: vi.fn(async () => []) },
        scoutSources: [{ name: 'fixture', list: vi.fn(async () => []) }],
        doctor: { list: () => [], ingest: vi.fn() } as any,
        statePaths: { ideas: join(dir, 'ideas.json'), scoutReport: join(dir, 'scout.json') },
    }
}

describe('Phase 3 Denken: Laufzeit', () => {
    it('P8: everything is on at the Main without config, off on a worker; enabled:false switches all off', async () => {
        const defaults = parseThinkingSettings(undefined, {} as NodeJS.ProcessEnv)
        expect([defaults.enabled, defaults.ideas.enabled, defaults.scout.enabled, defaults.bugFinder.enabled, defaults.learning.enabled]).toEqual([true, true, true, true, true])
        const worker = parseThinkingSettings(undefined, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv)
        expect([worker.enabled, worker.ideas.enabled, worker.scout.enabled, worker.bugFinder.enabled]).toEqual([false, false, false, false])
        // the GPU/night conditions stay (defaults unchanged)
        expect(defaults.load.maxGpuUtilPercent).toBe(20)
        expect(defaults.ideas.maxPerDay).toBe(3)
        setThinkingConfig({ enabled: false })
        const d = deps(mkdtempSync(join(process.cwd(), 'think-')))
        const result = await runThinkingTick({ isMain: true, now: NIGHT, ...d })
        expect(result.ran).toEqual([])
        expect(d.load.sample).not.toHaveBeenCalled()
        expect(d.ideaInputs).not.toHaveBeenCalled()
        // a part switched on while the master switch is off stays off; a part can be switched off alone
        expect(parseThinkingSettings({ enabled: false, ideas: { enabled: true } }, {} as NodeJS.ProcessEnv).ideas.enabled).toBe(false)
        expect(parseThinkingSettings({ ideas: { enabled: false } }, {} as NodeJS.ProcessEnv).ideas.enabled).toBe(false)
    })

    it('a worker (no Main lease) thinks nothing and sends nothing', async () => {
        setThinkingConfig(ALL_ON)
        const d = deps(mkdtempSync(join(process.cwd(), 'think-')))
        const result = await runThinkingTick({ isMain: false, now: NIGHT, ...d })
        expect(result.ran).toEqual([])
        expect(result.skipped).toEqual({ alle: 'kein Main (Worker denken nicht, senden nichts)' })
        expect(d.sink.thoughts).toHaveLength(0)
        expect(d.load.sample).not.toHaveBeenCalled()
        expect(d.errorSource.collect).not.toHaveBeenCalled()
        expect(d.scoutSources[0].list).not.toHaveBeenCalled()
        setThinkingConfig(undefined)
    })

    it('the Main writes thoughts only to the ThoughtSink, and the schedule spaces the runs', async () => {
        setThinkingConfig(ALL_ON)
        const dir = mkdtempSync(join(process.cwd(), 'think-'))
        const d = deps(dir)
        const first = await runThinkingTick({ isMain: true, now: NIGHT, ...d })
        expect(first.ran).toEqual(expect.arrayContaining(['ideen', 'bugs', 'scout']))
        expect(d.sink.thoughts.length).toBeGreaterThan(0)
        const second = await runThinkingTick({ isMain: true, now: new Date(NIGHT.getTime() + 10 * 60_000), ...d })
        expect(second.ran).toEqual([])
        setThinkingConfig(undefined)
    })

    it('no thinking module talks to a channel, a notifier or the model switch', () => {
        const root = resolve(process.env.NOVA_PROJECT_ROOT || process.cwd(), 'src', 'thinking')
        const files = readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        expect(files.length).toBeGreaterThanOrEqual(6)
        for (const name of files) {
            const text = readFileSync(join(root, name), 'utf8')
            expect(text, name).not.toMatch(/from ['"][^'"]*(telegram|channels?\/|proactive|notif|messenger|whatsapp|discord|slack)[^'"]*['"]/i)
            expect(text, name).not.toMatch(/sendGovernedProactive|sendNotification|switchModel\s*\(/)
        }
    })

    it('the default sink appends JSONL under the data directory', async () => {
        const path = join(mkdtempSync(join(process.cwd(), 'think-')), 'thoughts.jsonl')
        const sink = new JsonlThoughtSink(path)
        await sink.emit({ id: 't1', createdAt: NIGHT.toISOString(), source: 'lernen', kind: 'x', title: 'T', text: 'token=abcdefghijklmnop1234 x', evidence: [], importance: 0.5, stufe: 'fragen', status: 'neu', dedupeKey: 'k' })
        const line = JSON.parse(readFileSync(path, 'utf8').trim())
        expect(line.id).toBe('t1')
        expect(line.text).not.toContain('abcdefghijklmnop1234')
    })

    it('parses vLLM queue metrics', () => {
        const text = '# HELP vllm:num_requests_running x\nvllm:num_requests_running{model_name="qwen"} 2.0\nvllm:num_requests_waiting{model_name="qwen"} 1\n'
        expect(parseVllmMetrics(text)).toEqual({ running: 2, waiting: 1 })
        expect(parseVllmMetrics('nothing here')).toBeNull()
    })
})
