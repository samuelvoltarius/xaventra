import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import { sanitizeNodeProfile } from '../core/node-profile.js'
import { BUILTIN_SOFTWARE_CANDIDATES, findSoftwareCandidate, getSoftwareCandidates, loadSoftwareCandidates, publishedSoftwareCandidates, type SoftwareCandidate } from './software-candidates.js'
import {
    analyzeMesh, assessCandidate, formatSoftwareOverview, freeDiskGB, freeMemoryGB, gapThoughts, parseSoftwareScoutSettings,
    PROPOSAL_DEDUPE_MS, recordSoftwareScoutAnswer, runSoftwareScoutTick, type ScoutNode,
} from './software-scout.js'
import type { CapabilityDemand } from './software-demand.js'

const NOW = Date.parse('2026-10-01T10:00:00.000Z')

function profile(over: Partial<NodeProfile> & { memFree?: number; diskFree?: number; memStatus?: 'ok' | 'warn' | 'crit' } = {}): NodeProfile {
    const { memFree = 50, diskFree = 500, memStatus = 'ok', ...rest } = over
    return {
        schema: 1, nodeId: 'n', hostname: 'h', platform: 'linux', arch: 'x64', version: '2.81.0', role: 'worker', runtime: 'container',
        rootReadOnly: true, noNewPrivileges: true, cpus: 4, ramGB: 16, gpu: { name: null, backend: 'cpu', viaVllm: false }, services: [],
        installPath: 'image', tools: ['node', 'npm'],
        selfCheck: { status: 'ok', checkedAt: '2026-10-01T09:59:00.000Z', items: [
            { id: 'disk-root', label: 'Systemplatte', status: 'ok', detail: `40 % belegt, ${diskFree} GB frei` },
            { id: 'memory', label: 'Arbeitsspeicher', status: memStatus, detail: `${memFree} % frei` },
        ] },
        collectedAt: '2026-10-01T09:59:00.000Z', ...rest,
    }
}

// Mesh shaped like the real one (Spark native with GB10 via vLLM, two container workers, NAS), no real addresses.
const spark = (over: Parameters<typeof profile>[0] = {}): ScoutNode => ({
    nodeId: 'xaventra-spark', local: true,
    profile: profile({ nodeId: 'xaventra-spark', arch: 'arm64', role: 'main', runtime: 'native', ramGB: 120, cpus: 20, memFree: 35, diskFree: 800,
        gpu: { name: 'NVIDIA GB10', backend: 'cpu', viaVllm: true }, installPath: 'host-agent', tools: ['apt', 'ffmpeg'],
        services: [{ name: 'vllm', type: 'llm', status: 'running' }], ...over }),
})
const ns1 = (over: Parameters<typeof profile>[0] = {}): ScoutNode => ({ nodeId: 'ns1', local: false, lastSeen: NOW - 30_000, profile: profile({ nodeId: 'ns1', ramGB: 16, ...over }) })
const ns2 = (over: Parameters<typeof profile>[0] = {}): ScoutNode => ({ nodeId: 'ns2', local: false, lastSeen: NOW - 30_000, profile: profile({ nodeId: 'ns2', ramGB: 4, ...over }) })
const nas = (over: Parameters<typeof profile>[0] = {}): ScoutNode => ({ nodeId: 'xaventra-nas', local: false, lastSeen: NOW - 30_000, modelOnly: true, profile: profile({ nodeId: 'xaventra-nas', ramGB: 8, ...over }) })
const mesh = () => [spark(), ns1(), ns2(), nas()]
const cand = (id: string) => findSoftwareCandidate(id)!
const tmpState = () => join(mkdtempSync(join(tmpdir(), 'softscout-')), 'state.json')
// 2.85: a card needs a recorded need — these tests are about fit and routing, so every capability has one.
const NEED: ReadonlyMap<any, CapabilityDemand> = new Map(['stt', 'tts', 'vision', 'embedding', 'browser', 'media', 'desktop', 'llm', 'search']
    .map(capability => [capability, { capability, count: 1, evidence: ['1× Testbedarf'] } as CapabilityDemand]))

