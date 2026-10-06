import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor } from '../core/approval-cards.js'
import { paginate, DETAILS_TRENNER } from '../core/owner-text.js'
import { environmentOverviewResponse } from '../core/tool-evidence-response.js'
import { vorherZustand } from './smart-control-http.js'
import { createDeviceConnectExecutor, DEVICE_CONNECT_KIND, offerDeviceConnections, type DeviceConnectDeps } from './device-connect.js'
import { consolidateDevices } from './device-consolidation.js'
import { geraeteUeberblick, ownerGeraeteAntwort } from './device-overview.js'
import type { DeviceRecord } from './device-registry.js'
import { fachwoerterIn, nutzenSatz } from './device-words.js'
import { deviceEvents } from './runtime.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 2.86 Paket N: „selbstständig verbinden“ + Alltagssprache. Nutzer sind keine
// Techniker: Nutzen-Sätze, lokal/Cloud entscheidet sie selbst, keine Fachwörter.
let dir = '', t = 0
const at = () => new Date(t).toISOString()
const rec = (id: string, p: Partial<DeviceRecord>): DeviceRecord => ({ id, name: 'x', via: 'tcp', status: 'gefunden', foundAt: at(), lastSeenAt: at(), evidence: {}, port: 0, ...p } as DeviceRecord)
const ctx = { eigeneAdressen: ['192.0.2.10'], eigeneNetze: ['192.0.2.0/24'], meshAdressen: [], aliase: {} }
const owner = { userId: '111', ownerIds: ['111'] }

