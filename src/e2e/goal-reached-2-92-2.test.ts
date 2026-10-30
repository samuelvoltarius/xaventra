/**
 * 2.92.2 (Abnahme 2.92.0, Telegram 30.10. 13:14-13:29), Hauptmuster „Ziel erreicht, macht weiter, landet im Abbruch“:
 *  - Akku 13:20: hass_get lieferte den richtigen Wert, dann 8 weitere hass_*, „Task tool-call budget exhausted“, ❌.
 *  - „mach mir ein bild vom lab-bildschirm“: Bild 2× geliefert, 139 s, Abbruch + „nicht hinbekommen“.
 * Ein belegter Wert / ein belegtes Bild beendet einen Lese-Auftrag; eine Grenze nach belegtem Ergebnis ist kein ❌.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness, type EnvironmentRoute } from '../../test/helpers/e2e-harness.js'

const lab = vi.hoisted(() => ({ captures: 0, sends: 0 }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    currentCaptureNodes: () => ['xaventra-lab'],
    requestNodeCapture: async () => { lab.captures++; return { bytes: 24, base64: Buffer.alloc(24).toString('base64'), sha256: 'c'.repeat(64), capturedAt: new Date().toISOString() } },
}))
vi.mock('../tools/send-file-tool.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    executeSendFile: async () => { lab.sends++; return '✅ Foto gesendet: fixture' },
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; lab.captures = 0; lab.sends = 0 })
const T = 120_000

const profile = (bound: boolean) => ({
    version: 1, owner: { name: 'Max Muster', nicknames: [], timezone: 'Europe/Vienna' },
    entities: [{ name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: [],
        ...(bound ? { ha: { entities: { Akku: 'sensor.example_123_state_of_charge' } } } : {}) }],
    rules: [],
})
const seed = (bound: boolean) => (root: string) => {
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'owner-profile.json'), JSON.stringify(profile(bound), null, 2))
}
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const entity = (entity_id: string, state: string, attributes: Record<string, unknown>, age = 1) => ({ entity_id, state, attributes, last_changed: at(age), last_updated: at(age) })
const SOC = entity('sensor.example_123_state_of_charge', '78', { friendly_name: 'Surfmate State of charge', unit_of_measurement: '%' })
const STALE = entity('sensor.byd_soc', '50', { friendly_name: 'BYD Ladezustand', unit_of_measurement: '%' }, 3000)
const routes: EnvironmentRoute[] = [
    { match: /\/api\/states\/sensor\.example_123_state_of_charge$/, respond: () => ({ json: SOC }) },
    { match: /\/api\/states\/sensor\.byd_soc$/, respond: () => ({ json: STALE }) },
    { match: /\/api\/states\/sensor\.other_\d+$/, respond: () => ({ json: entity('sensor.other', '1', {}) }) },
    { match: /\/api\/states$/, respond: () => ({ json: [SOC, STALE] }) },
]
const haConfig = { homeassistant: { url: 'http://ha.example.com:8123', token: 'fake-token-for-tests' } }

describe('a read task ends with its proven result', () => {
    it('a bound vehicle value: exactly one hass_get, a fixed answer with its time, no model round trip', async () => {
        h = await createE2EHarness({ seed: seed(true), config: haConfig, routes })
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [
            { tool: 'hass_get', args: { entity_id: 'sensor.byd_soc' } }, { tool: 'hass_list', args: {} }, { text: 'Der Akku steht bei 50 %.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.executedTools).toEqual(['hass_get'])
        expect(result.rounds).toHaveLength(0)
        expect(result.final).toMatch(/78\s*%/)
        expect(result.final).toMatch(/Stand \d{2}:\d{2}/)
        expect(result.final).not.toMatch(/50\s*%|BYD Ladezustand/)
    }, T)

    it('the tool budget ending after a proven value is no failure: the value is the answer', async () => {
        h = await createE2EHarness({ seed: seed(false), config: haConfig, routes })
        const wander = Array.from({ length: 30 }, (_, i) => ({ tool: 'hass_get', args: { entity_id: `sensor.other_${i}` } }))
        const result = await h.telegram('Wie steht es um sensor.example_123_state_of_charge?', [
            { tool: 'hass_get', args: { entity_id: 'sensor.example_123_state_of_charge' } }, ...wander, { text: 'Fertig.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/78\s*%/)
        const { isTelegramFailureReply } = await h.module('channels/telegram-presentation.js')
        expect(isTelegramFailureReply(result.final)).toBe(false)
    }, T)

    it('"mach mir ein bild vom lab-bildschirm": one capture, one delivery, then the run ends', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram('mach mir ein bild vom lab-bildschirm', [
            { tool: 'mesh_screenshot', args: { node_id: 'xaventra-lab' } }, { tool: 'mesh_screenshot', args: { node_id: 'xaventra-lab' } },
            { tool: 'nova_capabilities' }, { tool: 'nova_capabilities' }, { text: 'Das habe ich nicht hinbekommen.' },
        ])
        expect(result.error).toBeUndefined()
        expect(lab.captures).toBe(1)
        expect(lab.sends).toBe(1)
        expect(result.final).not.toMatch(/nicht hinbekommen|Abgebrochen/)
        expect(result.executedTools).not.toContain('nova_capabilities')
    }, T)
})