describe('Software-Kandidaten-Katalog (Phase 5b)', () => {
    it('ships valid candidates, each with capability, needs, benefit; catalog ids only where Stufe 2 has an entry', () => {
        const catalog = getSoftwareCandidates()
        expect(catalog.rejected).toEqual([])
        expect(catalog.entries.length).toBe(BUILTIN_SOFTWARE_CANDIDATES.length)
        expect(new Set(catalog.entries.map(entry => entry.capability))).toEqual(new Set(['stt', 'tts', 'vision', 'embedding', 'browser', 'media', 'desktop', 'llm', 'search']))
        expect(cand('media-ffmpeg').catalogId).toBe('ffmpeg')
        expect(cand('stt-whisper-large-v3').catalogId).toBeUndefined()
        for (const entry of catalog.entries) expect(entry.benefit.length).toBeGreaterThan(10)
        expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('rejects a never-list candidate at load (id or package), and unknown catalog ids, never repairs them', () => {
        const base = structuredClone(BUILTIN_SOFTWARE_CANDIDATES.find(entry => entry.id === 'tts-piper')!) as SoftwareCandidate
        const loaded = loadSoftwareCandidates([
            base,
            { ...base, id: 'cuda-toolkit-12' },
            { ...base, id: 'gpu-treiber', packages: ['nvidia-driver-550'] },
            { ...base, id: 'fernzugang', packages: ['openssh-server'] },
            { ...base, id: 'erfunden', catalogId: 'curl-pipe-installer' },
            { ...base, id: 'mit-befehl', install: ['curl', 'https://example.invalid/x.sh'] },
        ])
        expect(loaded.entries.map(entry => entry.id)).toEqual(['tts-piper'])
        const reasons = Object.fromEntries(loaded.rejected.map(item => [item.id, item.reason]))
        expect(reasons['cuda-toolkit-12']).toMatch(/Nie-Liste/)
        expect(reasons['gpu-treiber']).toMatch(/Nie-Liste/)
        expect(reasons.fernzugang).toMatch(/Nie-Liste/)
        expect(reasons.erfunden).toMatch(/nicht im Installationskatalog/)
        expect(reasons['mit-befehl']).toMatch(/unbekanntes Feld install/)
    })

    it('matches the generated release catalog (part of the release, not from the network)', () => {
        const published = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/generated/software-candidates.json', import.meta.url)), 'utf8'))
        expect(published).toEqual(JSON.parse(JSON.stringify(publishedSoftwareCandidates())))
    })
})

describe('Eignungsprüfung je Knoten (rein)', () => {
    it('reads free memory and disk only from the measured self-check', () => {
        expect(freeMemoryGB(spark().profile)).toBe(42)
        expect(freeDiskGB(spark().profile)).toBe(800)
        expect(freeMemoryGB(profile({ selfCheck: { status: 'ok', checkedAt: '', items: [] } }))).toBeNull()
    })

    it('too little RAM → passt nicht, with the reason', () => {
        const fit = assessCandidate(cand('stt-whisper-large-v3'), ns2())
        expect(fit.status).toBe('passt-nicht')
        expect(fit.reasons[0]).toBe('zu wenig RAM (4 GB, nötig 8 GB)')
        // positive control: same node, small model fits
        expect(assessCandidate(cand('stt-faster-whisper-small'), ns2()).status).toBe('passt')
    })

    it('container → only an image proposal (catalog entry) or "Katalogeintrag nötig; nur über ein neues Image"', () => {
        const ffmpeg = assessCandidate(cand('media-ffmpeg'), ns1())
        expect(ffmpeg.status).toBe('passt')
        expect(ffmpeg.route).toBe('image')
        expect(ffmpeg.notes.join(' ')).toMatch(/nur über ein neues Image.*kein apt im laufenden Container/)
        const piper = assessCandidate(cand('tts-piper'), ns1())
        expect(piper.route).toBe('katalog-noetig')
        expect(piper.notes.join(' ')).toMatch(/nur über ein neues Image/)
        // host-agent only entry has no image variant: not proposed in a container
        expect(assessCandidate(cand('browser-playwright-chromium'), ns1()).status).toBe('passt-nicht')
    })

    it('read-only native node → only via the host agent', () => {
        const fit = assessCandidate(cand('browser-playwright-chromium'), spark())
        expect(fit.status).toBe('passt')
        expect(fit.route).toBe('host-agent')
        expect(fit.notes.join(' ')).toMatch(/schreibgeschützt: nur über den Host-Agenten/)
    })

    it('GPU load never next to a vLLM bottleneck, heavy GPU load never next to vLLM at all', () => {
        const whisper = cand('stt-whisper-large-v3')
        expect(assessCandidate(whisper, spark()).status).toBe('passt') // healthy Spark, 42 GB free
        const pressured = assessCandidate(whisper, spark({ memFree: 8, memStatus: 'warn' }))
        expect(pressured.status).toBe('passt-nicht')
        expect(pressured.reasons[0]).toMatch(/vLLM-Engpass/)
        const queued = assessCandidate(whisper, { ...spark(), load: { vllmWaiting: 3 } })
        expect(queued.status).toBe('passt-nicht')
        expect(queued.reasons[0]).toMatch(/vLLM-Engpass: 3 Anfragen warten/)
        const tight = assessCandidate(whisper, spark({ memFree: 10 }))
        expect(tight.status).toBe('passt-nicht')
        expect(tight.reasons[0]).toMatch(/zu wenig freier GPU-Speicher neben vLLM/)
        const heavyStt = loadSoftwareCandidates([{ ...structuredClone(whisper), id: 'stt-whisper-finetune', heavy: true }]).entries[0]
        const heavy = assessCandidate(heavyStt, spark())
        expect(heavy.status).toBe('passt-nicht')
        expect(heavy.reasons[0]).toBe('schwere GPU-Last nie neben laufendem vLLM')
    })

    it('NAS never gets a system package, only models into the data volume', () => {
        const ffmpeg = assessCandidate(cand('media-ffmpeg'), nas())
        expect(ffmpeg.status).toBe('passt-nicht')
        expect(ffmpeg.reasons[0]).toMatch(/^NAS: nur Modelle/)
        // also without a catalog entry (no second guard from the Stufe-2 route)
        const piper = assessCandidate(cand('tts-piper'), nas())
        expect(piper.status).toBe('passt-nicht')
        expect(piper.reasons[0]).toMatch(/^NAS: nur Modelle/)
        const embed = assessCandidate(cand('embedding-nomic-embed-text'), nas({ services: [{ name: 'ollama', type: 'llm', status: 'running' }] }))
        expect(embed.status).toBe('passt')
        expect(embed.route).toBe('model-volume')
    })

    it('capability already there → vorhanden; already installed → installiert; never a proposal', () => {
        expect(assessCandidate(cand('media-ffmpeg'), spark()).status).toBe('vorhanden')
        const stopped = assessCandidate(cand('tts-piper'), ns1({ services: [{ name: 'piper', type: 'tts', status: 'stopped' }] }))
        expect(stopped.status).toBe('installiert')
        const withStt = [spark({ services: [{ name: 'vllm', type: 'llm', status: 'running' }, { name: 'faster-whisper', type: 'stt', status: 'running' }] }), ns1(), ns2(), nas()]
        const analysis = analyzeMesh(withStt, { now: NOW })
        expect(analysis.capabilities.find(item => item.capability === 'stt')!.present).toEqual([{ nodeId: 'xaventra-spark', evidence: 'faster-whisper läuft' }])
        expect(gapThoughts(analysis, 99, { demand: NEED }).some(thought => thought.capability === 'stt')).toBe(false)
        expect(gapThoughts(analysis, 99, { demand: NEED }).some(thought => thought.capability === 'media' || thought.capability === 'llm')).toBe(false)
    })

    it('2.86 Paket O: the one-button local voice service is proposed first (catalog route, no GPU needed)', () => {
        const analysis = analyzeMesh(mesh(), { now: NOW })
        const [stt] = gapThoughts(analysis, undefined, { demand: NEED })
        expect(stt.capability).toBe('stt')
        expect(stt.candidateId).toBe('sprache-lokal-de')
        expect(stt.proposal).toMatch(/Installations-Warteschlange \(Katalog sprachdienst:de/)
    })

    it('best node per gap: Whisper large on the Spark (GPU), with why not elsewhere', () => {
        const withoutVoiceBundle = { ...getSoftwareCandidates(), entries: getSoftwareCandidates().entries.filter(entry => entry.id !== 'sprache-lokal-de') }
        const analysis = analyzeMesh(mesh(), { now: NOW, candidates: withoutVoiceBundle })
        const [stt] = gapThoughts(analysis, undefined, { demand: NEED })
        expect(stt.capability).toBe('stt')
        expect(stt.candidateId).toBe('stt-whisper-large-v3')
        expect(stt.nodeId).toBe('xaventra-spark')
        // 2.84: the title names only the target node; why the others do not fit is evidence
        // (Alfred: "auf X braucht Ollama" read like installing Ollama there).
        expect(stt.title).toBe('Whisper large-v3 (GPU) auf xaventra-spark einrichten (42 GB frei)?')
        expect(stt.title).not.toMatch(/ns1|ns2/)
        expect(stt.evidence).toEqual(expect.arrayContaining(['Bedarf: 1× Testbedarf', 'nicht auf ns1: keine NVIDIA-GPU', 'nicht auf ns2: zu wenig RAM (4 GB, nötig 8 GB)']))
        expect(stt.permission).toBe('fragen')
        expect(stt.proposal).toMatch(/Katalogeintrag nötig/)
        // a catalog-backed gap proposes the Stufe-2 path
        const browser = gapThoughts(analysis, 99, { demand: NEED }).find(thought => thought.capability === 'browser')!
        expect(browser.candidateId).toBe('browser-playwright-chromium')
        expect(browser.proposal).toMatch(/Installations-Warteschlange \(Katalog playwright-chromium/)
    })

    it('stale peers are listed but not rated', () => {
        const analysis = analyzeMesh([spark(), { ...ns1(), lastSeen: NOW - 60 * 60_000 }], { now: NOW })
        expect(analysis.nodes).toEqual([{ nodeId: 'xaventra-spark', rated: true }, { nodeId: 'ns1', rated: false, note: 'veraltet, nicht bewertet' }])
    })

    it('/software overview is read-only and says when proposals are off', () => {
        const text = formatSoftwareOverview(analyzeMesh(mesh(), { now: NOW }), { proposalsEnabled: false })
        expect(text).toMatch(/nur lesend/)
        expect(text).toMatch(/Vorschläge: aus \(autonomy\.softwareScout\.enabled\)/)
        expect(text).toMatch(/Audio\/Video \(ffmpeg\)\* — vorhanden: xaventra-spark/)
        expect(text).toMatch(/Spracherkennung \(STT\)\* — fehlt/)
        expect(text).toMatch(/passt nicht: Whisper large-v3 \(GPU\) auf ns2 — zu wenig RAM/)
    })

    it('a peer profile keeps only bounded, known service entries', () => {
        const clean = sanitizeNodeProfile({ ...spark().profile, services: [{ name: 'whisper', type: 'stt', status: 'running' }, { name: 'x', type: 'shell', status: 'running' }, { name: 'v', type: 'vllm', status: 'weird' }] })!
        expect(clean.services).toEqual([{ name: 'v', type: 'llm', status: 'stopped' }, { name: 'whisper', type: 'stt', status: 'running' }])
        const { services: _drop, ...old } = spark().profile
        expect(sanitizeNodeProfile(old)!.services).toBeUndefined()
    })
})

describe('Vorschläge: Standard aus, nur Main, entprellt', () => {
    it('P8: on at the Main without config, off on a worker; enabled:false proposes nothing', async () => {
        expect(parseSoftwareScoutSettings(undefined, {} as NodeJS.ProcessEnv).enabled).toBe(true)
        expect(parseSoftwareScoutSettings(undefined, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv).enabled).toBe(false)
        expect(parseSoftwareScoutSettings({ enabled: 'false' }, {} as NodeJS.ProcessEnv).enabled).toBe(false)
        const emit = vi.fn()
        const result = await runSoftwareScoutTick({ isMain: true, now: NOW, settings: parseSoftwareScoutSettings({ enabled: false }), nodes: mesh, sink: { emit }, statePath: tmpState() })
        expect(result.ran).toBe(false)
        expect(result.reason).toMatch(/^aus/)
        expect(emit).not.toHaveBeenCalled()
    })

    it('a worker sends nothing, even when switched on', async () => {
        const emit = vi.fn()
        const nodes = vi.fn(mesh)
        const result = await runSoftwareScoutTick({ isMain: false, now: NOW, settings: { enabled: true }, nodes, sink: { emit }, statePath: tmpState() })
        expect(result.ran).toBe(false)
        expect(emit).not.toHaveBeenCalled()
        expect(nodes).not.toHaveBeenCalled()
    })

    it('on: at most 3 thoughts, weekly and on profile change, the same proposal not again within a week; Nein mutes 30 days', async () => {
        const statePath = tmpState()
        const emit = vi.fn()
        // peers keep sending heartbeats: lastSeen follows the clock
        const run = (now: number, nodes = mesh) => runSoftwareScoutTick({ isMain: true, now, settings: { enabled: true }, sink: { emit }, statePath,
            demand: () => NEED, freshness: { search: null, cachePath: join(dirname(statePath), 'aktualitaet.json') },
            nodes: () => nodes().map(node => node.local ? node : { ...node, lastSeen: now - 30_000 }) })
        const first = await run(NOW)
        expect(first.ran).toBe(true)
        // 2.86 (Paket G): the Main without Ollama now has a route for embeddings (own in-process GGUF).
        expect(first.emitted.map(item => item.capability)).toEqual(['stt', 'tts', 'embedding'])
        expect(emit).toHaveBeenCalledTimes(3)
        expect((await run(NOW + 60 * 60_000)).ran).toBe(false) // nothing changed, not due
        // profile change: runs again, but already proposed gaps stay quiet; a new gap shows up
        const changed = () => [spark(), ns1(), ns2({ ramGB: 32 }), nas()]
        const second = await run(NOW + 2 * 60 * 60_000, changed)
        expect(second.ran).toBe(true)
        expect(second.emitted.map(item => item.dedupeKey)).not.toContain(first.emitted[0].dedupeKey)
        // after a week the same proposal may come back — unless the owner said Nein
        recordSoftwareScoutAnswer(first.emitted[0].dedupeKey, 'nein', { statePath, now: NOW + 3 * 60 * 60_000 })
        emit.mockClear()
        const later = await run(NOW + PROPOSAL_DEDUPE_MS + 3 * 60 * 60_000, changed)
        expect(later.ran).toBe(true)
        expect(later.emitted.map(item => item.dedupeKey)).not.toContain(first.emitted[0].dedupeKey)
        expect(later.emitted.map(item => item.dedupeKey)).toContain(first.emitted[1].dedupeKey)
    })
})
