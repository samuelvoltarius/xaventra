import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consolidateDevices } from './device-consolidation.js'
import { connectionState } from '../connections/connection-state.js'
import type { Geraet } from './device-consolidation.js'

// 2.89: the one connection truth replaces isDeviceConnected/isRecordConnected (same rules).
const isDeviceConnected = (dir: string, geraet: Geraet, devices: DeviceRecord[]) => connectionState(dir, { geraet }, { devices }).zustand === 'verbunden'
const isRecordConnected = (dir: string, record: DeviceRecord, devices: DeviceRecord[]) => connectionState(dir, { record }, { devices }).zustand === 'verbunden'
import { collectConnections } from '../connections/connections-view.js'
import { saveConnection, type ConnectionRecord } from '../connections/connection-store.js'
import type { DeviceRecord } from './device-registry.js'

const at = '2026-10-07T10:00:00.000Z'
let n = 0
const rec = (p: Partial<DeviceRecord> & Pick<DeviceRecord, 'type' | 'host' | 'port'>): DeviceRecord => ({
    id: `dev-${(++n).toString(16).padStart(10, '0')}`, name: `${p.type} ${p.host}`, via: 'http', status: 'gefunden', foundAt: at, lastSeenAt: at, evidence: {}, ...p,
} as DeviceRecord)
const ev = (uuid: string | undefined) => ({ location_name: 'Home', version: '2026.9.1', ...(uuid ? { uuid } : {}) })
const A = 'aaaabbbbccccddddeeeeffff00001111', B = 'bbbbccccddddeeeeffff000011112222'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'xv-p20-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const conn = (basis: string | undefined, over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
    id: 'c-home-assistant', connectorId: 'home-assistant', trust: 'geprueft', title: 'Home Assistant', kategorie: 'zuhause', datenklasse: 'lokal', auth: 'ha-login',
    transport: { art: 'http', url: 'http://ha.example.com/mcp' }, status: 'verbunden', createdAt: at, updatedAt: at, approvedBy: 'telegram:1', erlaubteWerkzeuge: [],
    ...(basis ? { basis } : {}), ...over,
})
const haOf = (list: DeviceRecord[]) => consolidateDevices(list, {}).geraete.filter(g => g.art === 'homeassistant')
const two = () => { n = 0; return [rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: ev(A) }), rec({ type: 'homeassistant', host: '192.0.2.31', port: 8123, evidence: ev(B) })] }

describe('2.88.2: Home-Assistant-Identität', () => {
    it('zwei verschiedene UUIDs mit gleichem Namen und gleicher Version bleiben getrennt', () => {
        expect(haOf(two())).toHaveLength(2)
    })
    it('Gegenprobe: gleiche UUID über LAN und Tailnet wird zusammengeführt', () => {
        n = 0
        expect(haOf([rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: ev(A) }), rec({ type: 'homeassistant', host: '198.51.100.19', port: 8123, evidence: ev(A) })])).toHaveLength(1)
    })
    it('ein Eintrag ohne UUID verbrückt zwei Instanzen mit verschiedener UUID nicht', () => {
        n = 0
        const list = [rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: ev(A) }), rec({ type: 'homeassistant', host: '192.0.2.31', port: 8123, evidence: ev(B) }),
            rec({ type: 'homeassistant', host: '192.0.2.32', port: 8123, evidence: ev(undefined) })]
        expect(haOf(list).length).toBeGreaterThanOrEqual(2)
    })
    it('Gegenprobe: ohne UUID gilt Name + Version weiter als Ersatz', () => {
        n = 0
        expect(haOf([rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: ev(undefined) }), rec({ type: 'homeassistant', host: '198.51.100.19', port: 8123, evidence: ev(undefined) })])).toHaveLength(1)
    })
})

describe('2.88.2: verbunden nur die passende HA-Instanz', () => {
    it('isDeviceConnected: nur die Instanz, zu der die Adresse der Verbindung passt', () => {
        const dir = tmp(); const list = two(); saveConnection(conn('http://192.0.2.30:8123'), { dataDir: dir })
        const gs = haOf(list)
        expect(isDeviceConnected(dir, gs.find(g => g.adressen.includes('192.0.2.30'))!, list)).toBe(true)
        expect(isDeviceConnected(dir, gs.find(g => g.adressen.includes('192.0.2.31'))!, list)).toBe(false)
    })
    it('isRecordConnected: gleiche Regel pro Datensatz', () => {
        const dir = tmp(); const list = two(); saveConnection(conn('http://192.0.2.30:8123'), { dataDir: dir })
        expect(isRecordConnected(dir, list[0], list)).toBe(true)
        expect(isRecordConnected(dir, list[1], list)).toBe(false)
    })
    it('die zweite Adresse derselben Instanz (Tailnet) zählt als ihre Adresse', () => {
        const dir = tmp(); n = 0
        const list = [rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: ev(A) }), rec({ type: 'homeassistant', host: '198.51.100.19', port: 8123, evidence: ev(A) }),
            rec({ type: 'homeassistant', host: '192.0.2.31', port: 8123, evidence: ev(B) })]
        saveConnection(conn('http://198.51.100.19:8123'), { dataDir: dir })
        const gs = haOf(list)
        expect(gs).toHaveLength(2)
        expect(isDeviceConnected(dir, gs.find(g => g.adressen.includes('192.0.2.30'))!, list)).toBe(true)
        expect(isDeviceConnected(dir, gs.find(g => g.adressen.includes('192.0.2.31'))!, list)).toBe(false)
    })
    it('ohne auswertbare Adresse: nur bei genau EINER Instanz verbunden', () => {
        const dir = tmp(); saveConnection(conn(undefined), { dataDir: dir })
        n = 0
        const one = [rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: ev(A) })]
        expect(isDeviceConnected(dir, haOf(one)[0], one)).toBe(true)
        const list = two()
        for (const g of haOf(list)) expect(isDeviceConnected(dir, g, list)).toBe(false)
    })
    it('Verbindungsansicht: die unverbundene zweite Instanz bleibt unverbunden (bekommt ihre Karte)', async () => {
        const dir = tmp(); const list = two()
        const view = await collectConnections({ dataDir: dir, env: {}, directoryCachePath: join(dir, 'none.json'), devices: () => list as any, accounts: () => [], connections: () => [conn('http://192.0.2.30:8123')] })
        const ha = view.gefunden.filter(i => i.title === 'Home Assistant')
        expect(ha.map(i => [i.fund.includes('192.0.2.30'), i.verbunden]).sort()).toEqual([[false, false], [true, true]])
    })
})
