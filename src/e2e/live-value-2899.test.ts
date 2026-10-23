/**
 * 2.89.9 over the real entry (only the model is scripted; fake profile, fake Home Assistant on example.com):
 * a live value of a profile vehicle/device comes from Home Assistant in the same turn, never from memory.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness, type EnvironmentRoute } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 120_000

const PROFILE = {
    version: 1,
    owner: { name: 'Max Muster', nicknames: [], timezone: 'Europe/Vienna' },
    entities: [{ name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: ['Elektroauto, Akkustand über Home Assistant'] }],
    rules: [],
}
const seedProfile = (root: string) => {
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'owner-profile.json'), JSON.stringify(PROFILE, null, 2))
}
const state = (entity_id: string, value: string, attributes: Record<string, unknown>) =>
    ({ entity_id, state: value, attributes, last_changed: new Date(Date.now() - 60_000).toISOString(), last_updated: new Date(Date.now() - 60_000).toISOString() })
const haRoutes = (states: unknown[]): EnvironmentRoute[] => [{ match: /^http:\/\/ha\.example\.com:8123\/api\/states$/, respond: () => ({ json: states }) }]
const haConfig = { homeassistant: { url: 'http://ha.example.com:8123', token: 'fake-token-for-tests' } }

const WITH_CAR = [
    state('sensor.byd_dolphin_surf_battery', '64', { friendly_name: 'BYD Dolphin Surf Akku', unit_of_measurement: '%' }),
    state('light.wohnzimmer', 'on', { friendly_name: 'Wohnzimmer' }),
]

describe('2.89.9: live values of profile vehicles come from Home Assistant', () => {
    it('a scripted "80 %" without evidence is not delivered; the Home Assistant value 64 % is', async () => {
        h = await createE2EHarness({ seed: seedProfile, config: haConfig, routes: haRoutes(WITH_CAR) })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 80 % Akku (12,4 V).' }])
        expect(result.error).toBeUndefined()
        expect(result.offeredTools).toEqual(expect.arrayContaining(['hass_list']))
        expect(result.executedTools[0]).toBe('hass_list')
        expect(result.final).toContain('64 %')
        expect(result.final).not.toMatch(/80\s*%|12,4/)
    }, T)

    it('a correct model answer after the lookup is delivered unchanged', async () => {
        h = await createE2EHarness({ seed: seedProfile, config: haConfig, routes: haRoutes(WITH_CAR) })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat laut Home Assistant 64 % Akku.' }])
        expect(result.executedTools).toContain('hass_list')
        expect(result.final).toBe('Der Dolphin hat laut Home Assistant 64 % Akku.')
    }, T)

    it('without a matching Home Assistant entity the answer says so in one sentence', async () => {
        h = await createE2EHarness({ seed: seedProfile, config: haConfig, routes: haRoutes([state('light.wohnzimmer', 'on', { friendly_name: 'Wohnzimmer' })]) })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Meinst du einen Rechner, einen Roboter oder ein Handy?' }])
        expect(result.executedTools).toContain('hass_list')
        expect(result.final).toMatch(/keine Entität zu „BYD Dolphin Surf“/)
        expect(result.final).not.toMatch(/Rechner|Roboter|Handy|\d\s*%/)
    }, T)

    it('Home Assistant not reachable: a stated number is not delivered as fact', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 80 % Akku.' }])
        expect(result.final).not.toMatch(/80/)
        expect(result.final).toMatch(/nicht aus Home Assistant bestätigt/)
    }, T)

    it('"Was ist der Dolphin?" is answered from the profile without Home Assistant', async () => {
        h = await createE2EHarness({ seed: seedProfile, config: haConfig, routes: haRoutes(WITH_CAR) })
        const result = await h.telegram('Was ist Dolphin?', [])
        expect(result.final).toMatch(/Fahrzeug/)
        expect(result.executedTools).toEqual([])
        expect(h.blockedRequests).toEqual([])
    }, T)
})

// ---------------------------------------------------------------- follow-up: binding and staleness
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const timed = (entity_id: string, value: string, minutes: number, attributes: Record<string, unknown>) =>
    ({ entity_id, state: value, attributes, last_changed: ago(minutes), last_updated: ago(minutes) })
const FRESH = timed('sensor.example_123_state_of_charge', '64', 3, { friendly_name: 'Example App Vehicle State of Charge', unit_of_measurement: '%' })
const STALE = timed('sensor.byd_dolphin_surf_ladezustand', '41', 2 * 24 * 60, { friendly_name: 'BYD Dolphin Surf Ladezustand', unit_of_measurement: '%' })
const RANGE = timed('sensor.example_123_ev_range', '210', 4, { friendly_name: 'Example App Vehicle Range', unit_of_measurement: 'km' })
const seedBound = (ha: Record<string, unknown>) => (root: string) => {
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'owner-profile.json'), JSON.stringify({ ...PROFILE, entities: [{ ...PROFILE.entities[0], ha }] }, null, 2))
}
const getRoute = (id: string, entity: unknown): EnvironmentRoute => ({ match: new RegExp(`^http://ha\.example\.com:8123/api/states/${id}$`), respond: () => ({ json: entity }) })

describe('2.89.9 follow-up: explicit binding and stale values', () => {
    it('a bound attribute calls hass_get on exactly that entity and reports its value', async () => {
        h = await createE2EHarness({
            seed: seedBound({ entities: { Akku: 'sensor.example_123_state_of_charge', Reichweite: 'sensor.example_123_ev_range' } }), config: haConfig,
            routes: [getRoute('sensor.example_123_state_of_charge', FRESH), getRoute('sensor.example_123_ev_range', RANGE), ...haRoutes([FRESH, STALE, RANGE])],
        })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 64 % Akku.' }])
        expect(result.executedTools[0]).toBe('hass_get')
        expect(result.executedTools).not.toContain('hass_list')
        expect(result.final).toBe('Der Dolphin hat 64 % Akku.')
        const range = await h.telegram('Wie groß ist die Reichweite vom Dolphin?', [{ text: 'Die Reichweite beträgt 210 km.' }])
        expect(range.executedTools[0]).toBe('hass_get')
        expect(range.final).toContain('210 km')
    }, T)

    it('two matching entities without a binding: the fresh one is used, the frozen one is flagged', async () => {
        const fresh = { ...FRESH, entity_id: 'sensor.byd_dolphin_surf_state_of_charge' }
        h = await createE2EHarness({ seed: seedProfile, config: haConfig, routes: haRoutes([STALE, fresh, { ...RANGE, attributes: { friendly_name: 'Other' } }]) })
        const ok = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 64 % Akku.' }])
        expect(ok.executedTools[0]).toBe('hass_list')
        expect(ok.final).toContain('64 %')
        expect(ok.final).toMatch(/Stand vor 2 Tagen/)
        const frozen = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 41 % Akku.' }])
        expect(frozen.final).toContain('64 %')
        expect(frozen.final).toMatch(/Nicht aktuell ignoriert[^]*Stand vor 2 Tagen/)
    }, T)

    it('a stale bound entity: the answer states the age instead of a current value', async () => {
        h = await createE2EHarness({
            seed: seedBound({ entities: { Akku: 'sensor.byd_dolphin_surf_ladezustand' } }), config: haConfig,
            routes: [getRoute('sensor.byd_dolphin_surf_ladezustand', STALE)],
        })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 41 % Akku.' }])
        expect(result.executedTools[0]).toBe('hass_get')
        expect(result.final).toMatch(/Stand vor 2 Tagen: BYD Dolphin Surf Ladezustand: 41 %/)
        expect(result.final).toMatch(/nicht aktuell/)
    }, T)

    it('maxAgeMinutes of the profile sets the threshold; the claim guard still blocks unbacked numbers', async () => {
        h = await createE2EHarness({
            seed: seedBound({ entities: { Akku: 'sensor.example_123_state_of_charge' }, maxAgeMinutes: 1 }), config: haConfig,
            routes: [getRoute('sensor.example_123_state_of_charge', FRESH)],
        })
        const aged = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 64 % Akku.' }])
        expect(aged.final).toMatch(/Stand vor \d Minuten/)
        const invented = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Der Dolphin hat 80 % Akku (Stand vor 3 Minuten).' }])
        expect(invented.final).not.toMatch(/80/)
        expect(invented.final).toContain('64 %')
    }, T)
})
