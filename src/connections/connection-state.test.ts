/**
 * 2.89 Paket B, Punkt 1 — die eine Verbindungs-Wahrheit: Regeln von connectionState.
 * Fixtures on disk (devices.json, connections.json, smart-routes.json, key files),
 * read through the real stores; only doc addresses (192.0.2.x, 198.51.100.x).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionIdFor, loadConnections, saveConnection, type ConnectionRecord } from './connection-store.js'
import {
    accessStored, connectedConnectorIds, connectionState, geraetFrageKey, migrateConfiguredHomeAssistant, verbindungsFrageKey,
} from './connection-state.js'
import { consolidateDevices } from '../sensing/device-consolidation.js'
import { sensingDeviceFingerprint, type DeviceRecord } from '../sensing/device-registry.js'
import { submitTuyaLocalAccess } from '../sensing/smart-device-access.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-state-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const at = '2026-10-07T10:00:00.000Z'
const OWNER = 'telegram:111'
const dev = (id: string, p: Partial<DeviceRecord> & Pick<DeviceRecord, 'type' | 'host' | 'port'>): DeviceRecord => ({
    id, name: `${p.type} ${p.host}`, via: 'http', status: 'gefunden', foundAt: at, lastSeenAt: at, evidence: {}, ...p,
} as DeviceRecord)
const conn = (connectorId: string, over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
    id: connectionIdFor(connectorId), connectorId, trust: 'geprueft', title: connectorId, kategorie: 'zuhause', datenklasse: 'lokal', auth: 'ha-login',
    transport: { art: 'http', url: 'http://192.0.2.30:8123/api/mcp' }, status: 'verbunden', createdAt: at, updatedAt: at, approvedBy: OWNER, erlaubteWerkzeuge: [], ...over,
})
function writeDevices(dir: string, devices: DeviceRecord[]): void {
    mkdirSync(join(dir, 'sensing'), { recursive: true })
    writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices }))
}
function approveRoute(dir: string, d: DeviceRecord, route: 'local' | 'cloud' = 'local'): void {
    mkdirSync(join(dir, 'sensing'), { recursive: true })
    writeFileSync(join(dir, 'sensing', 'smart-routes.json'), JSON.stringify({ version: 1, choices: { [d.id]: { fingerprint: sensingDeviceFingerprint(d), owner: d.approvedBy, route, approved: true } } }))
}
function hueKeyFor(dir: string, id: string): void {
    mkdirSync(join(dir, 'secrets', 'smart-devices'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'smart-devices', `${id}.json`), JSON.stringify({ hueKey: 'x'.repeat(20) }))
}

const tuya = dev('dev-00000000c1', { type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', status: 'eingerichtet', approvedBy: OWNER, approvedAt: at,
    hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at } as any })
const hueA = dev('dev-00000000b1', { type: 'networkservice', host: '192.0.2.143', port: 80, via: 'mdns', evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } })
const hueB = dev('dev-00000000b2', { type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', status: 'eingerichtet', evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } })
const haA = dev('dev-00000000a1', { type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: { uuid: 'aaaabbbbccccddddeeeeffff00001111', location_name: 'Home', version: '2026.9.1' } })
const haB = dev('dev-00000000a2', { type: 'homeassistant', host: '192.0.2.31', port: 8123, evidence: { uuid: 'bbbbccccddddeeeeffff000011112222', location_name: 'Home', version: '2026.9.1' } })
const printer = dev('dev-00000000e1', { type: 'moonraker', host: '192.0.2.40', port: 7125, status: 'eingerichtet', approvedBy: 'auto:lesend', approvedAt: at })
const tv = dev('dev-00000000f1', { type: 'networkdevice', host: '192.0.2.50', port: 8008, via: 'mdns', status: 'eingerichtet', evidence: { service: '_googlecast._tcp.local' } })

describe('connectionState: Connector-IDs', () => {
    it('verbunden / wartet / gefunden straight from the one store', () => {
        const dir = tmp()
        expect(connectionState(dir, { connectorId: 'n8n' })).toMatchObject({ zustand: 'gefunden' })
        saveConnection(conn('n8n', { auth: 'token', status: 'wartet-auf-zugang' }), { dataDir: dir })
        expect(connectionState(dir, { connectorId: 'n8n' })).toEqual({ zustand: 'wartet', grund: 'Zugang fehlt noch' })
        saveConnection(conn('n8n', { auth: 'token', status: 'verbunden' }), { dataDir: dir })
        expect(connectionState(dir, { connectorId: 'n8n' }).zustand).toBe('verbunden')
        saveConnection(conn('n8n', { auth: 'token', status: 'getrennt' }), { dataDir: dir })
        expect(connectionState(dir, { connectorId: 'n8n' }).zustand).toBe('gefunden')
    })
})

describe('connectionState: Home Assistant je Instanz', () => {
    it('a connection counts only for the instance with its address; the other one stays „gefunden“', () => {
        const dir = tmp()
        writeDevices(dir, [haA, haB])
        saveConnection(conn('home-assistant', { basis: 'http://192.0.2.30:8123' }), { dataDir: dir })
        expect(connectionState(dir, { record: haA }).zustand).toBe('verbunden')
        expect(connectionState(dir, { record: haB }).zustand).toBe('gefunden')
        const geraete = consolidateDevices([haA, haB], {}).geraete
        expect(geraete.map(g => connectionState(dir, { geraet: g }).zustand).sort()).toEqual(['gefunden', 'verbunden'])
    })
    it('a begun HA login of this instance → wartet (Anmeldung fehlt)', () => {
        const dir = tmp()
        writeDevices(dir, [haA])
        saveConnection(conn('home-assistant', { basis: 'http://192.0.2.30:8123', status: 'wartet-auf-anmeldung' }), { dataDir: dir })
        expect(connectionState(dir, { record: haA })).toEqual({ zustand: 'wartet', grund: 'Anmeldung fehlt noch' })
    })
    it('the configured HA (HASS_URL / config) is „verbunden“ for its instance and is migrated once into connections.json', () => {
        const dir = tmp()
        writeDevices(dir, [haA, haB])
        const konfiguriertesHa = 'http://192.0.2.31:8123'
        expect(connectionState(dir, { record: haB }, { konfiguriertesHa })).toEqual({ zustand: 'verbunden', grund: 'über die Konfiguration' })
        expect(connectionState(dir, { record: haA }, { konfiguriertesHa }).zustand).toBe('gefunden')
        expect(connectionState(dir, { connectorId: 'home-assistant' }, { konfiguriertesHa }).zustand).toBe('verbunden')
        const migrated = migrateConfiguredHomeAssistant(dir, konfiguriertesHa, Date.parse(at))
        expect(migrated).toMatchObject({ connectorId: 'home-assistant', status: 'verbunden', herkunft: 'konfiguriert', weg: 'rest', basis: 'http://192.0.2.31:8123' })
        expect(JSON.stringify(loadConnections({ dataDir: dir }))).not.toMatch(/token"?\s*:/i)
        expect(migrateConfiguredHomeAssistant(dir, konfiguriertesHa)).toBeNull()
        // The migrated entry counts only while the configuration exists.
        expect(connectionState(dir, { connectorId: 'home-assistant' }, { konfiguriertesHa }).zustand).toBe('verbunden')
        expect(connectionState(dir, { connectorId: 'home-assistant' }, { konfiguriertesHa: null }).zustand).toBe('gefunden')
        expect(connectionState(dir, { record: haB }, { konfiguriertesHa: null }).zustand).toBe('gefunden')
    })
    it('a foreign data directory never inherits HASS_URL of this process', () => {
        const dir = tmp()
        const before = process.env.HASS_URL, token = process.env.HASS_TOKEN
        process.env.HASS_URL = 'http://192.0.2.30:8123'; process.env.HASS_TOKEN = 'x'.repeat(20)
        try { expect(connectionState(dir, { connectorId: 'home-assistant' }).zustand).toBe('gefunden') }
        finally { if (before === undefined) delete process.env.HASS_URL; else process.env.HASS_URL = before; if (token === undefined) delete process.env.HASS_TOKEN; else process.env.HASS_TOKEN = token }
    })
})

describe('connectionState: Hue-Schlüssel auf Geräteebene', () => {
    it('the key on one member connects the whole bridge — asked through any member', () => {
        const dir = tmp()
        writeDevices(dir, [hueA, hueB])
        expect(connectionState(dir, { record: hueA })).toEqual({ zustand: 'wartet', grund: 'Taste an der Hue Bridge noch nicht gedrückt' })
        hueKeyFor(dir, hueA.id)
        expect(connectionState(dir, { record: hueA }).zustand).toBe('verbunden')
        expect(connectionState(dir, { record: hueB }).zustand).toBe('verbunden')
        expect(accessStored(dir, hueA)).toBe(true)
    })
})

describe('connectionState: Weg UND Schlüssel (Tuya/ESPHome/Matter/Shelly)', () => {
    it('approved way without key → wartet; with key → verbunden', () => {
        const dir = tmp()
        writeDevices(dir, [tuya])
        expect(connectionState(dir, { record: tuya })).toEqual({ zustand: 'wartet', grund: 'Weg noch nicht freigegeben' })
        approveRoute(dir, tuya)
        expect(connectionState(dir, { record: tuya })).toEqual({ zustand: 'wartet', grund: 'Schlüssel fehlt noch' })
        expect(accessStored(dir, tuya)).toBe(false)
        expect(submitTuyaLocalAccess(dir, tuya.id, sensingDeviceFingerprint(tuya), { key: 'x'.repeat(16), version: '3.3' }, { principalId: OWNER, permission: 'owner' } as any).ok).toBe(true)
        expect(connectionState(dir, { record: tuya }).zustand).toBe('verbunden')
        expect(accessStored(dir, tuya)).toBe(true)
    })
})

describe('connectionState: eingerichtet ≠ verbunden', () => {
    it('a watched printer is read (verbunden); a watched TV without a way is not connected', () => {
        const dir = tmp()
        writeDevices(dir, [printer, tv])
        expect(connectionState(dir, { record: printer }).zustand).toBe('verbunden')
        expect(connectionState(dir, { record: tv })).toEqual({ zustand: 'gefunden', grund: 'nur beobachtet, kein Verbindungsweg' })
    })
    it('connectedConnectorIds lists only what connectionState calls verbunden', () => {
        const dir = tmp()
        saveConnection(conn('n8n', { auth: 'token' }), { dataDir: dir })
        saveConnection(conn('paperless', { auth: 'token', status: 'wartet-auf-zugang' }), { dataDir: dir })
        expect([...connectedConnectorIds(dir)]).toEqual(['n8n'])
        expect([...connectedConnectorIds(dir, { konfiguriertesHa: 'http://192.0.2.30:8123' })].sort()).toEqual(['home-assistant', 'n8n'])
    })
})

describe('eine Frage je Ding: gemeinsamer Schlüssel', () => {
    it('HA device and HA connector share one key; other devices use their identity', () => {
        const [g] = consolidateDevices([haA], {}).geraete
        expect(geraetFrageKey(g)).toBe(verbindungsFrageKey({ connectorId: 'home-assistant' }))
        expect(verbindungsFrageKey({ connectorId: 'home-assistant' })).toBe('verbindung:home-assistant')
        const [hue] = consolidateDevices([hueA, hueB], {}).geraete
        expect(geraetFrageKey(hue)).toBe(`verbindung:${hue.key}`)
    })
})
