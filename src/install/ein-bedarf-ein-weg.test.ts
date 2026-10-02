/**
 * 2.86 Punkt 2 (Alfred 02.10.: „einbauen“): ein Bedarf, ein Empfänger.
 *
 * Ein gescheitertes `analyze_image` ohne Vision im Mesh speiste bis 2.85 vier Wege
 * (Software-Scout, Werkzeug-Schmiede, Bug-Finder, Ideen-Lauf). Jetzt ordnet
 * `classifyNeed` (software-demand.ts) genau einmal ein; die anderen Wege fragen diese
 * Stelle, statt selbst zu reagieren.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeProfile } from '../core/node-profile.js'
import type { OutcomeRunView } from '../core/outcome-ledger.js'
import { FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { runBugFinder, type ErrorOccurrence } from '../thinking/bug-finder.js'
import { MemoryThoughtSink, parseThinkingSettings } from '../thinking/ports.js'
import {
    classifyNeed, demandFromRuns, readScoutMissingCapabilities, registerServiceNeedRule, summarizeDemand,
} from './software-demand.js'
import { runSoftwareScoutTick, type ScoutNode, type SoftwareScoutThought } from './software-scout.js'

const NOW = Date.parse('2026-10-02T10:00:00.000Z')
const DAY = 24 * 60 * 60_000

function profile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'n', hostname: 'h', platform: 'linux', arch: 'x64', version: '2.84.0', role: 'worker', runtime: 'container',
        rootReadOnly: true, noNewPrivileges: true, cpus: 4, ramGB: 16, gpu: { name: null, backend: 'cpu', viaVllm: false }, services: [],
        installPath: 'image', tools: ['node', 'npm'],
        selfCheck: { status: 'ok', checkedAt: '2026-10-02T09:59:00.000Z', items: [
            { id: 'disk-root', label: 'Systemplatte', status: 'ok', detail: '40 % belegt, 500 GB frei' },
            { id: 'memory', label: 'Arbeitsspeicher', status: 'ok', detail: '50 % frei' },
        ] },
        collectedAt: '2026-10-02T09:59:00.000Z', ...over,
    }
}
// Kein Knoten mit Vision; STT/Embedding/Browser/Medien/Desktop/LLM laufen.
const main: ScoutNode = { nodeId: 'main', local: true, profile: profile({ nodeId: 'main', role: 'main', runtime: 'native', installPath: 'host-agent', ramGB: 64,
    tools: ['apt', 'ffmpeg', 'playwright_browsers', 'edge_tts', 'display'],
    services: [{ name: 'vllm', type: 'llm', status: 'running' }, { name: 'ollama', type: 'llm', status: 'running' }, { name: 'faster-whisper', type: 'stt', status: 'running' }, { name: 'emb', type: 'embeddings', status: 'running' }] }) }

function ownerRun(id: string): OutcomeRunView {
    return {
        runId: id, status: 'failed', startedAt: new Date(NOW - DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(),
        contract: { id } as any, channel: 'telegram', userId: '1000000001',
        tools: [{ toolName: 'analyze_image', success: false, result: 'Kein Provider für image verfügbar' }], tests: [], changes: [], approvals: [], costs: [], feedback: [], events: [],
        totalCostUsd: 0, totalTokens: 0, eventCount: 3,
        validation: { validator: 'nova-execution-kernel', validatedAt: '', success: false, awaitingApproval: false, criteria: [], violations: [] },
    }
}
const settings = parseThinkingSettings({ enabled: true, bugFinder: { enabled: true, minOccurrences: 3 } })
const coordinator = () => new FailureResearchCoordinator(join(mkdtempSync(join(process.cwd(), 'bedarf-weg-')), 'failure-research.json'))
/** Ein Scout-Lauf über das Mesh ohne Vision (hält „fehlt im Mesh“ fest). */
const scoutRun = (demand: Map<any, any>, emitted: SoftwareScoutThought[] = []) => runSoftwareScoutTick({ isMain: true, settings: { enabled: true }, now: NOW, nodes: () => [main],
    sink: { emit: thought => { emitted.push(thought) } }, demand: () => demand, freshness: { search: null }, catalogCare: { delegate: null } })
const occ = (subject: string, message: string, i: number): ErrorOccurrence => ({ source: 'trace', subject, message, at: NOW - i * 60_000, ref: `traces/2026-10-02.jsonl:${i + 1}` })

