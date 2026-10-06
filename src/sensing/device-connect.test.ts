import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, listApprovalCards, maintainApprovalCards, registerCardExecutor } from '../core/approval-cards.js'
import { createDeviceConnectExecutor, DEVICE_CONNECT_KIND, offerDeviceConnection, offerDeviceConnections, type DeviceConnectDeps } from './device-connect.js'
import { loadDevices, type DeviceRecord } from './device-registry.js'
import { selectedSmartRoute } from './smart-device-route.js'
import { saveConnection, connectionIdFor } from '../connections/connection-store.js'

// Paket L 2+3: one „Verbinden“ per real device through the existing flows; the
// question reaches the owner as a card in the bundled device message.

let dir: string
let t: number
const HOUR = 60 * 60_000
const at = () => new Date(t).toISOString()
const rec = (id: string, p: Partial<DeviceRecord>): DeviceRecord => ({ id, name: 'x', via: 'tcp', status: 'gefunden', foundAt: at(), lastSeenAt: at(), evidence: {}, port: 0, ...p } as DeviceRecord)
const ctx = { eigeneAdressen: ['192.0.2.10'], eigeneNetze: ['192.0.2.0/24'], meshAdressen: [], aliase: {} }
const owner = { userId: '111', ownerIds: ['111'] }

function seed(): void {
    mkdirSync(join(dir, 'sensing'), { recursive: true })
    writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices: [
        rec('dev-00000000a1', { type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'http' }),
        rec('dev-00000000b1', { type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } }),
        rec('dev-00000000b2', { type: 'networkservice', host: '192.0.2.143', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter-Endpunkt', certainty: 'probable', identity: 'ABCDEF-01', ecosystem: 'matter', connector: 'matter-ip', observedAt: at() } }),
        rec('dev-00000000c1', { type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at() } }),
        rec('dev-00000000d1', { type: 'networkservice', host: '192.0.2.77', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter-Endpunkt', certainty: 'probable', identity: 'FEDCBA-02', ecosystem: 'matter', connector: 'matter-ip', observedAt: at() } }),
        rec('dev-00000000e1', { type: 'moonraker', host: '192.0.2.60', port: 7125, via: 'http', status: 'eingerichtet', approvedBy: 'auto:lesend' }),
    ] }))
}

const hueConfig = { status: 200, body: JSON.stringify({ name: 'Hue', bridgeid: '001788FFFE0A1B2C', modelid: 'BSB002', swversion: '1972004020' }) }
const haManifest = { status: 200, body: JSON.stringify({ name: 'Home Assistant', short_name: 'Assistant' }) }

