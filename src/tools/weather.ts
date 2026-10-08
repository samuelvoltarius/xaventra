/**
 * 2.89.3 `weather`: Wetter ohne Schluessel ueber Open-Meteo (https://open-meteo.com).
 *
 * Live 08.10.2026: "Wie spaet ist es und wie ist das Wetter in Wien?" fand kein Wetter-Werkzeug,
 * das Modell wich auf web_search/run_command aus und lief ins Tool-Budget. Dieses Werkzeug liefert
 * die aktuelle Lage plus heute/morgen in zwei Abrufen (Geocoding + Vorhersage). Beide Abrufe laufen
 * ueber den SSRF-geprueften HTTP-Client (resilience/ssrf-guard); nur die zwei festen Open-Meteo-Hosts.
 * Nur lesend, keine Konfiguration noetig.
 */
import type { NovaTool } from './complete-registry.js'
import { getToolAbortSignal } from '../core/tool-abort-scope.js'

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const MAX_BYTES = 256_000
const TIMEOUT_MS = 10_000

export type WeatherJsonFetch = (url: string) => Promise<unknown>

/** WMO weather codes as Open-Meteo reports them. */
export function weatherCodeText(code: number): string {
    if (code === 0) return 'klar'
    if (code === 1) return 'überwiegend klar'
    if (code === 2) return 'teils bewölkt'
    if (code === 3) return 'bedeckt'
    if (code === 45 || code === 48) return 'Nebel'
    if (code >= 51 && code <= 57) return 'Nieselregen'
    if (code === 61 || code === 80) return 'leichter Regen'
    if (code === 63 || code === 81) return 'Regen'
    if (code === 65 || code === 82) return 'starker Regen'
    if (code === 66 || code === 67) return 'gefrierender Regen'
    if (code === 71 || code === 85) return 'leichter Schneefall'
    if (code === 73) return 'Schneefall'
    if (code === 75 || code === 86) return 'starker Schneefall'
    if (code === 77) return 'Schneegriesel'
    if (code === 95) return 'Gewitter'
    if (code === 96 || code === 99) return 'Gewitter mit Hagel'
    return 'wechselhaft'
}

async function defaultFetchJson(url: string): Promise<unknown> {
    const { sideEffectsDisabled } = await import('../core/side-effects.js')
    if (sideEffectsDisabled()) throw new Error('Netzabruf in Tests/CI aus')
    const { fetchWithSsrfGuard } = await import('../resilience/ssrf-guard.js')
    const parent = getToolAbortSignal()
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
    const response = await fetchWithSsrfGuard(url, { headers: { accept: 'application/json' }, redirect: 'error', signal })
    if (!response.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_BYTES) throw new Error('Antwort zu groß')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_BYTES) throw new Error('Antwort zu groß')
    return JSON.parse(body.toString('utf8'))
}

const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const round = (value: number | undefined, digits = 0): number | undefined => value === undefined ? undefined : Math.round(value * 10 ** digits) / 10 ** digits

export interface WeatherResult {
    success: boolean
    error?: string
    ort?: string
    aktuell?: Record<string, unknown>
    heute?: Record<string, unknown>
    morgen?: Record<string, unknown>
    zusammenfassung?: string
    quelle?: string
}

function dayLine(label: string, day: Record<string, unknown> | undefined): string {
    if (!day) return ''
    const parts = [`${label}: ${day.wetter}`]
    if (day.min !== undefined && day.max !== undefined) parts.push(`${day.min} bis ${day.max} °C`)
    if (day.regenwahrscheinlichkeitProzent !== undefined) parts.push(`Regenwahrscheinlichkeit ${day.regenwahrscheinlichkeitProzent} %`)
    if (day.niederschlagMm !== undefined && Number(day.niederschlagMm) > 0) parts.push(`${day.niederschlagMm} mm Niederschlag`)
    return parts.join(', ')
}

