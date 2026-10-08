/**
 * 2.89.3 Werkzeuglücke (live 08.10.2026: "Wie spät ist es und wie ist das Wetter in Wien?" bestand nur 3/6):
 * (a) Wetter hat jetzt ein eigenes Werkzeug (Open-Meteo, Abruf gemockt), (b) ein Teilauftrag ohne Fähigkeit wird
 * ehrlich geschlossen + Lernfrage, (c) Ausweichen auf Behelfe endet mit Lernangebot statt Stille.
 * Über den echten Telegram-Eingang; nur das Modell und der Open-Meteo-Abruf sind gespielt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness, type HarnessOptions } from '../../test/helpers/e2e-harness.js'

const meteo = vi.hoisted(() => ({ urls: [] as string[] }))
vi.mock('../resilience/ssrf-guard.js', async importOriginal => {
    const real = await importOriginal<typeof import('../resilience/ssrf-guard.js')>()
    return {
        ...real,
        fetchWithSsrfGuard: async (url: string) => {
            meteo.urls.push(url)
            if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
                return Response.json({ results: [{ name: 'Wien', admin1: 'Wien', country: 'Österreich', latitude: 48.20849, longitude: 16.37208 }] })
            }
            if (url.startsWith('https://api.open-meteo.com/')) {
                return Response.json({
                    current: { time: '2026-10-08T19:00', temperature_2m: 14.2, apparent_temperature: 13.1, relative_humidity_2m: 71, precipitation: 0, weather_code: 3, wind_speed_10m: 9.4 },
                    daily: { time: ['2026-10-08', '2026-10-09'], weather_code: [3, 61], temperature_2m_max: [16.1, 15.4], temperature_2m_min: [9.2, 8.8], precipitation_sum: [0, 3.2], precipitation_probability_max: [10, 70] },
                })
            }
            throw new Error(`unexpected fetch ${url}`)
        },
    }
})

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; meteo.urls.length = 0 })
async function harness(options: HarnessOptions = {}): Promise<E2EHarness> { h = await createE2EHarness(options); return h }
const T = 90_000

describe('2.89.3 Werkzeuglücke', () => {
    it('(a) Zeit + Wetter in Wien: eigenes Wetter-Werkzeug, beide Teile beantwortet, kein run_command', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Wie spät ist es und wie ist das Wetter in Wien?', [
            { tools: [{ name: 'get_current_time', arguments: {} }, { name: 'weather', arguments: { ort: 'Wien' } }] },
            { text: 'Es ist 19:08 Uhr. In Wien sind es 14 Grad und bedeckt, morgen Regen bei 9 bis 15 Grad.' },
        ])
        expect(result.offeredTools).toEqual(expect.arrayContaining(['weather', 'get_current_time']))
        expect(result.executedTools).toEqual(expect.arrayContaining(['weather']))
        expect(result.executedTools).not.toContain('run_command')
        expect(meteo.urls.some(url => url.startsWith('https://geocoding-api.open-meteo.com/v1/search?') && url.includes('name=Wien'))).toBe(true)
        expect(meteo.urls.some(url => url.startsWith('https://api.open-meteo.com/v1/forecast?') && url.includes('latitude=48.20849'))).toBe(true)
        expect(result.final).toMatch(/19:08/)
        expect(result.final).toMatch(/Wien/)
        expect(result.final).not.toMatch(/kein eigenes Werkzeug/)
    }, T)

    it('(b) Teilauftrag ohne Fähigkeit (Fax): Uhrzeit beantwortet, ehrliche Teilantwort + Lernfrage, Lernlücke registriert, kein run_command', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Wie spät ist es und kannst du mir außerdem ein Fax an 01 234567 schicken?', [
            { tool: 'get_current_time', args: {} },
            { text: 'Es ist 19:08 Uhr.' },
        ])
        expect(result.executedTools).not.toContain('run_command')
        expect(result.trace).toContain('capability:compound-gap')
        expect(result.final).toMatch(/19:08/)
        expect(result.final).toMatch(/kein eigenes Werkzeug/)
        expect(result.final).toMatch(/Soll ich es lernen\?/)
        expect(result.final.indexOf('19:08')).toBeLessThan(result.final.indexOf('kein eigenes Werkzeug'))
        const { listApprovalCards } = await e2e.module('core/approval-cards.js')
        const card = listApprovalCards().find((item: any) => item.art === 'faehigkeit-lernen')
        expect(card?.status).toBe('offen')
        expect(card?.titel).toMatch(/Fax/)
        const { listLearnJobs } = await e2e.module('learning/capability-learning.js')
        expect(listLearnJobs().some((job: any) => job.domainId === 'fax' && job.status === 'angeboten')).toBe(true)
    }, T)

    it('(c) Budget/Behelfe: Ausweichen auf Suche/Shell endet nach drei Behelfen mit ehrlicher Antwort + Lernangebot', async () => {
        const e2e = await harness({ searxng: true })
        const result = await e2e.telegram('Wie ist die Luftqualität in Wien gerade?', [
            { tool: 'searxng_search', args: { query: 'Luftqualität Wien' } },
            { tool: 'searxng_search', args: { query: 'Feinstaub Wien aktuell' } },
            { tool: 'searxng_search', args: { query: 'AQI Wien Messwerte' } },
            { tool: 'searxng_search', args: { query: 'Wien Luft Index live' } },
            { text: 'Aus den Treffern lässt sich kein aktueller Messwert ablesen.' },
        ])
        expect(result.executedTools.filter((name: string) => name === 'searxng_search').length).toBeLessThanOrEqual(3)
        expect(result.trace).toContain('capability:limit-gap')
        expect(result.final).toMatch(/kein (?:eigenes|passendes) Werkzeug/)
        expect(result.final).toMatch(/Soll ich es lernen\?/)
        const { listApprovalCards } = await e2e.module('core/approval-cards.js')
        expect(listApprovalCards().some((item: any) => item.art === 'faehigkeit-lernen' && item.status === 'offen')).toBe(true)
    }, T)
})
