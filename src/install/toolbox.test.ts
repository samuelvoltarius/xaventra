import { describe, expect, it } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import type { InstallProposal } from './install-queue.js'
import type { CapabilityDemand } from './software-demand.js'
import type { FreshnessRecord } from './software-freshness.js'
import type { ScoutNode } from './software-scout.js'
import { formatToolboxShort, listToolbox, type ToolboxEntry, type ToolboxInput } from './toolbox.js'

// 2.85 Paket D: "Werkzeugkasten" — read model over existing data only
// (catalog, candidates, node profiles, need, freshness cache, install queue,
// optional Paket-C scan). Deterministic, no network, no search on page view.

const NOW = Date.parse('2026-10-02T10:00:00.000Z')

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
const main = (over: Parameters<typeof profile>[0] = {}): ScoutNode => ({
    nodeId: 'main-a', local: true,
    profile: profile({ nodeId: 'main-a', role: 'main', runtime: 'native', ramGB: 64, cpus: 16, installPath: 'host-agent', tools: ['apt', 'ffmpeg'],
        services: [{ name: 'ollama', type: 'llm', status: 'running' }], ...over }),
})
const worker = (over: Parameters<typeof profile>[0] = {}): ScoutNode => ({ nodeId: 'worker-b', local: false, lastSeen: NOW - 30_000, profile: profile({ nodeId: 'worker-b', ramGB: 4, ...over }) })

const base = (over: Partial<ToolboxInput> = {}): ToolboxInput => ({ nodes: [main(), worker()], now: NOW, ...over })
const entry = (toolbox: ReturnType<typeof listToolbox>, id: string): ToolboxEntry => {
    const found = toolbox.gruppen.flatMap(group => group.eintraege).find(item => item.id === id)
    if (!found) throw new Error(`fehlt: ${id}`)
    return found
}
const done = (catalogId: string, over: Partial<InstallProposal> = {}): InstallProposal => ({
    id: 'iq-0123456789ab', catalogId, nodeId: 'main-a', route: { kind: 'host-agent' }, status: 'done', source: 'owner',
    createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:05:00.000Z', ticketId: 'it-0123456789abcdef0123', result: { success: true, newPackages: ['tesseract-ocr'] }, ...over,
})

