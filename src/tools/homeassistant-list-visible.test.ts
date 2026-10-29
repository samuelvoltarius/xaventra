import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Telegram 28.10. (2.89.11) "Welche Lichter sind an?": 6× hass_list + 5× hass_get until the tool
// budget ran out, no answer. hass_list showed 5 lights per domain ("… +4 weitere") and carried every
// entity with all attributes; TokenKiller cut the JSON at 3500 chars (live "2679 → 1010 tokens"),
// so the lights that were on (Flur, Küche) never reached the model. What the model gets after the
// real compression must name every listed entity with its state.
const now = Date.parse('2026-10-28T21:03:45+01:00')
const attrs = (name: string) => ({
    friendly_name: name, supported_color_modes: ['color_temp', 'xy'], color_mode: null, min_color_temp_kelvin: 2202,
    max_color_temp_kelvin: 6535, min_mireds: 153, max_mireds: 454, effect_list: ['blink', 'breathe', 'okay', 'channel_change', 'candle', 'fireplace', 'colorloop', 'finish_effect', 'stop_effect', 'stop_hue_effect'],
    brightness: null, color_temp_kelvin: null, color_temp: null, hs_color: null, rgb_color: null, xy_color: null, effect: null,
    off_with_transition: false, off_brightness: null, icon: 'mdi:lightbulb', supported_features: 44,
})
const light = (id: string, name: string, state: string) => ({ entity_id: id, state, attributes: attrs(name), last_changed: new Date(now - 3_600_000).toISOString(), last_updated: new Date(now - 3_600_000).toISOString() })
const LIGHTS = [
    light('light.schlafzimmer', 'Schlafzimmer', 'unavailable'),
    light('light.sofa', 'Sofa', 'off'),
    light('light.flur_wohnzimmer', 'Wohnzimmer', 'unavailable'),
    light('light.kueche_decke', 'Küche', 'unavailable'),
    light('light.gamingzimmer_gamingzimmer', 'Gamingzimmer', 'off'),
    light('light.wohnzimmer_2', 'Wohnzimmer', 'unavailable'),
    light('light.kueche_insel', 'Küche', 'on'),
    light('light.schlafzimmer_2', 'Schlafzimmer', 'unavailable'),
    light('light.flur', 'Flur', 'on'),
]

let hass: typeof import('./homeassistant.js')
beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hass-list-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify({ homeassistant: { url: 'http://192.0.2.9:8123', token: 'fixture-token' } }))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.stubEnv('HASS_URL', 'http://192.0.2.9:8123')
    vi.stubEnv('HASS_TOKEN', 'fixture-token')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(LIGHTS), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.resetModules()
    hass = await import('./homeassistant.js')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

async function modelView(params: Record<string, unknown>): Promise<string> {
    const tool = hass.homeAssistantTools.find(entry => entry.name === 'hass_list')!
    const raw = JSON.stringify(await tool.handler(params), null, 2)
    const { compressToolOutput } = await import('../intelligence/token-killer.js')
    const compressed = compressToolOutput('hass_list', 'hass_list', raw)
    return compressed.savings > 20 ? compressed.compressed : raw
}

describe('hass_list: every entity reaches the model', () => {
    it('lists all 9 lights with entity id and state after the real compression', async () => {
        const seen = await modelView({ domain: 'light' })
        for (const entity of LIGHTS) expect(seen).toContain(`${entity.entity_id}): ${entity.state}`)
        expect(seen).not.toMatch(/weitere/)
    })

    it('state filter answers "which are on" in one call', async () => {
        const tool = hass.homeAssistantTools.find(entry => entry.name === 'hass_list')!
        const result: any = await tool.handler({ domain: 'light', state: 'on' })
        expect(result.count).toBe(2)
        expect(result.entities.map((entity: any) => entity.entity_id)).toEqual(['light.kueche_insel', 'light.flur'])
    })

    it('keeps the fields the live-value check reads (state, unit, friendly name, timestamps)', async () => {
        const tool = hass.homeAssistantTools.find(entry => entry.name === 'hass_list')!
        const result: any = await tool.handler({ domain: 'light' })
        expect(result.entities[0]).toEqual({
            entity_id: 'light.schlafzimmer', state: 'unavailable', attributes: { friendly_name: 'Schlafzimmer' },
            last_changed: LIGHTS[0].last_changed, last_updated: LIGHTS[0].last_updated,
        })
    })
})

// 2.89.14 (Kurzabnahme 29.10. 03:36): hass_get carried last_changed in UTC ("2026-10-29T02:32:03Z") and the
// answer said "Bestätigung um 02:32 Uhr" although it was 03:32 local time.
describe('Home Assistant times are given in local time', () => {
    it('hass_get names the last change in the system time zone', async () => {
        const previous = process.env.TZ
        process.env.TZ = 'Europe/Vienna'
        try {
            const entity = { entity_id: 'switch.k1_max_steckdose', state: 'on', attributes: { friendly_name: 'K1 Max Steckdose' }, last_changed: '2026-10-29T02:32:03.123Z', last_updated: '2026-10-29T02:32:03.123Z' }
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(entity), { status: 200, headers: { 'content-type': 'application/json' } })))
            const tool = hass.homeAssistantTools.find(entry => entry.name === 'hass_get')!
            const result: any = await tool.handler({ entity_id: 'switch.k1_max_steckdose' })
            expect(result.formatted).toContain('03:32')
            expect(result.formatted).not.toContain('02:32')
        } finally {
            if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous
        }
    })
})