/** Current conditions plus today and tomorrow for a place name. Never throws. */
export async function fetchWeather(ort: string, fetchJson: WeatherJsonFetch = defaultFetchJson): Promise<WeatherResult> {
    const name = String(ort || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!name) return { success: false, error: 'Für welchen Ort soll ich das Wetter nachsehen?' }
    try {
        const geo: any = await fetchJson(`${GEOCODING_URL}?${new URLSearchParams({ name, count: '1', language: 'de', format: 'json' })}`)
        const place = Array.isArray(geo?.results) ? geo.results[0] : undefined
        const latitude = num(place?.latitude), longitude = num(place?.longitude)
        if (latitude === undefined || longitude === undefined) return { success: false, error: `Den Ort „${name}“ habe ich nicht gefunden.` }
        const data: any = await fetchJson(`${FORECAST_URL}?${new URLSearchParams({
            latitude: String(latitude), longitude: String(longitude), timezone: 'auto', forecast_days: '2', wind_speed_unit: 'kmh',
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
        })}`)
        const current = data?.current
        if (!current || num(current.temperature_2m) === undefined) return { success: false, error: 'Open-Meteo hat keine aktuellen Wetterdaten geliefert.' }
        const label = [place.name, place.admin1 && place.admin1 !== place.name ? place.admin1 : '', place.country].filter(Boolean).join(', ')
        const day = (index: number): Record<string, unknown> | undefined => {
            const daily = data?.daily
            const code = num(daily?.weather_code?.[index])
            if (code === undefined) return undefined
            return {
                datum: String(daily?.time?.[index] ?? ''),
                wetter: weatherCodeText(code),
                min: round(num(daily?.temperature_2m_min?.[index])),
                max: round(num(daily?.temperature_2m_max?.[index])),
                regenwahrscheinlichkeitProzent: round(num(daily?.precipitation_probability_max?.[index])),
                niederschlagMm: round(num(daily?.precipitation_sum?.[index]), 1),
            }
        }
        const aktuell = {
            wetter: weatherCodeText(num(current.weather_code) ?? -1),
            temperaturC: round(num(current.temperature_2m), 1),
            gefuehltC: round(num(current.apparent_temperature), 1),
            luftfeuchteProzent: round(num(current.relative_humidity_2m)),
            windKmh: round(num(current.wind_speed_10m)),
            niederschlagMm: round(num(current.precipitation), 1),
            zeit: String(current.time ?? ''),
        }
        const heute = day(0), morgen = day(1)
        const zusammenfassung = [
            `Jetzt in ${label}: ${aktuell.wetter}, ${aktuell.temperaturC} °C (gefühlt ${aktuell.gefuehltC} °C), Wind ${aktuell.windKmh} km/h.`,
            dayLine('Heute', heute), dayLine('Morgen', morgen),
        ].filter(Boolean).join(' ')
        return { success: true, ort: label, aktuell, ...(heute ? { heute } : {}), ...(morgen ? { morgen } : {}), zusammenfassung, quelle: 'Open-Meteo (open-meteo.com)' }
    } catch (error) {
        return { success: false, error: `Das Wetter konnte ich gerade nicht abrufen (${String((error as Error)?.message || error).slice(0, 120)}).` }
    }
}

export const weatherTool: NovaTool = {
    name: 'weather', category: 'other',
    description: 'Aktuelles Wetter und Vorhersage für heute und morgen für einen Ort (Temperatur, Regen, Wind) über Open-Meteo, ohne Schlüssel. Für jede Wetterfrage dieses Werkzeug nehmen, nicht die Websuche und nicht die Shell.',
    parameters: [
        { name: 'ort', type: 'string', required: false, description: 'Ortsname, z. B. „Wien“ oder „Salzburg“. Ohne Angabe gilt der eingestellte Standardort (WEATHER_CITY).' },
    ],
    handler: async (params: Record<string, unknown>) => fetchWeather(String(params.ort || process.env.WEATHER_CITY || '')),
}
