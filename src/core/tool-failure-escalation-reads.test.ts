import { describe, expect, it } from 'vitest'
import { escalationWithCompletedEffects } from './tool-failure-escalation.js'
import { guardLiveValueReply } from '../agents/profile-live-value.js'
import { liveValueQuestion, normalizeOwnerProfile } from '../memory/owner-profile.js'

// 2.90.1 (live 29.10. 14:01:39-14:02:28): the first hass_get answered correctly
// "sensor.example_123_state_of_charge: 97.0 %", then hass_list/hass_get failed with 404 and the reply was
// "Die Aktion ist nicht gelungen … es wurde keine Änderung ausgeführt" plus a stale list "… und 92 weitere".
// A result the run did get is never pushed out by a later failure; the stale list names only the asked entity.
const ESCALATION = 'Die Aktion ist nicht gelungen. Ich habe die Ursache intern zur Prüfung vorgemerkt; es wurde keine Änderung ausgeführt.'
const tools = [
    { name: 'hass_get', parameters: [{ name: 'entity_id' }] },
    { name: 'hass_list', parameters: [{ name: 'match' }] },
]
const now = Date.parse('2026-10-29T13:02:00Z')
const at = (iso: string) => ({ last_changed: iso, last_updated: iso })
const soc = { entity_id: 'sensor.example_123_state_of_charge', state: '97.0', attributes: { friendly_name: 'Surfmate State of charge', unit_of_measurement: '%' }, ...at('2026-10-29T12:58:00Z') }
const staleOther = Array.from({ length: 95 }, (_, i) => ({ entity_id: `sensor.other_${i}`, state: '1', attributes: { friendly_name: `Anderer Sensor ${i}` }, ...at('2026-10-20T10:00:00Z') }))
const executions = [
    { toolName: 'hass_get', params: { entity_id: soc.entity_id }, success: true, result: { formatted: 'x', entity: soc } },
    { toolName: 'hass_list', params: { match: 'Dolphin' }, success: true, result: JSON.stringify({ count: staleOther.length, entities: staleOther }) },
    { toolName: 'hass_list', params: { match: 'byd' }, success: false, result: 'HTTP 404' },
    { toolName: 'hass_get', params: { entity_id: 'sensor.byd_soc' }, success: false, result: 'HTTP 404' },
]
const profile = normalizeOwnerProfile({
    version: 1, owner: { name: 'Max Muster' },
    entities: [{ name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: [], ha: { entities: { Akku: soc.entity_id } } }], rules: [],
})!

describe('a later failure never pushes out a result the run did get', () => {
    it('names the value read before the failure', () => {
        const text = escalationWithCompletedEffects(ESCALATION, executions, tools)
        expect(text).toContain('97.0 %')
        expect(text).not.toMatch(/Die Aktion ist nicht gelungen/)
        expect(text).toMatch(/später/)
    })

    it('the live value guard keeps the value and lists no unrelated stale sensors', () => {
        const question = liveValueQuestion(profile, 'Wie voll ist der Akku vom Dolphin?')!
        const reply = escalationWithCompletedEffects(ESCALATION, executions, tools)
        const out = guardLiveValueReply({ question, reply, executions, now }) ?? reply
        expect(out).toContain('97.0 %')
        expect(out).not.toMatch(/weitere|Anderer Sensor/)
    })
})
