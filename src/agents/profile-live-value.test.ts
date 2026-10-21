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
