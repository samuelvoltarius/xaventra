/**
 * 2.86.1 Ergänzung d (Live 06.10. 22:28): Anmeldung ok, aber am Owner-HA ist
 * die Integration „Model Context Protocol Server“ nicht eingerichtet →
 * `POST /api/mcp` = 404. Ein Nutzer richtet die nicht ein. Rückfallweg: mit
 * demselben Zugang die normale HA-Schnittstelle (lesend), Verbindung gilt als
 * hergestellt, Schalten weiter nur per Karte. Kein „MCP/Streamable HTTP/404“
 * an den Owner. Nur Testadressen (example.com).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectAndTest, type ConnectDeps } from './connect-flow.js'
import { getConnection, saveConnection, writeConnectionSecrets, type ConnectionRecord } from './connection-store.js'
import { usesMcpRuntime } from '../mcp/mcp-runtime.js'
import { hassAccess } from '../tools/homeassistant.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'p17-ha-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const BASIS = 'http://ha.example.com:8123'
const ACCESS = 'AT-test-access-000000'
const record = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
    id: 'c-home-assistant', connectorId: 'home-assistant', trust: 'geprueft', title: 'Home Assistant', kategorie: 'zuhause', datenklasse: 'lokal', auth: 'ha-login',
    transport: { art: 'http', url: `${BASIS}/api/mcp` }, status: 'wartet-auf-anmeldung', createdAt: '2026-10-06T20:00:00.000Z', updatedAt: '2026-10-06T20:00:00.000Z',
    approvedBy: 'telegram:42', erlaubteWerkzeuge: [], basis: BASIS, ...over,
})
const MCP_404 = new Error('MCP home-assistant connection failed: Streamable HTTP error: Error POSTing to endpoint: 404')

function setup(rest: (url: string, init?: any) => Response) {
    const dir = tmp()
    saveConnection(record(), { dataDir: dir })
    writeConnectionSecrets('c-home-assistant', { ha: { accessToken: ACCESS, refreshToken: 'RT-test', expiresAt: Date.now() + 3_600_000, clientId: 'http://127.0.0.1:3011/' } }, { dataDir: dir })
    const fetchFn = vi.fn(async (url: any, init?: any) => rest(String(url), init))
    const gateway = { connect: vi.fn(async () => { throw MCP_404 }), disconnect: vi.fn() }
    const deps: ConnectDeps = { dataDir: dir, redirectBase: 'http://127.0.0.1:3011', env: {}, fetchFn: fetchFn as any, gateway, askLogin: vi.fn() } as any
    return { dir, deps, fetchFn, gateway }
}

describe('2.86.1 d: Home Assistant ohne MCP-Integration', () => {
    it('404 auf /api/mcp → normale HA-Schnittstelle mit demselben Zugang: verbunden, Alltagssatz', async () => {
        const { dir, deps, fetchFn } = setup(url => url === `${BASIS}/api/` ? new Response(JSON.stringify({ message: 'API running.' }), { status: 200 }) : new Response('nope', { status: 404 }))
        const result = await connectAndTest('c-home-assistant', deps)
        expect(result.ok).toBe(true)
        expect(result.message).not.toMatch(/MCP|Streamable|404|HTTP/i)
        expect(getConnection('c-home-assistant', { dataDir: dir })).toMatchObject({ status: 'verbunden', weg: 'rest' })
        const call = fetchFn.mock.calls.find(([url]) => String(url) === `${BASIS}/api/`)!
        expect(new Headers(call[1]?.headers).get('Authorization')).toBe(`Bearer ${ACCESS}`)
        // beim Neustart versucht die MCP-Laufzeit diese Verbindung nicht wieder über MCP
        expect(usesMcpRuntime(getConnection('c-home-assistant', { dataDir: dir })!)).toBe(false)
    })

    it('ein zweiter Test geht direkt über die HA-Schnittstelle (kein erneuter MCP-Versuch)', async () => {
        const { deps, gateway } = setup(url => url === `${BASIS}/api/` ? new Response(JSON.stringify({ message: 'API running.' }), { status: 200 }) : new Response('nope', { status: 404 }))
        await connectAndTest('c-home-assistant', deps)
        await connectAndTest('c-home-assistant', deps)
        expect(gateway.connect).toHaveBeenCalledTimes(1)
    })

    it('antwortet auch die HA-Schnittstelle nicht: ein Alltagssatz, keine Technik', async () => {
        const { deps } = setup(() => new Response('down', { status: 500 }))
        const result = await connectAndTest('c-home-assistant', deps)
        expect(result.ok).toBe(false)
        expect(result.message).not.toMatch(/MCP|Streamable|404|HTTP|500/i)
    })

    it('die hass-Werkzeuge lesen über die Verbindung (Zugang nur aus der Ablage, frisch je Aufruf)', async () => {
        const { dir, deps, fetchFn } = setup(url => url === `${BASIS}/api/` ? new Response(JSON.stringify({ message: 'API running.' }), { status: 200 })
            : url === `${BASIS}/api/states` ? new Response(JSON.stringify([{ entity_id: 'light.sofa', state: 'on', attributes: {} }]), { status: 200 }) : new Response('nope', { status: 404 }))
        await connectAndTest('c-home-assistant', deps)
        const access = await hassAccess({ env: {}, dataDir: dir, fetchFn: fetchFn as any })
        expect(access?.url).toBe(BASIS)
        const response = await access!.fetch(`${access!.url}/api/states`, { method: 'GET' })
        expect(await response.json()).toEqual([{ entity_id: 'light.sofa', state: 'on', attributes: {} }])
        const call = fetchFn.mock.calls.find(([url]) => String(url) === `${BASIS}/api/states`)!
        expect(new Headers(call[1]?.headers).get('Authorization')).toBe(`Bearer ${ACCESS}`)
    })
})
