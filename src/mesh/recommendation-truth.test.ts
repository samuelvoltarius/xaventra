/**
 * 2.89.4: Empfehlungen zu „aktuell / neueste / Stand der Technik / Ende <Jahr>“
 * — Websuche, Systemdatum, Hardware je Knoten, ehrliche Veraltetheit.
 */
import { describe, expect, it, vi } from 'vitest'
import {
    STALE_NOTE, freshnessQuery, freshnessStamp, fitsNodeHardware, formatFreshnessRecommendationReply,
    installOffersFor, isFreshnessQuestion, researchFreshness,
} from './recommendation-truth.js'
import { getRecommendations, formatRecommendations } from './model-recommender.js'

describe('2.89.4: Aktualitäts-Fragen erkennen (Inventar bleibt draußen)', () => {
    it.each([
        'Was ist aktuell bei den Modellen?',
        'Welche Modelle sind aktuell?',
        'Was ist das neueste Modell?',
        'Stand der Technik für lokale Modelle?',
        'Was wird Ende 2026 bei der Software aktuell sein?',
        'Welche Modelle empfiehlst du mir?',
        'Was ist aktuell zu empfehlen an Software?',
        'Sind die Modelle noch aktuell?',
    ])('%s → Frische-Frage', text => {
        expect(isFreshnessQuestion(text)).toBe(true)
    })

    it.each([
        'Welche Modelle laufen gerade?',
        'Welche Modelle hast du verfügbar?',
        'Welche Modelle sind auf den Nodes?',
        'Welche Nova Version ist installiert?',
        'Läuft alles?',
        'Installiere das neueste Modell auf ns1',
    ])('%s → keine Frische-Frage', text => {
        expect(isFreshnessQuestion(text)).toBe(false)
    })
})

describe('2.89.4: Websuche-Pflicht und ehrliche Veraltetheit', () => {
    it('mit Treffern: Beleg aus der Suche, Stand aus der Systemzeit', async () => {
        const search = { search: vi.fn(async () => ({
            tool: 'browser_search',
            hits: [{ url: 'https://ollama.com/library/qwen3', title: 'qwen3', snippet: 'Released 2025-04' }],
        })) }
        const evidence = await researchFreshness('neueste Modelle', { search, now: Date.parse('2026-10-09T12:00:00.000Z') })
        expect(evidence.searched).toBe(true)
        expect(evidence.hits).toBe(1)
        expect(evidence.note).toMatch(/geprüft mit browser_search/)
        expect(evidence.note).not.toBe(STALE_NOTE)
        const stamp = freshnessStamp(evidence)
        expect(stamp).toContain('Stand: 2026-10-09 (Systemzeit)')
        expect(stamp).toContain('qwen3')
    })

    it.each([
        'empty hits',
        'throws',
        'no search port',
    ])('%s → genau „mein Wissen kann veraltet sein“', async kind => {
        const search = kind === 'throws'
            ? { search: vi.fn(async () => { throw new Error('offline') }) }
            : { search: vi.fn(async () => ({ tool: 'web_search', hits: [] })) }
        const evidence = await researchFreshness('Stand der Technik', {
            search: kind === 'no search port' ? null : search,
            now: Date.parse('2026-10-09T12:00:00.000Z'),
        })
        expect(evidence.note).toBe(STALE_NOTE)
        expect(evidence.note).toBe('mein Wissen kann veraltet sein')
        expect(freshnessStamp(evidence)).toContain(STALE_NOTE)
        expect(freshnessStamp(evidence)).toContain('Stand: 2026-10-09 (Systemzeit)')
    })

    it('der Katalog allein behauptet nie „aktuell“', async () => {
        const search = { search: vi.fn(async () => ({ tool: 'web_search', hits: [] })) }
        const evidence = await researchFreshness('Modelle', { search })
        const recs = getRecommendations('local', { ramGb: 32, hasGpu: true, vramGb: 16 })
        recs.freshnessNote = evidence.searched && evidence.hits > 0 ? evidence.note : STALE_NOTE
        const text = formatRecommendations(recs)
        expect(text).not.toMatch(/Katalog:\s*aktuell/)
        expect(text).toContain(STALE_NOTE)
        expect(text).toMatch(/Stand: \d{4}-\d{2}-\d{2} \(Systemzeit\)/)
    })
})

