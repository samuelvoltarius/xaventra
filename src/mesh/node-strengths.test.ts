import { describe, expect, it } from 'vitest'
import {
    describeStrengthChanges, measurementsFromOwnerRuns, rankNodes, STRENGTH_CAPABILITIES,
    type StrengthFacts, type StrengthNodeFacts,
} from './node-strengths.js'

// 2.86 Paket J "Ein Mesh-Gehirn": EIN Modul für Knoten-Stärken aus gemessenen
// Fakten. Testdaten: drei Knoten wie Alfreds Beispiel (A GPU, B viel RAM, C viel Platte).
const NOW = Date.parse('2026-10-02T12:00:00.000Z')

function node(id: string, patch: Partial<StrengthNodeFacts> = {}, hw: Partial<StrengthNodeFacts['hardware']> = {}): StrengthNodeFacts {
    return {
        nodeId: id, local: false, lastSeen: NOW - 30_000, role: 'worker', selfCheck: 'ok', runtimes: [], tools: [],
        ...patch,
        hardware: { cpus: 8, ramGB: 16, gpuName: null, gpuBackend: 'cpu', viaVllm: false, ...hw },
    }
}

const A = node('knoten-a', { tools: ['ffmpeg'], runtimes: [{ name: 'comfyui', type: 'image', models: ['sdxl'], running: true }] },
    { gpuName: 'NVIDIA RTX 4090', gpuBackend: 'cuda', gpuVramGB: 24, ramGB: 32, diskTotalGB: 500, diskFreeGB: 120 })
const B = node('knoten-b', { runtimes: [{ name: 'ollama', type: 'llm', models: ['qwen2.5:72b', 'nomic-embed-text'], running: true }] },
    { ramGB: 128, cpus: 20, gpuName: 'GB10', gpuBackend: 'cuda', viaVllm: true, unifiedMemory: true, diskTotalGB: 1000, diskFreeGB: 300 })
const C = node('knoten-c', { modelOnly: true }, { ramGB: 8, cpus: 4, diskTotalGB: 16000, diskFreeGB: 9000 })

const facts = (nodes: StrengthNodeFacts[], measurements: StrengthFacts['measurements'] = []): StrengthFacts => ({ nodes, measurements, now: NOW })

describe('rankNodes — wer kann was am besten (deterministisch, mit Begründung je Platz)', () => {
    it('Bilder → Knoten A (GPU + laufender Bild-Dienst), mit Begründung', () => {
        const ranking = rankNodes('bilder', facts([C, B, A]))
        expect(ranking.ranked[0].nodeId).toBe('knoten-a')
        expect(ranking.ranked[0].place).toBe(1)
        expect(ranking.ranked[0].reasons.join(' ')).toMatch(/GPU.*RTX 4090/)
        expect(ranking.ranked[0].reasons.join(' ')).toMatch(/comfyui/)
        // C hat weder GPU noch Bild-Dienst → ausgeschlossen, nicht still verschwunden.
        expect(ranking.excluded.map(item => item.nodeId)).toContain('knoten-c')
    })

    it('große Modelle → Knoten B (mehr nutzbarer Speicher)', () => {
        const ranking = rankNodes('grosse-modelle', facts([A, B, C]))
        expect(ranking.ranked[0].nodeId).toBe('knoten-b')
        expect(ranking.ranked[0].reasons.join(' ')).toMatch(/128 GB/)
    })

    it('Speicher/Backups → Knoten C (viel freie Platte)', () => {
        const ranking = rankNodes('speicher', facts([A, B, C]))
        expect(ranking.ranked.map(item => item.nodeId)).toEqual(['knoten-c', 'knoten-b', 'knoten-a'])
        expect(ranking.ranked[0].reasons.join(' ')).toMatch(/9000 GB frei/)
    })

    it('ist deterministisch: Reihenfolge der Eingabe ändert nichts, Gleichstand nach Knoten-ID', () => {
        const twin = node('knoten-0', {}, { ramGB: 16 })
        const one = rankNodes('rechnen', facts([twin, node('knoten-1', {}, { ramGB: 16 })]))
        const two = rankNodes('rechnen', facts([node('knoten-1', {}, { ramGB: 16 }), twin]))
        expect(one).toEqual(two)
        expect(one.ranked.map(item => item.nodeId)).toEqual(['knoten-0', 'knoten-1'])
    })

    it('veraltete und kritische Knoten werden mit Grund ausgeschlossen', () => {
        const stale = node('alt', { lastSeen: NOW - 60 * 60_000 }, { ramGB: 512 })
        const broken = node('kaputt', { selfCheck: 'crit' }, { ramGB: 512 })
        const ranking = rankNodes('grosse-modelle', facts([stale, broken, B]))
        expect(ranking.ranked.map(item => item.nodeId)).toEqual(['knoten-b'])
        expect(ranking.excluded).toEqual(expect.arrayContaining([
            expect.objectContaining({ nodeId: 'alt', reason: expect.stringMatching(/veraltet/) }),
            expect.objectContaining({ nodeId: 'kaputt', reason: expect.stringMatching(/kritisch/) }),
        ]))
    })

    it('gemessene Erfolgsraten (nur ab Mindestzahl) verschieben die Reihenfolge und stehen in der Begründung', () => {
        const left = node('links', { runtimes: [{ name: 'ollama', type: 'llm', models: ['qwen2.5:14b'], running: true }] }, { ramGB: 64 })
        const right = node('rechts', { runtimes: [{ name: 'ollama', type: 'llm', models: ['qwen2.5:14b'], running: true }] }, { ramGB: 32 })
        const unmeasured = rankNodes('llm', facts([left, right]))
        expect(unmeasured.ranked[0].nodeId).toBe('links')
        const measured = rankNodes('llm', facts([left, right], [
            { nodeId: 'links', capability: 'llm', samples: 10, successes: 2 },
            { nodeId: 'rechts', capability: 'llm', samples: 10, successes: 10 },
        ]))
        expect(measured.ranked[0].nodeId).toBe('rechts')
        expect(measured.ranked[0].reasons.join(' ')).toMatch(/10 von 10 validierten Owner-Läufen/)
        // Zu wenige Läufe zählen nicht.
        const few = rankNodes('llm', facts([left, right], [{ nodeId: 'links', capability: 'llm', samples: 2, successes: 0 }]))
        expect(few.ranked[0].nodeId).toBe('links')
    })

    it("rankNodes('main') ordnet nach Eignung (RAM, lokales Modell, Platte, Laufzeit) — Schnittstelle für Paket K", () => {
        const ranking = rankNodes('main', facts([C, A, B]))
        expect(ranking.fuer).toBe('main')
        expect(ranking.ranked.map(item => item.nodeId)).toEqual(['knoten-b', 'knoten-a', 'knoten-c'])
        expect(ranking.ranked[0].reasons.join(' ')).toMatch(/lokales Modell läuft/)
        expect(ranking.ranked[2].reasons.join(' ')).toMatch(/Datenspeicher/)
        for (const entry of ranking.ranked) expect(entry.reasons.length).toBeGreaterThan(0)
    })

    it('nurHardware: Eignung ohne laufenden Dienst (wohin installieren)', () => {
        expect(rankNodes('stt', facts([A, B])).ranked).toEqual([])
        const ranking = rankNodes('stt', facts([A, C]), { nurHardware: true })
        expect(ranking.ranked[0].nodeId).toBe('knoten-a')
    })

    it('kennt jede Fähigkeit und erfindet keine', () => {
        for (const capability of STRENGTH_CAPABILITIES) expect(() => rankNodes(capability, facts([A, B, C]))).not.toThrow()
        expect(() => rankNodes('zaubern' as any, facts([A]))).toThrow(/unbekannt/i)
    })
})

