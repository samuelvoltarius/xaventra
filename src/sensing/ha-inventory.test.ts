import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { identifyHaFunctions, refreshHaInventory, haInventoryAwareness, haInventoryEvents } from './ha-inventory.js'
import { saveConnection, updateConnection, writeConnectionSecrets } from '../connections/connection-store.js'
import { buildSensingBus, setSensingConfig } from './runtime.js'

const roots: string[] = []
const root = () => { const p = mkdtempSync(join(tmpdir(), 'ha-inventory-')); roots.push(p); return p }
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const now = Date.now()
const signal = () => new AbortController().signal
const states = [{ entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Küche', token: 'secret-attribute' } },
    { entity_id: 'switch.relay', state: 'off', attributes: {} }, { entity_id: 'sensor.private', state: 'secret-sensor', attributes: {} },
    { entity_id: 'media_player.screen', state: 'unavailable', attributes: {} }]
const response = () => new Response(JSON.stringify(states), { status: 200 })
function approve(dir: string) {
    saveConnection({ id: 'c-home-assistant', connectorId: 'home-assistant', title: 'HA', trust: 'geprueft', datenklasse: 'lokal', status: 'verbunden', auth: 'ha-login', kategorie: 'zuhause', transport: { art: 'http', url: 'http://192.168.1.2:8123/api/mcp' }, basis: 'http://192.168.1.2:8123', createdAt: '', updatedAt: '', approvedBy: 'owner', erlaubteWerkzeuge: [] }, { dataDir: dir })
    writeConnectionSecrets('c-home-assistant', { ha: { accessToken: 'owner-token', expiresAt: now + 3600_000, clientId: 'owner-client' } }, { dataDir: dir })
}

describe('automatic authorized HA function inventory', () => {
    it('recognizes light functions but does not guess plugs/TVs or persist private sensors', () => {
        const result = identifyHaFunctions(states)
        expect(result.functions).toHaveLength(3)
        expect(result.functions[0].kind).toBe('Lichtfunktion')
        expect(result.functions[1].kind).toContain('nicht automatisch eine Steckdose')
        expect(result.functions[2].available).toBe(false)
        expect(JSON.stringify(result)).not.toContain('secret-')
    })
    it('reads fixed states and registry projection after approval, with no service/state writes', async () => {
        const dir = root(); approve(dir)
        const request = vi.fn(async () => response())
        await refreshHaInventory(dir, null, signal(), request as typeof fetch, now)
        expect(request).toHaveBeenCalledTimes(2)
        expect(request.mock.calls[0][0]).toBe('http://192.168.1.2:8123/api/states')
        const init = request.mock.calls[0][1] as RequestInit
        expect(init.method).toBe('GET'); expect(init.redirect).toBe('manual')
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer owner-token')
        expect(request.mock.calls[1][0]).toBe('http://192.168.1.2:8123/api/template')
        const metadataInit = request.mock.calls[1][1] as RequestInit
        expect(metadataInit.method).toBe('POST'); expect(metadataInit.redirect).toBe('manual')
        expect(new Headers(metadataInit.headers).get('Authorization')).toBe('Bearer owner-token')
        expect(JSON.parse(String(metadataInit.body)).template).toContain("device_attr(e, 'manufacturer')")
        const persisted = readFileSync(join(dir, 'sensing', 'ha-inventory.json'), 'utf8')
        expect(persisted).not.toContain('owner-token'); expect(persisted).not.toContain('secret-attribute')
        expect(haInventoryAwareness(dir, now)).toContain('Küche (light.kitchen): Lichtfunktion')
    })
    it('automatically enriches arbitrary manufacturers from the approved registry and retains functions on metadata failure', async () => {
        const dir = root(); approve(dir)
        const request = vi.fn(async (url: string) => url.endsWith('/api/states') ? response() : new Response(JSON.stringify([
            { entity_id: 'light.kitchen', device_id: 'a'.repeat(32), manufacturer: 'Example Vendor', model: 'Lamp 7', secret: 'not-for-storage' },
        ])))
        const result = await refreshHaInventory(dir, null, signal(), request as typeof fetch, now)
        expect(result[0].functions[0]).toMatchObject({ manufacturer: 'Example Vendor', model: 'Lamp 7', identitySource: 'home-assistant-device-registry' })
        expect(haInventoryAwareness(dir, now)).toContain('laut HA-Geräteregister: Example Vendor / Lamp 7')
        expect(readFileSync(join(dir, 'sensing', 'ha-inventory.json'), 'utf8')).not.toContain('not-for-storage')
        const failed = await refreshHaInventory(dir, null, signal(), (async (url: string) => url.endsWith('/api/states') ? response() : new Response('', { status: 403 })) as typeof fetch, now)
        expect(failed[0].status).toBe('ok'); expect(failed[0].functions).toHaveLength(3)
        expect(failed[0].functions[0].manufacturer).toBeUndefined()
    })
    it('uses reported device classes only, never product names as proof of an outlet or television', () => {
        const result = identifyHaFunctions([
            { entity_id: 'switch.plug', state: 'on', attributes: { friendly_name: 'TV Plug' } },
            { entity_id: 'switch.outlet', state: 'on', attributes: { device_class: 'outlet' } },
            { entity_id: 'media_player.tv', state: 'on', attributes: { device_class: 'tv' } },
        ])
        expect(result.functions[0].kind).toContain('nicht automatisch')
        expect(result.functions[1].kind).toContain('laut HA-Geräteklasse')
        expect(result.functions[2].kind).toContain('laut HA-Geräteklasse')
    })
    it('does not fetch without access, after disconnect or when stopped', async () => {
        const dir = root(); const request = vi.fn(async () => response())
        await refreshHaInventory(dir, null, signal(), request as typeof fetch, now)
        approve(dir); updateConnection('c-home-assistant', { status: 'getrennt' }, { dataDir: dir })
        await refreshHaInventory(dir, null, signal(), request as typeof fetch, now)
        const stopped = new AbortController(); stopped.abort()
        await refreshHaInventory(dir, { url: 'http://local:8123', token: 'owner-token' }, stopped.signal, request as typeof fetch, now)
        expect(request).not.toHaveBeenCalled()
    })
    it('invalidates cached functions immediately on disconnection and after expiry', async () => {
        const dir = root(); approve(dir)
        await refreshHaInventory(dir, null, signal(), (async () => response()) as typeof fetch, now)
        expect(haInventoryAwareness(dir, now + 11 * 60_000)).not.toContain('light.kitchen')
        updateConnection('c-home-assistant', { status: 'getrennt' }, { dataDir: dir })
        expect(haInventoryAwareness(dir, now)).not.toContain('light.kitchen')
    })
    it('does not display legacy cached functions after legacy authorization is removed', async () => {
        const dir = root()
        await refreshHaInventory(dir, { url: 'http://192.168.1.2:8123', token: 'owner-token' }, signal(), (async () => response()) as typeof fetch, now)
        expect(haInventoryAwareness(dir, now, true)).toContain('light.kitchen')
        expect(haInventoryAwareness(dir, now, false)).not.toContain('light.kitchen')
    })
    it('does not follow redirects or turn errors into a confirmed inventory', async () => {
        const dir = root(); approve(dir)
        await refreshHaInventory(dir, null, signal(), (async () => new Response('', { status: 302, headers: { Location: 'https://external.invalid' } })) as typeof fetch, now)
        expect(haInventoryAwareness(dir, now)).toContain('derzeit nicht bestätigt')
        expect(haInventoryAwareness(dir, now)).not.toContain('light.kitchen')
    })
    it('bounds the inventory and stores no unsupported entity attributes', () => {
        const result = identifyHaFunctions(Array.from({ length: 250 }, (_, i) => ({ entity_id: `light.l${i}`, state: 'on', attributes: { friendly_name: 'api_key=secret-value' } })))
        expect(result.functions).toHaveLength(200); expect(result.truncated).toBe(true)
        expect(JSON.stringify(result)).not.toContain('secret-value')
    })
    it('registers the automatic inventory without configured entity IDs and respects adapter disable', () => {
        const dir = root(); setSensingConfig({}, {}, dir)
        expect(buildSensingBus().getStatus().map(s => s.id)).toContain('homeassistant-inventory')
        setSensingConfig({ adapters: { homeassistant: { enabled: false } } }, {}, dir)
        expect(buildSensingBus().getStatus().map(s => s.id)).not.toContain('homeassistant-inventory')
    })
    it('proposes newly seen functions once, without an automatic switching action', () => {
        const previous = {}; const source = { source: 'c-home-assistant', at: new Date(now).toISOString(), status: 'ok' as const, ...identifyHaFunctions(states) }
        const events = haInventoryEvents([source], previous)
        expect(events).toHaveLength(1)
        expect(events[0].summary).toContain('Küche (Lichtfunktion)')
        expect(events[0].hint?.action).toBeUndefined()
        expect(haInventoryEvents([source], previous)).toEqual([])
        expect(haInventoryEvents([{ ...source, status: 'unavailable' }], previous)).toEqual([])
    })
})
