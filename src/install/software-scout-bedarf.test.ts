import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import type { OutcomeRunView } from '../core/outcome-ledger.js'
import {
    DEMAND_WINDOW_MS, capabilityForTool, demandFromForgeNeeds, demandFromRuns, readCapabilityNeedSignals, recordCapabilityNeed, summarizeDemand,
} from './software-demand.js'
import { analyzeMesh, assessCandidate, gapThoughts, runSoftwareScoutTick, type ScoutNode } from './software-scout.js'

// 2.85 (Alfred 02.10.): "nicht nur ‚viel RAM da, drück ich was rein‘" — a gap is only a
// question when there is a recorded need; otherwise at most a quiet idea per week.

const NOW = Date.parse('2026-10-02T10:00:00.000Z')
const DAY = 24 * 60 * 60_000
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), 'softscout-bedarf-')), name)

function profile(over: Partial<NodeProfile> & { memFree?: number; diskFree?: number } = {}): NodeProfile {
    const { memFree = 50, diskFree = 500, ...rest } = over
    return {
        schema: 1, nodeId: 'n', hostname: 'h', platform: 'linux', arch: 'x64', version: '2.84.0', role: 'worker', runtime: 'container',
        rootReadOnly: true, noNewPrivileges: true, cpus: 4, ramGB: 16, gpu: { name: null, backend: 'cpu', viaVllm: false }, services: [],
        installPath: 'image', tools: ['node', 'npm'],
        selfCheck: { status: 'ok', checkedAt: '2026-10-02T09:59:00.000Z', items: [
            { id: 'disk-root', label: 'Systemplatte', status: 'ok', detail: `40 % belegt, ${diskFree} GB frei` },
            { id: 'memory', label: 'Arbeitsspeicher', status: 'ok', detail: `${memFree} % frei` },
        ] },
        collectedAt: '2026-10-02T09:59:00.000Z', ...rest,
    }
}
// The morning-report situation: vision missing, ns1 has Ollama and 107 GB free disk.
const spark: ScoutNode = { nodeId: 'xaventra-spark', local: true, profile: profile({ nodeId: 'xaventra-spark', arch: 'arm64', role: 'main', runtime: 'native', ramGB: 120,
    memFree: 35, diskFree: 800, gpu: { name: 'NVIDIA GB10', backend: 'cpu', viaVllm: true }, installPath: 'host-agent', tools: ['apt', 'ffmpeg', 'playwright_browsers', 'edge_tts', 'display'],
    services: [{ name: 'vllm', type: 'llm', status: 'running' }, { name: 'faster-whisper', type: 'stt', status: 'running' }, { name: 'emb', type: 'embeddings', status: 'running' }] }) }
const ns1: ScoutNode = { nodeId: 'xaventra-ns1', local: false, lastSeen: NOW - 30_000,
    profile: profile({ nodeId: 'xaventra-ns1', ramGB: 32, diskFree: 107, services: [{ name: 'ollama', type: 'llm', status: 'running' }] }) }
const mesh = () => [spark, { ...ns1, lastSeen: NOW - 30_000 }]

