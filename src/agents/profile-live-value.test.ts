import { describe, expect, it } from 'vitest'
import { liveValueQuestion, normalizeOwnerProfile } from '../memory/owner-profile.js'
import { guardLiveValueReply, profileLiveValuePlan } from './profile-live-value.js'

const profile = normalizeOwnerProfile({
    version: 1, owner: { name: 'Max Muster' },
    entities: [
        { name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: [] },
        { name: 'Bello', kind: 'dog', aliases: [], facts: [] },
    ], rules: [],
})!
const question = liveValueQuestion(profile, 'Wie viel Akku hat der Dolphin?')!

describe('liveValueQuestion', () => {
    it.each(['Wie viel Akku hat der Dolphin?', 'Wie ist der Ladestand vom Dolphin', 'Reichweite vom Dolphin?', 'Ist der Dolphin abgeschlossen?', 'Wo steht der Dolphin?'])('"%s" asks a live value', text => {
        expect(liveValueQuestion(profile, text)?.entity.name).toBe('BYD Dolphin Surf')
    })
    it.each(['Was ist Dolphin?', 'Wie viel Akku hat das Handy?', 'Wie ist der Status von Bello?', 'Erzähl mir etwas über den Dolphin'])('"%s" is not one', text => {
        expect(liveValueQuestion(profile, text)).toBeNull()
    })
    it('is not offered to non-owners or without hass_list', () => {
        const base = { content: 'Wie viel Akku hat der Dolphin?', internal: false, hasImage: false, constrained: false, profile }
        expect(profileLiveValuePlan({ ...base, permission: 'guest', tools: [{ name: 'hass_list' }] })).toBeNull()
        expect(profileLiveValuePlan({ ...base, permission: 'owner', tools: [] })).toBeNull()
        expect(profileLiveValuePlan({ ...base, permission: 'owner', tools: [{ name: 'hass_list' }] })?.calls[0].arguments).toEqual({ match: 'BYD Dolphin Surf|Dolphin' })
    })
})

describe('guardLiveValueReply', () => {
    const list = (entities: unknown[]) => ({ toolName: 'hass_list', success: true, result: JSON.stringify({ count: entities.length, entities }) })
    const car = { entity_id: 'sensor.car_battery', state: '64', attributes: { friendly_name: 'Car Akku', unit_of_measurement: '%' } }
    it('blocks a number without hass evidence', () => {
        expect(guardLiveValueReply({ question, reply: 'Der Dolphin hat 80 % Akku.', executions: [] })).toMatch(/keine Zahl/)
        expect(guardLiveValueReply({ question, reply: 'Der Dolphin hat 80 % Akku.', executions: [{ toolName: 'hass_list', success: false, result: 'x' }] })).toMatch(/keine Zahl/)
        expect(guardLiveValueReply({ question, reply: 'Ich kann das gerade nicht sagen.', executions: [] })).toBeNull()
    })
    it('lets a supported number through and replaces an unsupported one', () => {
        expect(guardLiveValueReply({ question, reply: 'Der Dolphin hat 64 % Akku.', executions: [list([car])] })).toBeNull()
        expect(guardLiveValueReply({ question, reply: 'Der Dolphin hat 80 % Akku.', executions: [list([car])] })).toBe('Laut Home Assistant: Car Akku: 64 %.')
    })
    it('says honestly when Home Assistant has no entity', () => {
        expect(guardLiveValueReply({ question, reply: 'Welches Gerät meinst du?', executions: [list([])] })).toMatch(/keine Entität/)
    })
})