function seed(): DeviceRecord[] {
    const devices = [
        rec('dev-00000000a1', { type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'http' }),
        rec('dev-00000000b1', { type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } }),
        rec('dev-00000000c1', { type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at() } as any }),
        rec('dev-00000000d1', { type: 'networkservice', host: '192.0.2.77', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter-Endpunkt', certainty: 'probable', identity: 'FEDCBA-02', ecosystem: 'matter', connector: 'matter-ip', observedAt: at() } as any }),
        rec('dev-00000000e1', { type: 'moonraker', host: '192.0.2.60', port: 7125, via: 'http', status: 'eingerichtet', approvedBy: 'auto:lesend' }),
    ]
    mkdirSync(join(dir, 'sensing'), { recursive: true })
    writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices }))
    return devices
}
const connectDeps = (): DeviceConnectDeps => ({
    dataDir: dir, ctx, cardOpts: { dataDir: dir, now: () => t, ledger: null }, now: () => t, allowTarget: () => true,
    httpProbe: async url => url.endsWith('/api/config') ? { status: 200, body: JSON.stringify({ name: 'Hue', bridgeid: '001788FFFE0A1B2C', modelid: 'BSB002', swversion: '1972004020' }) } : null,
    approve: async () => ({ ok: true, message: 'freigegeben' }), pairNow: async () => ({ status: 'ok', lampen: 12 }),
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p16-words-')); t = Date.parse('2026-10-06T10:00:00Z'); seed() })
afterEach(() => { unregisterCardExecutor(DEVICE_CONNECT_KIND); rmSync(dir, { recursive: true, force: true }) })

describe('Nutzen statt Technik', () => {
    it('meldet Ergebnisse als Nutzen-Satz', () => {
        expect(nutzenSatz({ lampen: 12, schalter: 3 })).toBe('Ich kann jetzt deine 12 Lampen und 3 Schalter sehen.')
        expect(nutzenSatz({ lampen: 1 })).toBe('Ich kann jetzt eine Lampe sehen.')
        expect(nutzenSatz({ drucker: 1 })).toBe('Ich sehe jetzt deinen 3D-Drucker und seinen Fortschritt.')
    })

    it('ein selbst lesend eingebundener Drucker wird als Nutzen gemeldet, ohne Adresse oder Befehl', () => {
        const [event] = deviceEvents({ monitored: [rec('dev-00000000e1', { type: 'moonraker', host: '192.0.2.60', port: 7125, via: 'http', status: 'eingerichtet', approvedBy: 'auto:lesend' })], asked: [] })
        expect(event.summary).toBe('Ich sehe jetzt deinen 3D-Drucker und seinen Fortschritt. Ich lese nur; abschalten geht unter „Geräte“.')
        expect(`${event.summary} ${event.hint?.title}`).not.toMatch(/192\.0\.2|dev-|\/geraete|Moonraker|Klipper/)
    })
})

describe('Verbinden: lokal entscheidet sie selbst, EIN Satz + EIN Knopf, keine Fachwörter', () => {
    it('Tuya bekommt genau EINE Karte (lokal), keine Lokal/Cloud-Frage', async () => {
        await offerDeviceConnections(connectDeps())
        const cards = listApprovalCards({ dataDir: dir })
        expect(cards).toHaveLength(4)
        const tuya = cards.filter(c => c.aktion.ref.startsWith('dev-00000000c1'))
        expect(tuya).toHaveLength(1)
        expect(tuya[0].aktion.ref).toBe('dev-00000000c1:local')
        expect(tuya[0].knopf).toBeUndefined()
    })

    it('die Karten sagen den einen Schritt in Alltagssprache', async () => {
        await offerDeviceConnections(connectDeps())
        const cards = listApprovalCards({ dataDir: dir })
        const text = (prefix: string) => { const c = cards.find(card => card.aktion.ref.startsWith(prefix))!; return `${c.kurz} | ${c.titel} | ${c.vorschlag}` }
        expect(text('dev-00000000a1')).toContain('Bei Home Assistant einmal anmelden')
        expect(text('dev-00000000b1')).toContain('Drück die runde Taste auf der Hue Bridge')
        expect(text('dev-00000000d1')).toContain('Code vom Aufkleber')
        for (const c of cards) expect(fachwoerterIn(`${c.kurz} ${c.titel} ${c.vorschlag} ${c.beleg}`)).toEqual([])
    })

    it('nach dem Koppeln: Nutzen-Satz statt Technik', async () => {
        registerCardExecutor(createDeviceConnectExecutor(connectDeps()))
        await offerDeviceConnections(connectDeps())
        const hue = listApprovalCards({ dataDir: dir }).find(c => c.aktion.ref.startsWith('dev-00000000b1'))!
        const result = await answerApprovalCard(`ac:${hue.buttons.find(b => b.answer === 'ja')!.token}`, owner, { dataDir: dir, now: () => t, ledger: null })
        expect(result.message).toContain('Ich kann jetzt deine 12 Lampen sehen.')
        expect(fachwoerterIn(result.message)).toEqual([])
    })
})

describe('Live-Befund: „Welche smarten Geräte findest du?“ → kurze Geräteliste, Technik nur hinter Details', () => {
    it('eine Zeile je echtem Gerät, Ampel + ein Satz, höchstens 600 Zeichen, keine Ids/Fachwörter', () => {
        const k = consolidateDevices(JSON.parse(readFileSync(join(dir, 'sensing', 'devices.json'), 'utf8')).devices, ctx)
        const text = geraeteUeberblick(dir, k, () => false)
        expect(text.split('\n')[0]).toBe('🟡 Ich kenne 5 Geräte in deinem Netz — 4 warten aufs Verbinden.')
        expect(text).toContain('• Home Assistant — wartet aufs Verbinden')
        expect(text).toContain('• 3D-Drucker — ich sehe seinen Fortschritt')
        expect(text).toContain('• Smart-Gerät — wartet aufs Verbinden')
        expect(text).toContain('Verbinden: je ein Knopf in der Nachricht „Geräte gefunden“.')
        expect(text.length).toBeLessThanOrEqual(600)
        expect(text).not.toMatch(/192\.0\.2|dev-|g-[a-f0-9]{10}/)
        expect(fachwoerterIn(text)).toEqual([])
    })

    it('die Antwort hängt die EINE Verbinden-Bündelnachricht an', async () => {
        let kicked = 0
        const text = await ownerGeraeteAntwort(dir, { kick: () => { kicked++ } })
        expect(text).toContain('warten aufs Verbinden')
        expect(kicked).toBe(1)
        const cards = listApprovalCards({ dataDir: dir, status: 'offen' })
        expect(cards.length).toBeGreaterThan(0)
        expect(cards.every(c => c.buendel === 'geraete')).toBe(true)
    })

    it('environment_inventory: zuerst die Owner-Liste, Knoten/Arbeitswege/Rohdaten nur hinter „Details“', () => {
        const owner = '🟢 Ich kenne 2 Geräte in deinem Netz.\n• Hue Bridge — verbunden: ich sehe 12 Lampen'
        const technik = 'Knoten-Fähigkeiten: mesh_delegate … Smart-Geräte-Zugriffswege dev-0000000001 Local-Key Fabric Thread Multi-Admin MCP'
        const reply = environmentOverviewResponse([
            { toolName: 'environment_inventory', success: true, result: { owner, formatted: technik } },
            { toolName: 'mesh_status', success: true, result: 'Mesh: 3 Knoten' },
        ])
        expect(reply.startsWith(owner)).toBe(true)
        const pages = paginate(reply)
        expect(pages[0]).toBe(owner)
        expect(pages[0]).not.toMatch(/mesh|MCP|Fabric|Thread|Local-Key|dev-/i)
        expect(pages.slice(1).join('\n')).toContain(DETAILS_TRENNER)
        expect(pages.slice(1).join('\n')).toContain('Smart-Geräte-Zugriffswege')
    })

    it('das Werkzeug liefert die Owner-Liste mit (eine Formatierungsstelle, kein zweiter Weg)', () => {
        const source = readFileSync(fileURLToPath(new URL('../tools/environment-inventory-tool.ts', import.meta.url)), 'utf8')
        expect(source).toContain('ownerGeraeteAntwort(dataDir)')
        expect(source).toMatch(/return \{ owner, formatted:/)
    })
})

describe('Rückgängig liest den Zustand direkt vor dem Schalten', () => {
    it('Hue und Tasmota melden ihn, sonst gibt es keinen', () => {
        expect(vorherZustand('hue-readonly', 'light:1', { state: { on: true, reachable: true } })).toBe(true)
        expect(vorherZustand('tasmota-readonly', 'POWER1', { StatusSTS: { POWER1: 'OFF' } })).toBe(false)
        expect(vorherZustand('matter-ip', 'endpoint:1:type:256', {})).toBeUndefined()
        const source = readFileSync(fileURLToPath(new URL('./smart-control-http.ts', import.meta.url)), 'utf8')
        // gemeldet wird genau der gelesene Zustand VOR dem Schreibbefehl
        for (const [read, write] of [["deps.onBefore?.(vorherZustand('hue-readonly'", "'PUT', { on: action.on }"], ["deps.onBefore?.(vorherZustand('tasmota-readonly'", "await request(`/cm?cmnd=${encodeURIComponent"], ['deps.onBefore?.(vorher)', "await request(`/${kind === 'relays'"]])
            expect(source.indexOf(read)).toBeGreaterThan(0), expect(source.indexOf(read)).toBeLessThan(source.indexOf(write))
    })
})