function ownerRun(over: Partial<OutcomeRunView> = {}): OutcomeRunView {
    const runId = over.runId || `run-${Math.random().toString(36).slice(2, 10)}`
    return {
        runId, status: 'failed', startedAt: new Date(NOW - DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(),
        contract: { id: runId } as any, channel: 'telegram', userId: '1000000001',
        tools: [], tests: [], changes: [], approvals: [], costs: [], feedback: [], events: [], totalCostUsd: 0, totalTokens: 0, eventCount: 3,
        validation: { validator: 'nova-execution-kernel', validatedAt: '', success: false, awaitingApproval: false, criteria: [], violations: [] },
        ...over,
    }
}
const failedImage = (over: Partial<OutcomeRunView> = {}) => {
    const run = ownerRun({ tools: [{ toolName: 'analyze_image', success: false, result: 'kein Vision-Modell' }, { toolName: 'analyze_image', success: false }], ...over })
    return { ...run, contract: { id: run.runId } as any }
}

describe('Bedarf: nur belegte Signale, feste Regeln', () => {
    it('maps capability tools deterministically; unknown tools are no need', () => {
        expect(capabilityForTool('analyze_image')).toBe('vision')
        expect(capabilityForTool('transcribe_audio')).toBe('stt')
        expect(capabilityForTool('speak')).toBe('tts')
        expect(capabilityForTool('browser_screenshot')).toBe('browser')
        expect(capabilityForTool('desktop_control')).toBe('desktop')
        expect(capabilityForTool('read_file')).toBeNull()
        // a forge "Tool nicht gefunden" name is matched by fixed patterns
        expect(capabilityForTool('ocr_bild_lesen')).toBe('vision')
        expect(capabilityForTool('sprache_transkribieren')).toBe('stt')
    })

    it('counts only validated owner runs of the last 14 days that failed at the capability (one per run)', () => {
        const signals = demandFromRuns([
            failedImage({ runId: 'a' }),
            failedImage({ runId: 'b', updatedAt: new Date(NOW - 3 * DAY).toISOString() }),
            failedImage({ runId: 'alt', updatedAt: new Date(NOW - DEMAND_WINDOW_MS - DAY).toISOString() }),
            failedImage({ runId: 'auto', userId: 'Nova-Autonomy' }),
            failedImage({ runId: 'bench', channel: 'benchmark' }),
            ownerRun({ runId: 'ok', contract: { id: 'ok' } as any, tools: [{ toolName: 'analyze_image', success: true }] }),
            ownerRun({ runId: 'other', contract: { id: 'other' } as any, tools: [{ toolName: 'read_file', success: false }] }),
        ], NOW)
        expect(signals.map(item => item.capability)).toEqual(['vision', 'vision'])
        const summary = summarizeDemand(signals, NOW).get('vision')!
        expect(summary.count).toBe(2)
        expect(summary.evidence.join(' ')).toMatch(/2× analyze_image gescheitert \(Owner-Läufe, 14 Tage\)/)
    })

    it('a forge need "fehlendes Werkzeug" and a channel signal count; old ones do not', () => {
        const forge = demandFromForgeNeeds([
            { tool: 'sprache_transkribieren', at: new Date(NOW - DAY).toISOString() },
            { tool: 'ocr_bild_lesen', at: new Date(NOW - 20 * DAY).toISOString() },
            { tool: 'rechne_zinsen', at: new Date(NOW - DAY).toISOString() },
        ], NOW)
        expect(forge.map(item => item.capability)).toEqual(['stt'])
        const path = tmp('signale.json')
        recordCapabilityNeed('stt', 'sprachnachricht-ohne-stt', { path, now: NOW - DAY })
        recordCapabilityNeed('stt', 'sprachnachricht-ohne-stt', { path, now: NOW - 2 * DAY })
        recordCapabilityNeed('stt', 'sprachnachricht-ohne-stt', { path, now: NOW - 30 * DAY })
        const channel = readCapabilityNeedSignals({ path, now: NOW })
        expect(channel).toHaveLength(2)
        const summary = summarizeDemand([...forge, ...channel], NOW).get('stt')!
        expect(summary.count).toBe(3)
        expect(summary.evidence.join(' ')).toMatch(/2× Sprachnachricht ohne Spracherkennung/)
        expect(summary.evidence.join(' ')).toMatch(/Schmiede-Bedarf: fehlt sprache_transkribieren/)
    })
})

describe('Schmiede-Bedarf liefert den Werkzeugnamen', () => {
    it('a forge "fehlendes Werkzeug" need keeps the missing tool name (no request text) for the scout', async () => {
        const { noteForgeNeed, forgeMissingToolNeeds } = await import('../tools/skill-builder.js')
        const result = noteForgeNeed({
            principalId: '1000000001', permission: 'owner', request: 'Lies den Text auf dem Foto',
            toolExecutions: [{ toolName: 'ocr_bild_lesen', success: false, result: 'Tool nicht gefunden: ocr_bild_lesen' }],
        }, { allowInTests: true, now: () => NOW })
        expect(result.kind).toBe('fehlendes-werkzeug')
        const needs = forgeMissingToolNeeds()
        expect(needs).toContainEqual({ tool: 'ocr_bild_lesen', at: new Date(NOW).toISOString() })
        expect(JSON.stringify(needs)).not.toMatch(/Foto/)
        expect(demandFromForgeNeeds(needs, NOW).map(item => item.capability)).toContain('vision')
    })
})

describe('Lücke ohne Bedarf = keine Karte', () => {
    it('the morning report case: vision fits on ns1, but nobody needed it → quiet idea, no question', () => {
        const analysis = analyzeMesh(mesh(), { now: NOW })
        const thoughts = gapThoughts(analysis, 99, { demand: new Map() })
        expect(thoughts.filter(item => item.permission === 'fragen')).toEqual([])
        const vision = thoughts.find(item => item.capability === 'vision')!
        expect(vision.permission).toBe('selbst')
        expect(vision.kind).toBe('software-scout:idee')
        expect(vision.title).toMatch(/bisher kein Bedarf gesehen/)
        expect(vision.title).not.toMatch(/einrichten\?/i)
        expect(vision.dedupeKey).toBe('software-scout:idee:vision')
    })

    it('with a recorded need it becomes a question, and the need is the evidence', () => {
        const analysis = analyzeMesh(mesh(), { now: NOW })
        const demand = summarizeDemand(demandFromRuns([failedImage({ runId: 'a' }), failedImage({ runId: 'b' })], NOW), NOW)
        const [vision] = gapThoughts(analysis, 99, { demand }).filter(item => item.permission === 'fragen')
        expect(vision.capability).toBe('vision')
        expect(vision.nodeId).toBe('xaventra-ns1')
        expect(vision.evidence[0]).toMatch(/^Bedarf: 2× analyze_image gescheitert/)
    })

    it('never proposes installing Ollama just so a model fits (reason reads as a fact, not a plan)', () => {
        const visionCandidate = analyzeMesh(mesh(), { now: NOW }).capabilities.find(item => item.capability === 'vision')!.fits[0].candidate
        const noOllama: ScoutNode = { ...ns1, profile: { ...ns1.profile, services: [] } }
        const fit = assessCandidate(visionCandidate, noOllama)
        expect(fit.status).toBe('passt-nicht')
        expect(fit.reasons[0]).not.toMatch(/braucht Ollama/)
        expect(fit.reasons[0]).toMatch(/kein Ollama.*wird dafür nicht installiert/)
    })

    it('tick without need: only quiet ideas, at most one per capability per week', async () => {
        const statePath = tmp('state.json')
        const emit = vi.fn()
        const cachePath = tmp('aktualitaet.json')
        const run = (now: number, nodes = mesh) => runSoftwareScoutTick({ isMain: true, now, settings: { enabled: true }, sink: { emit }, statePath,
            demand: () => new Map(), freshness: { search: null, cachePath }, nodes: () => nodes().map(node => node.local ? node : { ...node, lastSeen: now - 30_000 }) })
        const first = await run(NOW)
        expect(first.ran).toBe(true)
        expect(first.emitted.length).toBeGreaterThan(0)
        expect(first.emitted.every(item => item.permission === 'selbst')).toBe(true)
        const ideas = first.emitted.map(item => item.dedupeKey)
        // profile change within the week: runs again, but no second idea for the same capability
        const changed = () => [spark, { ...ns1, profile: { ...ns1.profile, ramGB: 64 } }]
        const second = await run(NOW + 2 * 60 * 60_000, changed)
        expect(second.ran).toBe(true)
        expect(second.emitted.map(item => item.dedupeKey).filter(key => ideas.includes(key))).toEqual([])
    })
})
