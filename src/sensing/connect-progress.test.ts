import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectDeterministicCommand } from '../core/deterministic-query.js'
import { connectDevice, type DeviceConnectDeps } from './device-connect.js'
import { hueErfolgsSatz, starteVorgang, vorgangsEreignisse, vorgangsStand } from './connect-progress.js'
import type { DeviceRecord } from './device-registry.js'
import type { DirectInventory } from './direct-smart-devices.js'
import { loadGuidedState } from '../guided/guided-store.js'

// 2.86 Paket N, Live-Befund 06.10. 16:31–16:33: Hue gekoppelt, aber nicht gemeldet;
// „und?“ lief als Modellrunde ins Leere.
let dir = '', t = 0
const lamps = [
    { id: 'light:1', kind: 'light', name: 'Sofa', available: true }, { id: 'light:2', kind: 'light', name: 'Wohnzimmer', available: true },
    { id: 'light:3', kind: 'light', name: 'Schlafzimmer', available: false }, { id: 'light:4', kind: 'light', name: 'Küche', available: false },
] as DirectInventory['functions']
const row = (deviceId: string, status: DirectInventory['status'] = 'ok'): DirectInventory => ({ deviceId, fingerprint: 'f', at: new Date(t).toISOString(), protocol: 'hue', status, functions: status === 'ok' ? lamps : [] })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p16-progress-')); t = Date.parse('2026-10-06T16:31:00Z'); mkdirSync(join(dir, 'sensing'), { recursive: true }) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('genau EINE Erfolgsnachricht nach der Kopplung', () => {
    it('Nutzen-Satz mit erreichbaren Lampen', () => {
        expect(hueErfolgsSatz(lamps)).toBe('✅ Hue verbunden: 4 Lampen, 2 gerade erreichbar — Sofa, Wohnzimmer.')
    })

    it('die Kopplung wird im Hintergrund fertig → EINE Nachricht: Erfolgssatz mit den Beispiel-Knöpfen (2.86.1)', () => {
        starteVorgang(dir, { key: 'dev-00000000f1', art: 'hue' }, t)
        expect(vorgangsEreignisse(dir, [row('dev-00000000f1', 'pairing')], t)).toEqual([])
        // 2.86.1 Punkt 5: kein eigenes Ereignis mehr — der Satz steht im Kopf der Beispielsätze
        expect(vorgangsEreignisse(dir, [row('dev-00000000f1')], t + 30_000)).toEqual([])
        const offen = loadGuidedState({ dataDir: dir }).beispieleOffen
        expect(offen.map(item => item.kopf)).toEqual(['✅ Hue verbunden: 4 Lampen, 2 gerade erreichbar — Sofa, Wohnzimmer.\nProbier mal:'])
        expect(vorgangsStand(dir, t + 31_000)).toBe('✅ Hue verbunden: 4 Lampen, 2 gerade erreichbar — Sofa, Wohnzimmer.')
        expect(vorgangsEreignisse(dir, [row('dev-00000000f1')], t + 45_000)).toEqual([])
        // ohne laufenden Vorgang (normale Abfrage) keine Meldung
        expect(vorgangsEreignisse(dir, [row('dev-00000000f2')], t)).toEqual([])
    })

    it('das Wahrnehmen der direkten Geräte meldet es über den einen Meldeweg', () => {
        const source = readFileSync(fileURLToPath(new URL('./direct-smart-devices.ts', import.meta.url)), 'utf8')
        expect(source).toContain('vorgangsEreignisse(root, rows)')
    })

    it('Ja auf der Hue-Karte startet den Vorgang, wenn die Taste noch fehlt', async () => {
        const at = () => new Date(t).toISOString()
        const rec = { id: 'dev-00000000b1', type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', status: 'gefunden', foundAt: at(), lastSeenAt: at(), evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } } as unknown as DeviceRecord
        writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices: [rec] }))
        const deps: DeviceConnectDeps = { dataDir: dir, now: () => t, ctx: { eigeneNetze: ['192.0.2.0/24'] }, allowTarget: () => true, approve: async () => ({ ok: true, message: 'ok' }), pairNow: async () => ({ status: 'pairing', lampen: 0 }),
            httpProbe: async () => ({ status: 200, body: JSON.stringify({ name: 'Hue', bridgeid: '001788FFFE0A1B2C', modelid: 'BSB002', swversion: '1972004020' }) }) }
        const result = await connectDevice(deps, 'dev-00000000b1', { principalId: 'telegram:111', permission: 'owner' })
        expect(result.message).toContain('Drück sie jetzt')
        expect(vorgangsStand(dir, t + 10_000)).toBe('Noch nicht fertig: Ich warte auf die runde Taste an der Hue Bridge. Drück sie jetzt, ich melde mich gleich.')
    })
})

describe('„und?“ beantwortet den letzten Vorgang aus dem Speicher', () => {
    it('läuft / verbunden / zu spät / nichts', () => {
        expect(vorgangsStand(dir, t)).toBe('')
        starteVorgang(dir, { key: 'dev-00000000f1', art: 'hue' }, t)
        expect(vorgangsStand(dir, t + 5_000)).toContain('Noch nicht fertig')
        writeFileSync(join(dir, 'sensing', 'direct-inventory.json'), JSON.stringify({ version: 1, devices: [row('dev-00000000f1')] }))
        expect(vorgangsStand(dir, t + 20_000)).toBe('✅ Hue verbunden: 4 Lampen, 2 gerade erreichbar — Sofa, Wohnzimmer.')
        // schon gemeldet: kein zweites Ereignis
        expect(vorgangsEreignisse(dir, [row('dev-00000000f1')], t + 30_000)).toEqual([])
        starteVorgang(dir, { key: 'dev-00000000f3', art: 'hue' }, t + 60_000)
        expect(vorgangsStand(dir, t + 60_000 + 4 * 60_000)).toContain('Das hat nicht geklappt')
        expect(vorgangsStand(dir, t + 3 * 60 * 60_000)).toBe('')
    })

    it.each(['und?', 'Und', 'hat\'s geklappt?', 'Hat es geklappt', 'und jetzt?', 'fertig?'])('„%s“ → Stand aus dem Speicher (kein Modell)', text => {
        expect(detectDeterministicCommand(text)).toEqual({ command: 'geraete', args: 'stand', reason: 'connect-progress', risk: 'read-only' })
    })

    it('ohne Vorgang oder für Gäste geht es normal ins Gespräch', () => {
        const source = readFileSync(fileURLToPath(new URL('../core/message-pipeline.ts', import.meta.url)), 'utf8')
        expect(source).toMatch(/detected\.reason === 'connect-progress' && principalContext\.permission !== 'owner'/)
    })
})