describe('2.89.4: Hardware je Knoten — kein Großmodell auf purem CPU', () => {
    const large = { tier: 'large' as const, minRamGb: 20, type: 'chat' as const }
    const xlarge = { tier: 'xlarge' as const, minRamGb: 45, minVramGb: 40, type: 'chat' as const }
    const small = { tier: 'small' as const, minRamGb: 5, type: 'chat' as const }
    const embed = { tier: 'small' as const, minRamGb: 1, type: 'embedding' as const }

    it('CPU-only: large/xlarge fallen raus, klein bleibt', () => {
        expect(fitsNodeHardware(large, { ramGb: 64, hasGpu: false })).toBe(false)
        expect(fitsNodeHardware(xlarge, { ramGb: 128, hasGpu: false })).toBe(false)
        expect(fitsNodeHardware(small, { ramGb: 8, hasGpu: false })).toBe(true)
        expect(fitsNodeHardware(embed, { ramGb: 8, hasGpu: false })).toBe(true)
    })

    it('GPU mit VRAM: large passt, xlarge ohne 40 GB VRAM nicht', () => {
        expect(fitsNodeHardware(large, { ramGb: 32, hasGpu: true, vramGb: 16 })).toBe(true)
        expect(fitsNodeHardware(xlarge, { ramGb: 64, hasGpu: true, vramGb: 16 })).toBe(false)
        expect(fitsNodeHardware(xlarge, { ramGb: 64, hasGpu: true, vramGb: 48 })).toBe(true)
    })

    it('zu wenig RAM: kein Modell; CPU-only: kein large-Pull', () => {
        expect(fitsNodeHardware({ tier: 'medium', minRamGb: 9, type: 'chat' }, { ramGb: 8, hasGpu: false })).toBe(false)
        const offers = installOffersFor([
            { ...small, model: 'qwen3:7b', pullCmd: 'ollama pull qwen3:7b' },
            { ...large, model: 'qwen3:32b', pullCmd: 'ollama pull qwen3:32b' },
        ] as any, { ramGb: 64, hasGpu: false })
        expect(offers).toEqual(['ollama pull qwen3:7b'])
        expect(installOffersFor([
            { ...large, model: 'qwen3:32b', pullCmd: 'ollama pull qwen3:32b' },
        ] as any, { ramGb: 64, hasGpu: false })).toEqual([])
    })

    it('getRecommendations: CPU-Kiste mit 64 GB RAM bekommt keine large/xlarge', () => {
        const recs = getRecommendations('cpu-box', { ramGb: 64, hasGpu: false })
        expect(recs.cpuOnlyCapped).toBe(true)
        expect(recs.recommended.every(m => m.tier !== 'large' && m.tier !== 'xlarge')).toBe(true)
        expect(recs.toInstall.every(name => !/:(?:30b|32b|70b|72b)/.test(name))).toBe(true)
        expect(recs.pullCommands.every(cmd => !/:(?:30b|32b|70b|72b)/.test(cmd))).toBe(true)
        const text = formatRecommendations(recs)
        expect(text).toMatch(/nur CPU/)
        expect(text).toMatch(/keine großen Modelle/)
        expect(text).toContain(STALE_NOTE)
    })

    it('GPU-Kiste (24 GB VRAM) darf large behalten', () => {
        const recs = getRecommendations('gpu-box', { ramGb: 32, hasGpu: true, vramGb: 24, gpuType: 'cuda' })
        expect(recs.cpuOnlyCapped).toBeUndefined()
        expect(recs.recommended.some(m => m.tier === 'large')).toBe(true)
    })
})

describe('2.89.4: formatFreshnessRecommendationReply (ein Eingang, eine Antwort)', () => {
    it('mit Fake-Suche: Beleg + Datum + Hardware; ohne Treffer: Stale-Note', async () => {
        const withHits = await formatFreshnessRecommendationReply({
            topic: 'Welche Modelle sind Ende 2026 aktuell?',
            node: 'ns1',
            hardware: { ramGb: 8, hasGpu: false },
            search: { search: async () => ({ tool: 'brave_search', hits: [{ url: 'https://ollama.com/library/gemma3', title: 'gemma3' }] }) },
            now: Date.parse('2026-10-09T08:00:00.000Z'),
        })
        expect(withHits).toContain('Stand: 2026-10-09 (Systemzeit)')
        expect(withHits).toMatch(/geprüft mit brave_search/)
        expect(withHits).toContain('nur CPU')
        expect(withHits).not.toContain(STALE_NOTE)

        const without = await formatFreshnessRecommendationReply({
            topic: 'Stand der Technik Software',
            hardware: { ramGb: 8, hasGpu: false },
            search: { search: async () => ({ tool: 'web_search', hits: [] }) },
            now: Date.parse('2026-10-09T08:00:00.000Z'),
        })
        expect(without).toContain(STALE_NOTE)
        expect(without).toContain('Stand: 2026-10-09 (Systemzeit)')
        expect(without).not.toMatch(/geprüft mit/)
    })
})
