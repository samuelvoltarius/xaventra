import { describe, expect, it } from 'vitest'
import { escalationWithCompletedEffects } from './tool-failure-escalation.js'

// 2.89.15 (Abnahme 2.89.14, 29.10. 11:28:58): hass_turn_on {"success":true} switched the K1 socket on (HA read back),
// then printer_info failed ("Drucker nicht konfiguriert"), the run stopped and the failure escalation answered
// "Die Aktion ist nicht gelungen … es wurde keine Änderung ausgeführt" - false. A successful action is never
// reported as "keine Änderung".
const ESCALATION = 'Die Aktion ist nicht gelungen. Ich habe die Ursache intern zur Prüfung vorgemerkt; es wurde keine Änderung ausgeführt.'
const tools = [
    { name: 'hass_get', parameters: [{ name: 'entity_id' }] },
    { name: 'hass_turn_on', parameters: [{ name: 'entity_id' }, { name: 'confirm' }] },
    { name: 'printer_info', parameters: [] },
]

describe('a failure escalation names the actions that did happen', () => {
    it('names the successful switch and drops "keine Änderung"', () => {
        const text = escalationWithCompletedEffects(ESCALATION, [
            { toolName: 'hass_get', params: { entity_id: 'switch.k1_max_steckdose' }, success: true },
            { toolName: 'hass_turn_on', params: { entity_id: 'switch.k1_max_steckdose', confirm: 'code' }, success: true },
            { toolName: 'printer_info', params: {}, success: false },
        ], tools)
        expect(text).toContain('hass_turn_on')
        expect(text).toContain('switch.k1_max_steckdose')
        expect(text).not.toMatch(/keine Änderung/)
        expect(text).not.toContain('code')
    })

    it('without a successful action the escalation stays as it is', () => {
        expect(escalationWithCompletedEffects(ESCALATION, [{ toolName: 'printer_info', params: {}, success: false }, { toolName: 'hass_get', params: {}, success: true }], tools)).toBe(ESCALATION)
    })
})
