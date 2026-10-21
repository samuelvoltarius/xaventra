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
    ({ entity_id, state: value, attributes, last_changed: '2026-10-21T08:00:00Z', last_updated: '2026-10-21T08:00:00Z' })
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
