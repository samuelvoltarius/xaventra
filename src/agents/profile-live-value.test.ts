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

// 2.89.15 (Abnahme 2.89.14, 29.10. 11:28:04): the reply cited a stale BYD km range; the guard replaced it with the
// freshest entity of any kind - sensor.pv_surplus_km ("Strom & PV Ueberschuss als Reichweite: 14.8 km") - and listed
// every stale entity (5220 chars). A replacement must belong to the asked vehicle (profile terms) and be of the same
// kind; the list of stale values stays short.
describe('a replacement value belongs to the asked entity', () => {
    const at = (iso: string) => ({ last_changed: iso, last_updated: iso })
    const get = (entity: unknown) => ({ toolName: 'hass_get', success: true, result: JSON.stringify({ entity }) })
    const now = Date.parse('2026-10-29T10:28:00Z')
    const staleRange = { entity_id: 'sensor.byd_dolphin_surf_seagull_comfort_design_echte_reichweite', state: '180', attributes: { friendly_name: 'BYD Dolphin Surf Echte Reichweite', unit_of_measurement: 'km' }, ...at('2026-10-28T16:44:00Z') }
    const pvSurplus = { entity_id: 'sensor.pv_surplus_km', state: '14.8', attributes: { friendly_name: 'Strom & PV Ueberschuss als Reichweite', unit_of_measurement: 'km' }, ...at('2026-10-29T10:27:00Z') }
    const staleMany = Array.from({ length: 12 }, (_, i) => ({ entity_id: `sensor.byd_dolphin_old_${i}`, state: 'unavailable', attributes: { friendly_name: `BYD Dolphin Surf Alt ${i}` }, ...at('2026-10-28T16:44:00Z') }))

    it('never presents an unrelated fresh sensor as the vehicle value', () => {
        const out = guardLiveValueReply({ question, reply: 'Der Dolphin hat noch 180 km Reichweite.', executions: [get(staleRange), get(pvSurplus), ...staleMany.map(get)], now })
        expect(out ?? '').not.toMatch(/PV Ueberschuss|14\.8/)
        expect(String(out).length).toBeLessThan(600)
        expect(out).toMatch(/Stand vor|nicht aktuell/)
    })
})
