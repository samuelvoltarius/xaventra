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


// B6 (28.10.2026): "Gemma 4 E2B auf ns1 einrichten?" kam 02.10./09.10./16.10. wieder und als Idee
// "Könnte Bilderkennung (Vision) (Gemma 4 E2B … auf xaventra-ns1), bisher kein Bedarf gesehen" weiter —
// live: muted nur `software-scout:vision:vision-gemma4-e2b:xaventra-ns1` (30 Tage), die Idee hat eigenen Schlüssel.
describe('B6: Nein bleibt stumm, bis sich der Anlass ändert', () => {
    const DAY = 24 * 60 * 60_000
    const setup = () => {
        const statePath = tmpState()
        const emit = vi.fn()
        let need: ReadonlyMap<any, CapabilityDemand> = NEED
        const run = (now: number) => runSoftwareScoutTick({ isMain: true, now, settings: { enabled: true }, sink: { emit }, statePath,
            demand: () => need, freshness: { search: null, cachePath: join(dirname(statePath), 'aktualitaet.json') },
            nodes: () => mesh().map(node => node.local ? node : { ...node, lastSeen: now - 30_000 }) })
        return { statePath, emit, run, setNeed: (value: ReadonlyMap<any, CapabilityDemand>) => { need = value } }
    }
    const withNeed = (capability: string, evidence: string[] | null) => new Map([...NEED].filter(([key]) => key !== capability)
        .concat(evidence ? [[capability, { capability, count: evidence.length, evidence } as CapabilityDemand]] : []))

    it('same reason: neither card nor idea of that capability returns — also after 30 days', async () => {
        const { statePath, run } = setup()
        const first = await run(NOW)
        const rejected = first.emitted[0]
        recordSoftwareScoutAnswer(rejected.dedupeKey, 'nein', { statePath, now: NOW + 60_000 })
        for (const day of [8, 15, 31, 45, 90]) {
            const later = await run(NOW + day * DAY)
            expect(later.emitted.filter(item => item.capability === rejected.capability)).toEqual([])
        }
    })

    it('need gone after the Nein: no quiet idea for that capability either', async () => {
        const { statePath, run, setNeed } = setup()
        const first = await run(NOW)
        const rejected = first.emitted[0]
        recordSoftwareScoutAnswer(rejected.dedupeKey, 'nein', { statePath, now: NOW + 60_000 })
        setNeed(withNeed(rejected.capability, null))
        const later = await run(NOW + 8 * DAY)
        expect(later.emitted.filter(item => item.capability === rejected.capability)).toEqual([])
    })

    it('a new reason (new need evidence) lifts the mute', async () => {
        const { statePath, run, setNeed } = setup()
        const first = await run(NOW)
        const rejected = first.emitted[0]
        recordSoftwareScoutAnswer(rejected.dedupeKey, 'nein', { statePath, now: NOW + 60_000 })
        setNeed(withNeed(rejected.capability, ['3× Testbedarf', '2× Sprachnachricht nicht verstanden']))
        const later = await run(NOW + 8 * DAY)
        expect(later.emitted.map(item => item.dedupeKey)).toContain(rejected.dedupeKey)
    })
})

describe('B6: old 30-day Nein from the live state', () => {
    it('the running numeric mute of Gemma on ns1 also silences the quiet vision idea', async () => {
        const { writeFileSync } = await import('node:fs')
        const statePath = tmpState()
        writeFileSync(statePath, JSON.stringify({ version: 1, proposed: {}, muted: { 'software-scout:stt:sprache-lokal-de:xaventra-ns1': Date.now() + 18 * 24 * 60 * 60_000 } }))
        const emit = vi.fn()
        const noNeed = new Map([...NEED].filter(([key]) => key !== 'stt'))
        const result = await runSoftwareScoutTick({ isMain: true, now: Date.now(), settings: { enabled: true }, sink: { emit }, statePath,
            demand: () => noNeed, freshness: { search: null, cachePath: join(dirname(statePath), 'aktualitaet.json') },
            nodes: () => mesh().map(node => node.local ? node : { ...node, lastSeen: Date.now() - 30_000 }) })
        expect(result.emitted.filter(item => item.capability === 'stt')).toEqual([])
    })
})
