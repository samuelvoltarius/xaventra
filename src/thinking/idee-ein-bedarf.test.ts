/**
 * 2.86 Punkt 2 (Anteil Ideen-Lauf, mit Paket F): ein Bedarf, ein Empfänger.
 * Scheitert ein Werkzeug, weil seine Fähigkeit auf keinem Knoten läuft (der
 * Software-Scout führt sie als fehlend), ist das kein Fall für eine
 * `werkzeug-fehler`-Idee — der Scout ist der eine Empfänger.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getNovaDataDir } from '../core/data-root.js'
import { runIdeaRun } from './idea-run.js'
import { MemoryThoughtSink, parseThinkingSettings } from './ports.js'

const NIGHT = new Date(2026, 9, 2, 2, 30)
const IDLE = { measured: true, gpuUtilPercent: 2, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }

function insights(tools: any[]) {
    return {
        generatedAt: NIGHT.getTime(), tracesAnalyzed: 400, periodDays: 7,
        overall: { avgTotalLatencyMs: 1000, avgLlmLatencyMs: 500, avgToolLatencyMs: 200, successRate: 0.95, avgToolCallsPerRequest: 1, avgSelfHealingRetries: 0 },
        tools: tools.map(item => ({ callCount: 20, avgLatencyMs: 300, p95LatencyMs: 600, errorRate: 0, avgResultSize: 100, cacheCandidates: 0, ...item })),
        models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
    } as any
}

async function run() {
    const sink = new MemoryThoughtSink()
    const result = await runIdeaRun({
        settings: parseThinkingSettings({ enabled: true, ideas: { enabled: true } }),
        load: { async sample() { return IDLE } }, sink,
        inputs: async () => ({ insights: insights([{ name: 'analyze_image', errorRate: 0.6 }, { name: 'web_search', errorRate: 0.5 }]) }),
        now: NIGHT, statePath: join(mkdtempSync(join(process.cwd(), 'idee-bedarf-')), 's.json'),
    })
    return result.ideas.map(item => String(item.dedupeKey))
}

describe('Ideen-Lauf: Fähigkeitswerkzeuge gehen an den Software-Scout, nicht in eine Idee', () => {
    it('without a scout record both failing tools are ideas (Gegenprobe)', async () => {
        const keys = await run()
        expect(keys).toContain('werkzeug-fehler:analyze_image')
        expect(keys).toContain('werkzeug-fehler:web_search')
    })

    it('vision recorded missing by the scout → no werkzeug-fehler idea for analyze_image; web_search stays', async () => {
        const file = getNovaDataDir('software-scout', 'state.json')
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ missing: { vision: Date.now() } }))
        const keys = await run()
        expect(keys).not.toContain('werkzeug-fehler:analyze_image')
        expect(keys).toContain('werkzeug-fehler:web_search')
    })
})