describe('measurementsFromOwnerRuns — nur validierte Owner-Läufe', () => {
    const base = {
        status: 'completed', userId: 'owner', channel: 'telegram', runId: 'r1', contract: { id: 'r1' },
        validation: { validator: 'nova-execution-kernel', success: true, awaitingApproval: false }, events: [] as any[],
    }
    const meshRoute = (capability: string, nodeId: string) => ({ type: 'route.selected', payload: { meshCapability: capability, meshNode: nodeId } })

    it('zählt Delegationen und Modell-Platzierungen je Knoten, verwirft Benchmark/Autonomie/ungeprüft', () => {
        const runs = [
            { ...base, runId: 'r1', contract: { id: 'r1' }, events: [meshRoute('bilder', 'knoten-a')] },
            { ...base, runId: 'r2', contract: { id: 'r2' }, status: 'failed', validation: { ...base.validation, success: false }, events: [meshRoute('bilder', 'knoten-a')] },
            { ...base, runId: 'r3', contract: { id: 'r3' }, node: 'knoten-b', events: [{ type: 'route.selected', payload: { modelClass: 'code' } }] },
            { ...base, runId: 'r4', contract: { id: 'r4' }, node: 'knoten-b', events: [{ type: 'route.selected', payload: { modelClass: 'vision' } }] },
            { ...base, runId: 'r5', contract: { id: 'r5' }, channel: 'benchmark', events: [meshRoute('bilder', 'knoten-a')] },
            { ...base, runId: 'r6', contract: { id: 'r6' }, userId: 'Nova-Autonomy', events: [meshRoute('bilder', 'knoten-a')] },
            { ...base, runId: 'r7', contract: { id: 'r7' }, validation: undefined, events: [meshRoute('bilder', 'knoten-a')] },
        ]
        const measurements = measurementsFromOwnerRuns(runs as any)
        expect(measurements).toEqual([
            { nodeId: 'knoten-a', capability: 'bilder', samples: 2, successes: 1 },
            { nodeId: 'knoten-b', capability: 'llm', samples: 1, successes: 1 },
            { nodeId: 'knoten-b', capability: 'vision', samples: 1, successes: 1 },
        ])
    })
})

describe('describeStrengthChanges — neue Hardware/Software erkennen', () => {
    it('meldet neue GPU, mehr RAM, neuen Dienst, neues Werkzeug und Plattengröße', () => {
        const before = { ramGB: 32, gpu: { name: null, backend: 'cpu', viaVllm: false }, services: [], tools: ['git'], disk: { totalGB: 500, freeGB: 100 } }
        const after = { ramGB: 64, gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: false }, services: [{ name: 'comfyui', type: 'image', status: 'running' }], tools: ['git', 'ffmpeg'], disk: { totalGB: 4000, freeGB: 3000 } }
        const changes = describeStrengthChanges(before as any, after as any)
        expect(changes).toEqual(expect.arrayContaining([
            expect.stringMatching(/GPU.*RTX 4090/), expect.stringMatching(/RAM 32 → 64 GB/),
            expect.stringMatching(/Dienst.*comfyui/), expect.stringMatching(/Werkzeug.*ffmpeg/), expect.stringMatching(/Platte 500 → 4000 GB/),
        ]))
        expect(describeStrengthChanges(after as any, after as any)).toEqual([])
        expect(describeStrengthChanges(undefined, after as any)).toEqual([])
    })
})
