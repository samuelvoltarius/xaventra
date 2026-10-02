/**
 * 2.86 Punkt 8 (Alfred 02.10.: „einbauen“): ein Modell-Fund endet nicht mehr bei
 * „bitte in die Config eintragen“ / „Katalogeintrag nötig“ als Arbeit für den Owner.
 *
 * Nachfolger aus der Aktualitätsprüfung (software-freshness) und Funde des Modell-Scouts
 * (nicht installierte Hugging-Face-Kandidaten, gemessene Sieger ohne Wechselziel) werden
 * gesammelt (je Modell einmal) und als EIN Katalogpflege-Auftrag pro Woche über die
 * vorhandene Delegation an Claude gegeben: Quellen im Kontext, `erwartet.art = release-tag`,
 * `aendert: true` (Karte nur, wie die Delegation sie für L2 ohnehin verlangt).
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import type { DelegationRequest } from '../core/delegation.js'
import { runModelScout, type ScoutRunner } from '../thinking/model-scout.js'
import { MemoryThoughtSink, parseThinkingSettings, type LoadSample } from '../thinking/ports.js'
import { loadSoftwareCandidates } from './software-candidates.js'
import type { CapabilityDemand } from './software-demand.js'
import { CATALOG_CARE_INTERVAL_MS, flushCatalogCare, noteCatalogFindings, readCatalogCare, type WebSearchPort } from './software-freshness.js'
import { runSoftwareScoutTick, type ScoutNode, type SoftwareScoutThought } from './software-scout.js'

const NOW = Date.parse('2026-10-02T10:00:00.000Z')
const DAY = 24 * 60 * 60_000
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), 'katalogpflege-')), name)

function profile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'n', hostname: 'h', platform: 'linux', arch: 'x64', version: '2.84.0', role: 'worker', runtime: 'container',
        rootReadOnly: true, noNewPrivileges: true, cpus: 4, ramGB: 32, gpu: { name: null, backend: 'cpu', viaVllm: false }, services: [],
        installPath: 'image', tools: ['node'],
        selfCheck: { status: 'ok', checkedAt: '', items: [
            { id: 'disk-root', label: 'Systemplatte', status: 'ok', detail: '40 % belegt, 500 GB frei' },
            { id: 'memory', label: 'Arbeitsspeicher', status: 'ok', detail: '50 % frei' },
        ] },
        collectedAt: '', ...over,
    }
}
const main: ScoutNode = { nodeId: 'main', local: true, profile: profile({ nodeId: 'main', role: 'main', runtime: 'native', installPath: 'host-agent',
    tools: ['ffmpeg', 'playwright_browsers', 'edge_tts', 'display'],
    services: [{ name: 'ollama', type: 'llm', status: 'running' }, { name: 'faster-whisper', type: 'stt', status: 'running' }, { name: 'emb', type: 'embeddings', status: 'running' }] }) }
const visionNeed = new Map([['vision', { capability: 'vision', count: 2, evidence: ['2× analyze_image gescheitert (Owner-Läufe, 14 Tage)'] }]]) as unknown as Map<any, CapabilityDemand>

/** Ein altes Vision-Modell im Katalog; die Websuche findet einen neueren Nachfolger. */
const oldCatalog = () => loadSoftwareCandidates([{
    id: 'vision-qwen2.5vl-3b', title: 'Qwen2.5-VL 3B (Ollama)', capability: 'vision', kind: 'model', platforms: ['linux'], arches: ['x64', 'arm64'],
    minRamGB: 8, minDiskGB: 4, gpu: 'none', requiresService: 'ollama', modelRef: 'qwen2.5vl:3b', releasedAt: '2025-01',
    benefit: 'Kleines Bildmodell.',
}])
const successorSearch: WebSearchPort = { search: async () => ({ tool: 'browser_search', hits: [{ url: 'https://ollama.com/library/qwen3-vl', title: 'qwen3-vl', snippet: 'Released October 2025 · 2b 4b 8b' }] }) }

type DelegateResult = { ok: true; record: { id: string } } | { ok: false; reason: string }
const delegatePort = (result: DelegateResult = { ok: true, record: { id: 'dlg-aaaaaaaaaaaa' } }) => vi.fn(async (_request: DelegationRequest) => result)

function scoutTick(options: { carePath: string; delegate: ReturnType<typeof delegatePort>; now?: number; statePath?: string }) {
    const emitted: SoftwareScoutThought[] = []
    return runSoftwareScoutTick({
        isMain: true, now: options.now ?? NOW, settings: { enabled: true }, sink: { emit: thought => { emitted.push(thought) } },
        statePath: options.statePath || tmp('state.json'), candidates: oldCatalog(), demand: () => visionNeed,
        freshness: { search: successorSearch, cachePath: tmp('aktualitaet.json') }, nodes: () => [main],
        catalogCare: { path: options.carePath, delegate: options.delegate, version: '2.84.0' },
    }).then(result => ({ ...result, emitted }))
}

