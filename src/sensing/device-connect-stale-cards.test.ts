import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listApprovalCards, maintainApprovalCards, registerCardExecutor } from '../core/approval-cards.js'
import { createDeviceConnectExecutor, offerDeviceConnections, type DeviceConnectDeps } from './device-connect.js'
import { saveConnection, connectionIdFor } from '../connections/connection-store.js'

// 2.87.1 (live 07.10.2026): a "Home Assistant verbinden?" card created before
// Home Assistant was connected stayed open and kept coming back in the bundled
// device message ("Bei Home Assistant einmal anmelden") although HA was connected.

let dir: string
let t: number
const at = () => new Date(t).toISOString()

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dev-stale-'))
    t = Date.parse('2026-10-06T18:00:00.000Z')
    mkdirSync(join(dir, 'sensing'), { recursive: true })
    writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices: [
        { id: 'dev-00000000a1', type: 'homeassistant', name: 'Home', host: '192.0.2.30', port: 8123, via: 'http', status: 'gefunden', foundAt: at(), lastSeenAt: at(), evidence: {} },
    ] }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function deps(): DeviceConnectDeps {
    return {
        dataDir: dir, ctx: { eigeneAdressen: ['192.0.2.10'], eigeneNetze: ['192.0.2.0/24'], meshAdressen: [], aliase: {} },
        cardOpts: { dataDir: dir, now: () => t, ledger: null }, now: () => t, allowTarget: () => true,
        httpProbe: async () => ({ status: 200, body: JSON.stringify({ name: 'Home Assistant' }) }),
        approve: async () => ({ ok: true, message: 'ok' }), pairNow: async () => ({ status: 'ok', lampen: 0 }),
    } as DeviceConnectDeps
}

describe('device questions close themselves once the device is connected', () => {
    it('an open Home Assistant card is settled after Home Assistant got connected', async () => {
        const d = deps()
        registerCardExecutor(createDeviceConnectExecutor(d))
        await offerDeviceConnections(d)
        const open = listApprovalCards({ dataDir: dir }).filter(c => c.status === 'offen')
        expect(open).toHaveLength(1)
        // Gegenprobe: still not connected → stays open
        expect(maintainApprovalCards({ dataDir: dir, now: () => t, ledger: null } as any).settled).toHaveLength(0)

        saveConnection({ id: connectionIdFor('home-assistant'), connectorId: 'home-assistant', title: 'Home Assistant', status: 'verbunden', trust: 'geprueft', kategorie: 'zuhause', datenklasse: 'lokal', auth: 'ha-login', transport: { art: 'http', url: 'http://192.0.2.30:8123/api/mcp' }, basis: 'http://192.0.2.30:8123', createdAt: at(), updatedAt: at(), approvedBy: 'telegram:111', erlaubteWerkzeuge: [] } as any, { dataDir: dir })
        t += 60_000
        const { settled } = maintainApprovalCards({ dataDir: dir, now: () => t, ledger: null } as any)
        expect(settled.map(c => c.id)).toEqual(open.map(c => c.id))
        expect(listApprovalCards({ dataDir: dir }).filter(c => c.status === 'offen')).toHaveLength(0)
    })
})