describe('classifyNeed: eine Einordnung, genau ein Empfänger', () => {
    it('Fehlertext belegt die fehlende Fähigkeit → faehigkeit:vision an den Software-Scout', () => {
        const need = classifyNeed('analyze_image', 'Kein Provider für image verfügbar. Setze API Keys: OPENAI_API_KEY')
        expect(need).toMatchObject({ kind: 'faehigkeit', key: 'faehigkeit:vision', capability: 'vision', recipient: 'software-scout' })
        expect(classifyNeed('transcribe_audio', 'whisper-cli/whisper nicht gefunden')).toMatchObject({ key: 'faehigkeit:stt' })
        expect(classifyNeed('ocr_image', 'kein Vision-Modell auf diesem Knoten')).toMatchObject({ key: 'faehigkeit:vision' })
    })

    it('nur der Werkzeugname: Fähigkeit fehlt nur, wenn der Scout sie als fehlend führt — sonst Code-Fehler (Bug-Finder)', () => {
        expect(classifyNeed('analyze_image', 'Image not found: /tmp/example.png')).toMatchObject({ kind: 'code', key: 'code:analyze_image', recipient: 'bug-finder' })
        expect(classifyNeed('analyze_image', 'Image not found: /tmp/example.png', { missingCapabilities: new Set(['vision'] as const) }))
            .toMatchObject({ kind: 'faehigkeit', key: 'faehigkeit:vision', recipient: 'software-scout' })
    })

    it('fehlendes Werkzeug ohne fehlende Fähigkeit → Schmiede; mit fehlender Fähigkeit → Software-Scout', () => {
        expect(classifyNeed('rechne_zinsen', 'Tool nicht gefunden: rechne_zinsen')).toMatchObject({ kind: 'werkzeug', key: 'werkzeug:rechne_zinsen', recipient: 'schmiede' })
        expect(classifyNeed('ocr_image', 'Tool nicht gefunden: ocr_image')).toMatchObject({ kind: 'werkzeug', recipient: 'schmiede' })
        expect(classifyNeed('ocr_image', 'Tool nicht gefunden: ocr_image', { missingCapabilities: new Set(['vision'] as const) }))
            .toMatchObject({ kind: 'faehigkeit', key: 'faehigkeit:vision', recipient: 'software-scout' })
    })

    it('Gegenprobe: web_search mit HTTP 500 bleibt ein Code-Fehler', () => {
        expect(classifyNeed('web_search', 'HTTP 500 Internal Server Error', { missingCapabilities: new Set(['vision', 'stt'] as const) }))
            .toMatchObject({ kind: 'code', key: 'code:web_search', recipient: 'bug-finder' })
    })

    it('Andockstelle für Verbindungen (2.85 A): eine registrierte Dienst-Regel macht dienst:<name>, Vorrang vor Code', () => {
        const off = registerServiceNeedRule((tool, text) => tool === 'ha_call_service' && /nicht verbunden/.test(text) ? 'home-assistant' : null)
        try {
            expect(classifyNeed('ha_call_service', 'Home Assistant nicht verbunden')).toMatchObject({ kind: 'dienst', key: 'dienst:home-assistant', recipient: 'verbindungen', service: 'home-assistant' })
            expect(classifyNeed('ha_call_service', 'HTTP 500')).toMatchObject({ kind: 'code' })
        } finally { off() }
        expect(classifyNeed('ha_call_service', 'Home Assistant nicht verbunden')).toMatchObject({ kind: 'code' })
    })
})

describe('Ein Bedarf, ein Weg (Mesh ohne Vision)', () => {
    it('3 Owner-Läufe mit gescheitertem analyze_image → genau ein Scout-Bedarf; der Bug-Finder legt keinen Fall an', async () => {
        const runs = [ownerRun('a'), ownerRun('b'), ownerRun('c')]
        const demand = summarizeDemand(demandFromRuns(runs, NOW), NOW)
        expect([...demand.keys()]).toEqual(['vision'])
        expect(demand.get('vision')!.count).toBe(3)

        const emitted: SoftwareScoutThought[] = []
        const scout = await scoutRun(demand, emitted)
        expect(scout.ran).toBe(true)
        // genau ein Weg für den Bedarf: die eine Vision-Frage des Scouts
        expect(emitted.filter(item => item.capability === 'vision').map(item => item.permission)).toEqual(['fragen'])
        // Der Scout hält fest, was im Mesh fehlt — die eine Quelle für die Einordnung.
        expect([...readScoutMissingCapabilities({ now: NOW })]).toContain('vision')
        expect([...readScoutMissingCapabilities({ now: NOW })]).not.toContain('stt')

        const doctor = coordinator()
        const result = await runBugFinder({ settings, doctor, sink: new MemoryThoughtSink(), now: new Date(NOW),
            source: { collect: () => [0, 1, 2].map(i => occ('analyze_image', 'Image konnte nicht analysiert werden', i)) } })
        expect(result.created).toEqual([])
        expect(doctor.list()).toHaveLength(0)
        expect(result.skipped.map(item => item.reason).join(' ')).toMatch(/Fähigkeit fehlt \(vision\).*Software-Scout/)
    })

    it('„Tool nicht gefunden: ocr_image“ → kein Schmiede-Bau, Grund „Fähigkeit fehlt“, Tageslimit unverändert; der Bedarf zählt beim Scout', async () => {
        await scoutRun(new Map())
        const { noteForgeNeed, forgeBuildsLeftToday, forgeMissingToolNeeds } = await import('../tools/skill-builder.js')
        const before = forgeBuildsLeftToday(NOW)
        const result = noteForgeNeed({
            principalId: '1000000001', permission: 'owner', request: 'Lies den Text auf dem Foto',
            toolExecutions: [{ toolName: 'ocr_image', success: false, result: 'Tool nicht gefunden: ocr_image' }],
        }, { allowInTests: true, now: () => NOW })
        expect(result.queued).toBe(false)
        expect(result.reason).toMatch(/Fähigkeit fehlt \(vision\).*Software-Scout/)
        expect(forgeBuildsLeftToday(NOW)).toBe(before)
        expect(forgeMissingToolNeeds()).toContainEqual({ tool: 'ocr_image', at: new Date(NOW).toISOString() })
    })

    it('Gegenprobe: gescheitertes web_search mit HTTP 500 → Bug-Finder-Fall wie bisher', async () => {
        const doctor = coordinator()
        const result = await runBugFinder({ settings, doctor, sink: new MemoryThoughtSink(), now: new Date(NOW),
            source: { collect: () => [0, 1, 2].map(i => occ('web_search', 'HTTP 500 Internal Server Error', i)) } })
        expect(result.created).toHaveLength(1)
        expect(doctor.list()[0].title).toMatch(/web_search/)
    })
})