describe('Modell-Fund → gesammelter Katalogpflege-Auftrag an Claude', () => {
    it('Nachfolger aus der Aktualitätsprüfung → genau ein delegate-Aufruf (release-tag, ändert), Quelle im Kontext; zweiter Lauf derselben Woche → keiner', async () => {
        const carePath = tmp('katalogpflege.json')
        const delegate = delegatePort()
        const first = await scoutTick({ carePath, delegate })
        expect(delegate).toHaveBeenCalledTimes(1)
        const request = delegate.mock.calls[0][0]
        expect(request.to).toBe('claude')
        expect(request.erwartet).toEqual({ art: 'release-tag', tag: 'v2.85.0' })
        expect(request.aendert).toBe(true)
        expect(request.auftrag).toMatch(/Katalogpflege/)
        expect(String(request.kontext)).toMatch(/qwen3-vl/)
        expect(String(request.kontext)).toMatch(/https:\/\/ollama\.com\/library\/qwen3-vl/)
        // Die Idee nennt keine Owner-Arbeit mehr, sondern die Übergabe.
        const idea = first.emitted.find(item => item.capability === 'vision')!
        expect(idea.permission).toBe('selbst')
        expect(`${idea.title} ${idea.text}`).not.toMatch(/Katalogeintrag nötig/)
        expect(idea.text).toMatch(/an Claude zur Katalogpflege übergeben \(dlg-aaaaaaaaaaaa\)/)

        // Derselbe Nachfolger am nächsten Tag (anderer Scout-Zustand, Lauf fällig) → kein zweiter Auftrag.
        noteCatalogFindings([{ model: 'org/anderes-8b', source: 'modell-scout', reason: 'passt, nicht installiert', at: NOW + DAY }], { path: carePath, now: NOW + DAY })
        await scoutTick({ carePath, delegate, now: NOW + DAY })
        expect(delegate).toHaveBeenCalledTimes(1)
        expect(readCatalogCare({ path: carePath }).pending.map(item => item.model)).toEqual(['org/anderes-8b'])
        // Nach einer Woche geht der gesammelte Rest als ein Auftrag.
        await flushCatalogCare({ path: carePath, delegate, version: '2.84.0', now: NOW + CATALOG_CARE_INTERVAL_MS + DAY })
        expect(delegate).toHaveBeenCalledTimes(2)
        expect(String(delegate.mock.calls[1][0].kontext)).toMatch(/org\/anderes-8b/)
        expect(String(delegate.mock.calls[1][0].kontext)).not.toMatch(/qwen3-vl/)
    })

    it('Scout misst Modell B besser, kein Wechselziel → derselbe Sammelauftrag enthält B (mit dem Nachfolger)', async () => {
        const carePath = tmp('katalogpflege.json')
        const settings = parseThinkingSettings({ enabled: true, scout: { enabled: true, memoryBudgetGB: 96, minImprovementPercent: 5 } })
        const IDLE: LoadSample = { measured: true, gpuUtilPercent: 2, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }
        const runner: ScoutRunner = {
            evaluate: async model => ({ model, passed: model === 'model-b' ? 4 : 2, total: 4, avgLatencyMs: 100 }),
            inventory: async () => ({ installed: ['model-b'], targets: [] }),
        }
        const sink = new MemoryThoughtSink()
        await runModelScout({ settings, load: { sample: async () => IDLE }, sink, runner, currentModel: 'org/model-a', sources: [],
            probes: [{ id: 'p1', origin: 'alltag', prompt: 'Hauptstadt von Österreich?', expect: { kind: 'contains-any', values: ['Wien'] } }],
            reportPath: tmp('scout-report.json'), now: new Date(NOW), catalogCare: { note: findings => noteCatalogFindings(findings, { path: carePath, now: NOW }) } })
        const idea = sink.thoughts.find(item => item.kind === 'modell-scout:idee')!
        expect(idea.text).not.toMatch(/routing\.vllm\.targets/)
        expect(idea.text).toMatch(/Katalogpflege/)

        const delegate = delegatePort()
        await scoutTick({ carePath, delegate })
        expect(delegate).toHaveBeenCalledTimes(1)
        const kontext = String(delegate.mock.calls[0][0].kontext)
        expect(kontext).toMatch(/model-b/)
        expect(kontext).toMatch(/qwen3-vl/)
        expect(JSON.parse(readFileSync(carePath, 'utf8')).pending).toEqual([])
    })

    it('Gegenprobe: ohne Delegation (keine URL) bleibt der Fund gesammelt; die Idee sagt „wartet auf Katalogpflege“, nennt keinen Config-Schlüssel', async () => {
        const carePath = tmp('katalogpflege.json')
        const delegate = delegatePort({ ok: false, reason: 'Keine Agentic-OS-URL' })
        const result = await scoutTick({ carePath, delegate })
        expect(delegate).toHaveBeenCalledTimes(1)
        const idea = result.emitted.find(item => item.capability === 'vision')!
        expect(idea.text).toMatch(/wartet auf Katalogpflege/)
        expect(idea.text).not.toMatch(/routing\.|Katalogeintrag nötig/)
        expect(readCatalogCare({ path: carePath }).pending.map(item => item.model)).toEqual(['qwen3-vl'])
        // kein Versuch pro Tick: frühestens nach einem Tag wieder
        await flushCatalogCare({ path: carePath, delegate, version: '2.84.0', now: NOW + 60_000 })
        expect(delegate).toHaveBeenCalledTimes(1)
    })
})
