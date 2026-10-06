import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConnections, type ViewDeps } from './connections-view.js'
import { registerConnectionsApi } from './connections-api.js'
import { listApprovalCards } from '../core/approval-cards.js'

// Paket L 3: „Verbindungen → Gefunden“ lists ONE entry per real device and every
// connectable device has a button that creates its connect card.

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-devs-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const at = new Date().toISOString()
const devices = () => [
    { id: 'dev-00000000a1', type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'http', status: 'gefunden', lastSeenAt: at, evidence: {} },
    { id: 'dev-00000000a2', type: 'homeassistant', host: '198.51.100.19', port: 8123, via: 'http', status: 'gefunden', lastSeenAt: at, evidence: {} },
    { id: 'dev-00000000b1', type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', status: 'gefunden', lastSeenAt: at, evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } },
    { id: 'dev-00000000b2', type: 'networkservice', host: '192.0.2.143', port: 80, via: 'tcp', status: 'gefunden', lastSeenAt: at, evidence: {} },
    { id: 'dev-00000000c1', type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', status: 'gefunden', lastSeenAt: at, evidence: {}, hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at } },
    { id: 'dev-00000000d1', type: 'networkservice', host: '172.17.0.2', port: 80, via: 'tcp', status: 'gefunden', lastSeenAt: at, evidence: {} },
    { id: 'dev-00000000d2', type: 'networkservice', host: '192.0.2.98', port: 22, via: 'tcp', status: 'gefunden', lastSeenAt: at, evidence: {} },
]
const deps = (dir: string, extra: Partial<ViewDeps> = {}): ViewDeps => ({
    dataDir: dir, directoryCachePath: join(dir, 'none.json'), env: {}, accounts: () => [], connections: () => [],
    devices: devices as any, consolidation: { eigeneNetze: ['192.0.2.0/24'], aliase: { '198.51.100.19': '192.0.2.30' } }, ...extra,
})

describe('Verbindungen → Gefunden: ein Eintrag je Gerät, mit Knopf', () => {
    it('lists Home Assistant once (LAN + tailnet), the Hue bridge once, no noise', async () => {
        const view = await collectConnections(deps(tmp()))
        expect(view.gefunden.map(item => item.title)).toEqual(['Home Assistant', 'Hue Bridge', 'Tuya-Gerät'])
        expect(view.gefunden[0]).toMatchObject({ connectorId: 'home-assistant', geraet: { verbinden: 'homeassistant' } })
        expect(view.gefunden[1].geraet).toMatchObject({ id: 'dev-00000000b1', verbinden: 'hue', dienste: 2 })
        expect(view.gefunden[2].geraet).toMatchObject({ verbinden: 'tuya' })
    })

    it('the device button creates the connect card (Tuya with the chosen way)', async () => {
        const dir = tmp()
        mkdirSync(join(dir, 'sensing'), { recursive: true })
        writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices: devices().map(d => ({ ...d, name: '', foundAt: at })) }))
        const app = express(); app.use(express.json())
        registerConnectionsApi(app, { ownerOnly: () => true, deps: () => ({ ...deps(dir), cardOpts: { dataDir: dir, ledger: null } }) as any })
        const server = app.listen(0, '127.0.0.1')
        await new Promise<void>(resolve => server.once('listening', resolve))
        const base = `http://127.0.0.1:${(server.address() as any).port}/api/desktop/verbindungen`
        try {
            const hue = await fetch(`${base}/geraet/dev-00000000b1/verbinden`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            expect(hue.status).toBe(200)
            const body = await hue.json() as any
            expect(body.cardId).toMatch(/^k[a-f0-9]{12}$/)
            const tuya = await (await fetch(`${base}/geraet/dev-00000000c1/verbinden`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weg: 'cloud' }) })).json() as any
            const card = listApprovalCards({ dataDir: dir }).find(c => c.id === tuya.cardId)!
            expect(card.aktion.ref).toBe('dev-00000000c1:cloud')
            expect((await fetch(`${base}/geraet/..%2Fetc/verbinden`, { method: 'POST' })).status).toBe(404)
            expect((await fetch(`${base}/geraet/dev-00000000d1/verbinden`, { method: 'POST' })).status).toBe(409)
        } finally { server.close() }
    })
})

describe('Desktop „Verbindungen → Gefunden“: Knopf je Gerät', () => {
    it('renders Koppeln for Hue, Lokal/Cloud for Tuya and the bridge-button hint', async () => {
        const { readFileSync } = await import('node:fs')
        const { fileURLToPath } = await import('node:url')
        const { runInNewContext } = await import('node:vm')
        const source = readFileSync(fileURLToPath(new URL('../../desktop/renderer/connections.js', import.meta.url)), 'utf8')
        const sandbox: any = { window: {}, document: {}, Date, Number, String, Object, Promise, encodeURIComponent, URLSearchParams }
        runInNewContext(source, sandbox)
        const ui = sandbox.window.XaventraConnections
        const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as any)[char])
        const h = { esc, attr: esc, icon: () => '', toast: () => undefined, fail: () => undefined, rerender: () => undefined, api: {} }
        const data = { gefunden: [
            { id: 'a', title: 'Hue Bridge', fund: 'im Netz', wirkung: 'Lampen lesen', verbunden: false, geraet: { id: 'dev-00000000b1', verbinden: 'hue', dienste: 6 } },
            { id: 'b', title: 'Tuya-Gerät', fund: 'im Netz', wirkung: 'lesen', verbunden: false, geraet: { id: 'dev-00000000c1', verbinden: 'tuya', dienste: 1 } },
        ], moeglich: { gruppen: [], verzeichnis: {} }, verbunden: [] }
        sandbox.document.querySelector = () => ({ querySelector: () => null, querySelectorAll: () => [] })
        const html: string = await new Promise(resolve => ui.mount({ ...h, api: { get: async () => data }, rerender: () => resolve(ui.view(h)) }))
        expect(html).toContain('data-conn-device="dev-00000000b1">Koppeln')
        expect(html).toContain('runde Taste an der Bridge')
        expect(html).toContain('data-conn-weg="local"')
        expect(html).toContain('data-conn-weg="cloud"')
        expect(html).toContain('6 Dienste')
    })
})
