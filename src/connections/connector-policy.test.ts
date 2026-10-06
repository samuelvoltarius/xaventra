import { describe, expect, it } from 'vitest'
import { cloudPrivacyRefusal, connectorToolVerdict, toolCapability, type ConnectorBinding } from './connector-policy.js'

const calendar: ConnectorBinding = {
    connectorId: 'google-calendar', trust: 'geprueft', datenklasse: 'cloud',
    capabilities: { list_events: 'lesen', create_event: 'schreiben', delete_event: 'loeschen', respond_to_event: 'senden' },
}
const ha: ConnectorBinding = { connectorId: 'home-assistant', trust: 'geprueft', datenklasse: 'lokal', capabilities: { GetLiveContext: 'lesen', intent__HassTurnOn: 'schalten' } }
const community: ConnectorBinding = { connectorId: 'io.example/wetter', trust: 'community', datenklasse: 'cloud' }

describe('MCP tool → action policy (2.85 Paket A, Punkt 3)', () => {
    it('manifest capabilities map to the policy levels: lesen L0, schreiben/senden/schalten L2 card, löschen stays Nie-Liste', () => {
        expect(connectorToolVerdict({ name: 'list_events' }, calendar)).toMatchObject({ capability: 'lesen', verdict: { level: 'L0', decision: 'auto' }, sichtbar: true })
        expect(connectorToolVerdict({ name: 'create_event' }, calendar)).toMatchObject({ capability: 'schreiben', verdict: { level: 'L2', decision: 'ask' } })
        expect(connectorToolVerdict({ name: 'respond_to_event' }, calendar)).toMatchObject({ capability: 'senden', verdict: { level: 'L2', impact: 'extern' } })
        expect(connectorToolVerdict({ name: 'intent__HassTurnOn' }, ha)).toMatchObject({ capability: 'schalten', verdict: { level: 'L2', impact: 'physisch' } })
        // "Löschen von Daten" is on the Nie-Liste (unchanged): never automatic, never a button.
        expect(connectorToolVerdict({ name: 'delete_event' }, calendar)).toMatchObject({ capability: 'loeschen', verdict: { level: 'L3' } })
    })

    it('unknown tools without annotations ask (card), never run on their own', () => {
        expect(connectorToolVerdict({ name: 'GetWeather' }, ha)).toMatchObject({ capability: 'unbekannt', verdict: { level: 'L2', decision: 'ask' } })
    })

    it('annotations are used when the manifest is silent, but a server cannot talk a writing tool down', () => {
        expect(toolCapability({ name: 'get_forecast', annotations: { readOnlyHint: true } }, community)).toBe('lesen')
        expect(toolCapability({ name: 'update_note', annotations: { readOnlyHint: false, destructiveHint: false } }, community)).toBe('schreiben')
        expect(toolCapability({ name: 'anything', annotations: { readOnlyHint: false } }, community)).toBe('schreiben')
        // readOnlyHint is only a hint from an untrusted server: the name raises it again.
        expect(toolCapability({ name: 'send_message', annotations: { readOnlyHint: true } }, community)).toBe('senden')
        expect(toolCapability({ name: 'delete_all', annotations: { readOnlyHint: true } }, community)).toBe('loeschen')
        // A checked manifest saying "lesen" is still raised by an obviously writing name.
        expect(toolCapability({ name: 'create_event' }, { ...calendar, capabilities: { create_event: 'lesen' } })).toBe('schreiben')
    })

    it('community connectors expose only reading tools until the owner allows one tool explicitly', () => {
        expect(connectorToolVerdict({ name: 'get_forecast', annotations: { readOnlyHint: true } }, community).sichtbar).toBe(true)
        expect(connectorToolVerdict({ name: 'set_alarm', annotations: { readOnlyHint: false } }, community).sichtbar).toBe(false)
        expect(connectorToolVerdict({ name: 'mystery' }, community).sichtbar).toBe(false)
        const granted = connectorToolVerdict({ name: 'set_alarm', annotations: { readOnlyHint: false } }, { ...community, erlaubteWerkzeuge: ['set_alarm'] })
        expect(granted.sichtbar).toBe(true)
        // Allowed to exist is not allowed to run: every call still asks.
        expect(granted.verdict.decision).toBe('ask')
    })

    it('2.88: an unknown directory entry (streng) shows reading tools but every call asks, also reads', () => {
        const strict = { ...community, streng: true }
        const read = connectorToolVerdict({ name: 'get_forecast', annotations: { readOnlyHint: true } }, strict)
        expect(read).toMatchObject({ sichtbar: true, verdict: { decision: 'ask' } })
        expect(connectorToolVerdict({ name: 'set_alarm', annotations: { readOnlyHint: false } }, strict).sichtbar).toBe(false)
        const granted = connectorToolVerdict({ name: 'set_alarm', annotations: { readOnlyHint: false } }, { ...strict, erlaubteWerkzeuge: ['set_alarm'] })
        expect(granted).toMatchObject({ sichtbar: true, verdict: { decision: 'ask' } })
    })

    it('cloud connectors get nothing private; local ones are not restricted', () => {
        expect(cloudPrivacyRefusal({ query: 'Termine nächste Woche' }, calendar)).toBeNull()
        expect(cloudPrivacyRefusal({ query: 'Kundendaten von Müller und seine Telefonnummer' }, calendar)).toMatch(/Privates/)
        expect(cloudPrivacyRefusal({ note: { text: 'mein Tagebuch' } }, community)).toMatch(/Privates/)
        expect(cloudPrivacyRefusal({ query: 'Kundendaten' }, ha)).toBeNull()
    })
})
