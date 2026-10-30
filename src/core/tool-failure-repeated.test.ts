import { describe, expect, it } from 'vitest'
import { repeatedFailureNote } from './tool-failure-escalation.js'

// 2.90.4: only the SAME failure twice blocks a third call of the SAME tool; ids and numbers do not make it "new".
describe('repeatedFailureNote', () => {
    const fail = (toolName: string, result: string) => ({ toolName, success: false, result })
    it('blocks after two identical failures, ids and numbers ignored', () => {
        expect(repeatedFailureNote([fail('mesh_delegate', 'Knoten xaventra-ns1 nicht erreichbar (req-1a2b3c4d5e)'), fail('mesh_delegate', 'Knoten xaventra-ns1 nicht erreichbar (req-9f8e7d6c5b)')], 'mesh_delegate')).toMatch(/nicht erneut ausgeführt/)
    })
    it('lets different failures, one failure, successes and other tools through', () => {
        expect(repeatedFailureNote([fail('mesh_delegate', 'nicht erreichbar'), fail('mesh_delegate', 'abgelehnt: Werkzeuge')], 'mesh_delegate')).toBeNull()
        expect(repeatedFailureNote([fail('mesh_delegate', 'nicht erreichbar')], 'mesh_delegate')).toBeNull()
        expect(repeatedFailureNote([{ toolName: 'mesh_delegate', success: true, result: 'ok' }, { toolName: 'mesh_delegate', success: true, result: 'ok' }], 'mesh_delegate')).toBeNull()
        expect(repeatedFailureNote([fail('hass_get', 'HTTP 404'), fail('hass_get', 'HTTP 404')], 'mesh_delegate')).toBeNull()
    })
})