describe('profile Home Assistant binding', () => {
    const bound = normalizeOwnerProfile({
        version: 1, owner: { name: 'Max Muster' },
        entities: [{ name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: [],
            ha: { entities: { Akku: 'sensor.example_123_state_of_charge', Reichweite: 'sensor.example_123_ev_range', Bad: 'not an id' }, maxAgeMinutes: 90 } }], rules: [],
    })!
    it('normalises the binding and drops invalid ids', () => {
        expect(bound.entities[0].ha).toEqual({ entities: { Akku: 'sensor.example_123_state_of_charge', Reichweite: 'sensor.example_123_ev_range' }, maxAgeMinutes: 90 })
    })
    it('picks the bound entity by attribute or synonym, otherwise falls back to the search', () => {
        expect(liveValueQuestion(bound, 'Wie voll ist der Akku vom Dolphin?')?.binding?.entityId).toBe('sensor.example_123_state_of_charge')
        expect(liveValueQuestion(bound, 'Wie ist der Ladestand vom Dolphin?')?.binding?.entityId).toBe('sensor.example_123_state_of_charge')
        expect(liveValueQuestion(bound, 'Wie groß ist die Reichweite vom Dolphin?')?.binding?.entityId).toBe('sensor.example_123_ev_range')
        expect(liveValueQuestion(bound, 'Wo steht der Dolphin?')?.binding).toBeUndefined()
        expect(liveValueQuestion(bound, 'Wie voll ist der Akku vom Dolphin?')?.maxAgeMinutes).toBe(90)
    })
    it('plans hass_get on the bound id', () => {
        const plan = profileLiveValuePlan({ content: 'Akku vom Dolphin?', permission: 'owner', internal: false, hasImage: false, constrained: false, tools: [{ name: 'hass_get' }, { name: 'hass_list' }], profile: bound })
        expect(plan?.calls).toEqual([{ name: 'hass_get', arguments: { entity_id: 'sensor.example_123_state_of_charge' } }])
    })
})

// 2.89.14 (Abnahme 2.89.13, 29.10. 03:12): hass_get read sensor.byd_soc = 50 (last update 28.10. 16:44, stale)
// and sensor.surfmate_138222_state_of_charge = 99 (23:41, fresh). The reply gave 50 % as the current value and
// called the 99 % "another vehicle"; because it cited the fresh value too, the staleness guard let it pass.
describe('a stale value is not stated as current when the reply also mentions a fresh one', () => {
    const at = (iso: string) => ({ last_changed: iso, last_updated: iso })
    const get = (entity: unknown) => ({ toolName: 'hass_get', success: true, result: JSON.stringify({ entity }) })
    const stale = { entity_id: 'sensor.byd_soc', state: '50.0', attributes: { friendly_name: 'BYD Dolphin Surf Ladezustand', unit_of_measurement: '%' }, ...at('2026-10-28T15:44:00Z') }
    const fresh = { entity_id: 'sensor.surfmate_138222_state_of_charge', state: '99.0', attributes: { friendly_name: 'Panoptes Vehicle State of Charge', unit_of_measurement: '%', device_class: 'battery' }, ...at('2026-10-28T22:41:00Z') }
    const charger = { entity_id: 'sensor.surfmate_138222_charger_state', state: '1', attributes: { friendly_name: 'Panoptes Vehicle Charger State' }, ...at('2026-10-29T02:10:00Z') }
    const now = Date.parse('2026-10-29T02:12:30Z')

    it('replaces it with the fresh comparable value and names the stale one', () => {
        const reply = 'Der Dolphin hat 50 % Akku. Die 99 % gehören zu einem anderen Fahrzeug (Panoptes).'
        const out = guardLiveValueReply({ question, reply, executions: [get(stale), get(fresh), get(charger)], now })
        expect(out).toMatch(/Aktuell laut Home Assistant: Panoptes Vehicle State of Charge: 99\.0 %/)
        expect(out).toMatch(/BYD Dolphin Surf Ladezustand“: Stand vor 10 Stunden/)
    })

    it('a reply that already gives the fresh value with the age of the old one passes', () => {
        const reply = 'Laut Panoptes 99 %. Der BYD-Sensor zeigt 50 %, Stand vor 10 Stunden.'
        expect(guardLiveValueReply({ question, reply, executions: [get(stale), get(fresh)], now })).toBeNull()
    })
})