function deps(over: Partial<DeviceConnectDeps> = {}): DeviceConnectDeps & { calls: string[] } {
    const calls: string[] = []
    return {
        calls, dataDir: dir, ctx, cardOpts: { dataDir: dir, now: () => t, ledger: null }, now: () => t,
        allowTarget: () => true,
        httpProbe: async url => { calls.push(`GET ${url}`); return url.endsWith('/api/config') ? hueConfig : url.endsWith('/manifest.json') ? haManifest : null },
        approve: async (id, approver) => { calls.push(`approve ${id} ${approver.principalId}`); return { ok: true, message: 'freigegeben' } },
        pairNow: async id => { calls.push(`pair ${id}`); return { status: 'ok', lampen: 3 } },
        ...over,
    }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dev-connect-')); t = Date.parse('2026-10-06T10:00:00.000Z'); seed() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Paket L: je Gerät genau EIN Verbinden', () => {
    it('offers one bundled card per connectable device (2.86: Tuya local, chosen by her)', async () => {
        const d = deps()
        const { created } = await offerDeviceConnections(d)
        const cards = listApprovalCards({ dataDir: dir })
        expect(created).toBe(4)
        expect(cards.every(c => c.buendel === 'geraete' && c.aktion.kind === DEVICE_CONNECT_KIND)).toBe(true)
        expect(cards.map(c => c.kurz?.split(' · ')[0]).sort()).toEqual(['Home Assistant', 'Hue Bridge', 'Smart-Gerät', 'Tuya-Gerät'])
        const tuya = cards.filter(c => c.kurz?.startsWith('Tuya'))
        expect(tuya.map(c => [c.aktion.ref, c.knopf])).toEqual([['dev-00000000c1:local', undefined]])
        for (const c of cards) expect(`${c.kurz} ${c.titel}`).not.toMatch(/192\.0\.2|dev-/)
        // the Hue card tells the owner to press the bridge button first
        expect(cards.find(c => c.kurz?.startsWith('Hue'))!.vorschlag).toMatch(/Taste.*Bridge.*dann.*Ja/i)
        expect((await offerDeviceConnections(d)).created).toBe(0)
    })

    it('does not ask for an already connected Home Assistant', async () => {
        saveConnection({ id: connectionIdFor('home-assistant'), connectorId: 'home-assistant', title: 'Home Assistant', status: 'verbunden', trust: 'geprueft', kategorie: 'zuhause', datenklasse: 'lokal', auth: 'ha-login', transport: { art: 'http', url: 'http://192.0.2.30:8123/mcp_server/sse' }, basis: 'http://192.0.2.30:8123', createdAt: at(), updatedAt: at(), approvedBy: 'telegram:111', erlaubteWerkzeuge: [] } as any, { dataDir: dir })
        await offerDeviceConnections(deps())
        expect(listApprovalCards({ dataDir: dir }).some(c => c.kurz?.startsWith('Home Assistant'))).toBe(false)
    })

    it('Hue: Ja verifies the bridge again, chooses the local way, approves and pairs at once — no switching', async () => {
        const d = deps()
        registerCardExecutor(createDeviceConnectExecutor(d))
        await offerDeviceConnections(d)
        const hue = listApprovalCards({ dataDir: dir }).find(c => c.kurz?.startsWith('Hue'))!
        const ja = hue.buttons.find(b => b.answer === 'ja')!.token
        const result = await answerApprovalCard(`ac:${ja}`, owner, { dataDir: dir, now: () => t, ledger: null })
        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/3 Lampen/)
        expect(result.message).not.toMatch(/[a-f0-9]{16}|dev-/)
        const endpoint = loadDevices(dir).find(r => r.host === '192.0.2.143' && r.port === 80)!
        expect(endpoint.hardware).toMatchObject({ connector: 'hue-readonly', access: 'hue-pairing-v1', identity: '001788fffe0a1b2c' })
        expect(selectedSmartRoute(dir, endpoint)).toBe('local')
        expect(d.calls).toEqual(['GET http://192.0.2.143:80/api/config', `approve ${endpoint.id} telegram:111`, `pair ${endpoint.id}`])
    })

    it('Hue: without a confirmed bridge nothing is approved', async () => {
        const d = deps({ httpProbe: async () => null })
        registerCardExecutor(createDeviceConnectExecutor(d))
        await offerDeviceConnections(d)
        const hue = listApprovalCards({ dataDir: dir }).find(c => c.kurz?.startsWith('Hue'))!
        const result = await answerApprovalCard(`ac:${hue.buttons.find(b => b.answer === 'ja')!.token}`, owner, { dataDir: dir, now: () => t, ledger: null })
        expect(result.card?.result?.ok).toBe(false)
        expect(d.calls.some(c => c.startsWith('approve'))).toBe(false)
    })

    it('Home Assistant: Ja refreshes the finding and starts the existing HA login flow', async () => {
        const d = deps()
        registerCardExecutor(createDeviceConnectExecutor(d))
        await offerDeviceConnections(d)
        const ha = listApprovalCards({ dataDir: dir }).find(c => c.kurz?.startsWith('Home'))!
        await answerApprovalCard(`ac:${ha.buttons.find(b => b.answer === 'ja')!.token}`, owner, { dataDir: dir, now: () => t, ledger: null })
        expect(d.calls).toEqual(['GET http://192.0.2.30:8123/manifest.json', 'approve dev-00000000a1 telegram:111'])
    })

    it('Tuya: one Ja connects locally; the manufacturer way only as an explicit choice in the app', async () => {
        const d = deps()
        registerCardExecutor(createDeviceConnectExecutor(d))
        await offerDeviceConnections(d)
        const local = listApprovalCards({ dataDir: dir }).find(c => c.aktion.ref === 'dev-00000000c1:local')!
        await answerApprovalCard(`ac:${local.buttons.find(b => b.answer === 'ja')!.token}`, owner, { dataDir: dir, now: () => t, ledger: null })
        expect(selectedSmartRoute(dir, loadDevices(dir).find(r => r.id === 'dev-00000000c1')!)).toBe('local')
        expect(d.calls).toContain('approve dev-00000000c1 telegram:111')
        const explicit = await offerDeviceConnection(d, 'dev-00000000c1', 'cloud')
        expect(listApprovalCards({ dataDir: dir }).find(c => c.id === explicit.cardId)?.aktion.ref).toBe('dev-00000000c1:cloud')
    })

    it('Nein hides every endpoint of the device and it is not asked again', async () => {
        const d = deps()
        registerCardExecutor(createDeviceConnectExecutor(d))
        await offerDeviceConnections(d)
        const hue = listApprovalCards({ dataDir: dir }).find(c => c.kurz?.startsWith('Hue'))!
        await answerApprovalCard(`ac:${hue.buttons.find(b => b.answer === 'nein')!.token}`, owner, { dataDir: dir, now: () => t, ledger: null })
        expect(loadDevices(dir).filter(r => r.host === '192.0.2.143').every(r => r.status === 'abgelehnt')).toBe(true)
        t += HOUR
        expect((await offerDeviceConnections(d)).created).toBe(0)
    })

    it('an expired, unanswered question is not re-asked for 14 days (it went to the report)', async () => {
        const d = deps()
        await offerDeviceConnections(d)
        t += 73 * HOUR
        maintainApprovalCards({ dataDir: dir, now: () => t, ledger: null })
        expect((await offerDeviceConnections(d)).created).toBe(0)
        t += 15 * 24 * HOUR
        expect((await offerDeviceConnections(d)).created).toBeGreaterThan(0)
    })
})