describe('listToolbox: Lese-Modell des Werkzeugkastens', () => {
    it('groups every candidate by capability, each with a plain benefit sentence', () => {
        const toolbox = listToolbox(base())
        const ids = toolbox.gruppen.flatMap(group => group.eintraege.map(item => item.id))
        expect(ids).toContain('stt-faster-whisper-small')
        expect(ids).toContain('search-searxng')
        expect(ids).toContain('vision-tesseract-ocr')
        expect(toolbox.gruppen.map(group => group.faehigkeit)).toEqual([...new Set(toolbox.gruppen.map(group => group.faehigkeit))])
        for (const group of toolbox.gruppen) for (const item of group.eintraege) {
            expect(item.faehigkeit).toBe(group.faehigkeit)
            expect(item.nutzen).toMatch(/\.$/)
        }
        expect(entry(toolbox, 'stt-faster-whisper-small').nutzen).toMatch(/Sprachnachrichten/)
    })

    it('status "passt auf Knoten X" with the recommended node and an install button only on the host-agent route', () => {
        const tesseract = entry(listToolbox(base()), 'vision-tesseract-ocr')
        expect(tesseract.status).toBe('passt')
        expect(tesseract.knoten).toBe('main-a')
        expect(tesseract.statusText).toBe('passt auf main-a')
        expect(tesseract.knopf).toEqual({ art: 'installieren', katalogId: 'tesseract-ocr', knoten: 'main-a' })
    })

    it('status "passt nicht" carries the reason from assessCandidate and offers no button', () => {
        // Only a small container worker: Whisper large needs a GPU.
        const whisper = entry(listToolbox(base({ nodes: [worker()] })), 'stt-whisper-large-v3')
        expect(whisper.status).toBe('passt-nicht')
        expect(whisper.statusText).toMatch(/^passt nicht: .*\(worker-b\)$/)
        expect(whisper.knopf).toBeNull()
    })

    it('a candidate without catalog entry fits but says plainly that there is no button yet', () => {
        const searx = entry(listToolbox(base()), 'search-searxng')
        expect(searx.status).toBe('passt')
        expect(searx.knopf).toBeNull()
        expect(searx.hinweis).toMatch(/noch nicht per Knopf/i)
    })

    it('"installiert" from the profile (ffmpeg tool) and "läuft" from the Paket-C scan when present', () => {
        const scan = { services: [{ name: 'SearXNG', provider: 'searxng', status: 'running' as const, sourceNode: 'worker-b', host: 'searx.example.com' }] }
        const toolbox = listToolbox(base({ scan }))
        expect(entry(toolbox, 'media-ffmpeg')).toMatchObject({ status: 'installiert', statusText: 'installiert auf main-a', knopf: null })
        expect(entry(toolbox, 'search-searxng')).toMatchObject({ status: 'laeuft', statusText: 'läuft auf worker-b', knopf: null })
        // Without the scan, the same candidate is only a fit (no own scanner).
        expect(entry(listToolbox(base()), 'search-searxng').status).toBe('passt')
    })

    it('an installation finished through the queue is "installiert" and offers the rollback button', () => {
        const toolbox = listToolbox(base({ queue: [done('tesseract-ocr')] }))
        expect(entry(toolbox, 'vision-tesseract-ocr')).toMatchObject({
            status: 'installiert', statusText: 'installiert auf main-a', knopf: { art: 'entfernen', queueId: 'iq-0123456789ab' },
        })
        // Nothing to undo when it was already there before.
        const before = listToolbox(base({ queue: [done('tesseract-ocr', { result: { success: true, alreadyInstalled: true } })] }))
        expect(entry(before, 'vision-tesseract-ocr').knopf).toBeNull()
    })

    it('an open proposal waits for its card instead of offering a second button', () => {
        const queued = done('tesseract-ocr', { status: 'queued', ticketId: undefined, result: undefined })
        const tesseract = entry(listToolbox(base({ queue: [queued] })), 'vision-tesseract-ocr')
        expect(tesseract.knopf).toBeNull()
        expect(tesseract.hinweis).toMatch(/wartet auf deine Freigabe/)
        expect(tesseract.warteschlange).toEqual({ id: 'iq-0123456789ab', status: 'queued' })
    })

    it('"empfohlen, weil gebraucht" only with a recorded need, with the evidence', () => {
        const demand = new Map([['vision', { capability: 'vision', count: 2, evidence: ['2× analyze_image gescheitert (Owner-Läufe, 14 Tage)'] } as CapabilityDemand]])
        const toolbox = listToolbox(base({ demand }))
        const tesseract = entry(toolbox, 'vision-tesseract-ocr')
        expect(tesseract.empfohlen).toBe(true)
        expect(tesseract.bedarf).toEqual(['2× analyze_image gescheitert (Owner-Läufe, 14 Tage)'])
        expect(entry(toolbox, 'media-ffmpeg').empfohlen).toBe(false)
        expect(entry(listToolbox(base()), 'vision-tesseract-ocr').empfohlen).toBe(false)
        // The recommended entry comes first in its group.
        expect(toolbox.gruppen.find(group => group.faehigkeit === 'vision')!.eintraege[0].empfohlen).toBe(true)
    })

    it('freshness comes from the cache only; models without a check say so, programs have none', () => {
        const fresh: Record<string, FreshnessRecord> = {
            'vision-gemma4-e2b': { status: 'aktuell', checkedAt: Date.parse('2026-09-30T08:00:00.000Z'), tool: 'web_search' },
            'embedding-bge-m3': { status: 'nachfolger', checkedAt: Date.parse('2026-09-30T08:00:00.000Z'), successor: { name: 'bge-m4', url: 'https://ollama.com/library/bge-m4' } },
        }
        const toolbox = listToolbox(base({ freshness: fresh }))
        expect(entry(toolbox, 'vision-gemma4-e2b').aktualitaet).toMatchObject({ status: 'aktuell', stand: '2026-04' })
        expect(entry(toolbox, 'vision-gemma4-e2b').aktualitaet.text).toMatch(/geprüft am 30\.09\.2026/)
        expect(entry(toolbox, 'embedding-bge-m3').aktualitaet).toMatchObject({ status: 'nachfolger' })
        expect(entry(toolbox, 'embedding-bge-m3').aktualitaet.text).toMatch(/bge-m4/)
        expect(entry(toolbox, 'embedding-nomic-embed-text').aktualitaet.status).toBe('ungeprueft')
        expect(entry(toolbox, 'media-ffmpeg').aktualitaet.status).toBe('kein-modell')
    })

    it('is deterministic: same input, same output', () => {
        const input = base({ queue: [done('tesseract-ocr')] })
        expect(JSON.stringify(listToolbox(input))).toBe(JSON.stringify(listToolbox(input)))
    })

    it('a stale peer is listed but not rated', () => {
        const toolbox = listToolbox(base({ nodes: [main(), { ...worker(), lastSeen: NOW - 60 * 60_000 }] }))
        expect(toolbox.knoten).toEqual([{ id: 'main-a', bewertet: true }, { id: 'worker-b', bewertet: false }])
    })

    it('short text for Telegram: few lines, plain words, no command', () => {
        const demand = new Map([['vision', { capability: 'vision', count: 1, evidence: ['1× Test'] } as CapabilityDemand]])
        const text = formatToolboxShort(listToolbox(base({ demand })))
        expect(text.split('\n').length).toBeLessThanOrEqual(16)
        expect(text).toMatch(/Werkzeugkasten/)
        expect(text).toMatch(/empfohlen/)
        expect(text).not.toMatch(/\/setup|iq-|apt-get/)
    })
})
