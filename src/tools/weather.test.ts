import { describe, expect, it } from 'vitest'
import { fetchWeather, weatherCodeText } from './weather.js'
import { getRelevantTools } from './tool-router.js'
import { selectContextPolicy } from '../core/context-policy.js'

const GEO = { results: [{ name: 'Wien', admin1: 'Wien', country: 'Österreich', latitude: 48.2, longitude: 16.37 }] }
const FORECAST = {
    current: { time: '2026-10-08T19:00', temperature_2m: 14.2, apparent_temperature: 13.1, relative_humidity_2m: 71, precipitation: 0, weather_code: 3, wind_speed_10m: 9.4 },
    daily: { time: ['2026-10-08', '2026-10-09'], weather_code: [3, 61], temperature_2m_max: [16.1, 15.4], temperature_2m_min: [9.2, 8.8], precipitation_sum: [0, 3.2], precipitation_probability_max: [10, 70] },
}

describe('weather tool (Open-Meteo)', () => {
    it('geocodes, then reads the forecast: current + today + tomorrow, only the two Open-Meteo hosts', async () => {
        const urls: string[] = []
        const result = await fetchWeather('Wien', async url => { urls.push(url); return url.includes('geocoding-api.open-meteo.com') ? GEO : FORECAST })
        expect(result.success).toBe(true)
        expect(urls).toHaveLength(2)
        expect(urls[0]).toMatch(/^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/)
        expect(urls[1]).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/)
        expect(result.aktuell).toMatchObject({ wetter: 'bedeckt', temperaturC: 14.2 })
        expect(result.morgen).toMatchObject({ wetter: 'leichter Regen', regenwahrscheinlichkeitProzent: 70 })
        expect(result.zusammenfassung).toMatch(/Jetzt in Wien.*14,?\.?2? ?°C|Jetzt in Wien/)
        expect(result.zusammenfassung).toMatch(/Morgen: leichter Regen, 9 bis 15 °C/)
    })

    it('unknown place and failing network are honest, never thrown', async () => {
        expect((await fetchWeather('Nirgendwostadt', async () => ({ results: [] }))).error).toMatch(/nicht gefunden/)
        expect((await fetchWeather('Wien', async () => { throw new Error('offline') })).error).toMatch(/nicht abrufen/)
        expect((await fetchWeather('  ', async () => GEO)).error).toMatch(/Welchen Ort|Für welchen Ort/)
    })

    it('does not touch the network in tests/CI without an injected client', async () => {
        const result = await fetchWeather('Wien')
        expect(result.success).toBe(false)
    })

    it('weather codes are German', () => {
        expect(weatherCodeText(0)).toBe('klar')
        expect(weatherCodeText(95)).toBe('Gewitter')
    })
})

describe('weather routing and budget', () => {
    it.each(['Wie ist das Wetter in Wien?', 'Regnet es morgen in Salzburg?', 'Wie spät ist es und wie ist das Wetter in Wien?', 'Wettervorhersage für das Wochenende'])(
        'offers weather for: %s', request => {
            expect(getRelevantTools(request).map(tool => tool.name)).toContain('weather')
        })

    it('does not offer weather for unrelated requests', () => {
        expect(getRelevantTools('Zeig mir die Dateien im Ordner Projekte').map(tool => tool.name)).not.toContain('weather')
    })

    it('a two-part request gets the budget per part (16 instead of 8); a single task keeps 8', () => {
        expect(selectContextPolicy('Wie spät ist es und wie ist das Wetter in Wien?').executionBudget.maxToolCalls).toBeGreaterThanOrEqual(16)
        expect(selectContextPolicy('Wie spät ist es?').executionBudget.maxToolCalls).toBe(8)
    })
})
