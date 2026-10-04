import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, expect, vi } from 'vitest'
import { identifyHardware } from './hardware-recognition.js'
import { recordCandidates, loadDevices, approveDevice, setDeviceStatus } from './device-registry.js'
import { chooseSmartRoute, selectedSmartRoute, approvedSmartRoute, approveSmartRoute, smartRouteEvents } from './smart-device-route.js'
import { requestHuePairing, refreshDirectInventory, directInventoryAwareness, parseDirectFunctions } from './direct-smart-devices.js'
import { readTuyaCloudFunctions } from './tuya-cloud-inventory.js'

const roots: string[] = []
const root = () => { const p = mkdtempSync(join(tmpdir(), 'smart-direct-')); roots.push(p); return p }
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const owner = { principalId: 'owner-test', permission: 'owner' }
const interfaces = { eth: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const hue = { bridgeid: '001788fffe123456', modelid: 'BSB002', swversion: '1967054020' }
const addHue = (p: string) => recordCandidates(p, [{ type: 'networkservice', host: '192.168.1.21', port: 80, via: 'http', hardware: identifyHardware({ status: 200, body: JSON.stringify(hue) }, 'hue-config')! }])[0]
const approve = (p: string, id: string, route: 'local' | 'cloud') => {
    expect(chooseSmartRoute(p, id, route, owner).ok).toBe(true)
    expect(approveDevice(p, id, owner).ok).toBe(true)
    const d = loadDevices(p).find(d => d.id === id)!
    expect(approveSmartRoute(p, d, route, owner.principalId)).toBe(true)
    return d
}
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })

it('asks per identity, rejects non-owner choice, and does not turn selection into access', async () => {
    const p = root(), d = addHue(p)
    expect(smartRouteEvents(p)[0].summary).toContain('lokalen Weg oder die Hersteller-Cloud')
    expect(chooseSmartRoute(p, d.id, 'cloud', { ...owner, permission: 'user' }).ok).toBe(false)
    expect(selectedSmartRoute(p, d)).toBeUndefined()
    expect(chooseSmartRoute(p, d.id, 'local', owner).ok).toBe(true)
    approveDevice(p, d.id, owner)
    const current = loadDevices(p)[0], request = vi.fn()
    expect(approvedSmartRoute(p, current)).toBeUndefined()
    expect(() => requestHuePairing(p, current, owner.principalId)).toThrow()
    await refreshDirectInventory(p, new AbortController().signal, { interfaces, fetch: request })
    expect(request).not.toHaveBeenCalled()
})

it('revokes access on route choice, identity replacement or owner rejection', () => {
    const p = root(), d = addHue(p), local = approve(p, d.id, 'local')
    expect(approvedSmartRoute(p, local)).toBe('local')
    chooseSmartRoute(p, d.id, 'cloud', owner)
    expect(approvedSmartRoute(p, local)).toBeUndefined()
    expect(() => requestHuePairing(p, local, owner.principalId)).toThrow()
    recordCandidates(p, [{ ...local, hardware: { ...local.hardware!, identity: 'other-bridge' } }])
    expect(selectedSmartRoute(p, loadDevices(p)[0])).toBeUndefined()
    setDeviceStatus(p, d.id, 'abgelehnt', owner)
    expect(chooseSmartRoute(p, d.id, 'local', owner).ok).toBe(false)
})

it('pairs only the approved local Hue bridge, reads actual lamp metadata and keeps keys private', async () => {
    const p = root(), d = addHue(p), local = approve(p, d.id, 'local'), key = 'a'.repeat(24)
    requestHuePairing(p, local, owner.principalId)
    let registered = false
    const request = vi.fn(async (url: any, options: any) => {
        if (String(url).endsWith('/api/config')) return json(hue)
        if (String(url).endsWith('/api')) {
            expect(options.method).toBe('POST'); expect(options.redirect).toBe('manual')
            expect(JSON.parse(options.body)).toEqual({ devicetype: 'xaventra#read-inventory' })
            if (!registered) { registered = true; return json([{ error: { type: 101 } }]) }
            return json([{ success: { username: key } }])
        }
        expect(String(url)).toBe(`http://192.168.1.21:80/api/${key}/lights`)
        expect(options.method).toBe('GET')
        return json({ 1: { modelid: 'LCT015', type: 'Extended color light', name: 'Desk', manufacturername: 'Signify', state: { on: false, reachable: true } } })
    })
    const signal = new AbortController().signal
    expect((await refreshDirectInventory(p, signal, { interfaces, fetch: request }))[0].status).toBe('pairing')
    const [row] = await refreshDirectInventory(p, signal, { interfaces, fetch: request })
    expect(row).toMatchObject({ status: 'ok', functions: [{ kind: 'light', model: 'LCT015', manufacturer: 'Signify', available: true }] })
    expect(directInventoryAwareness(p)).toContain('LCT015')
    expect(directInventoryAwareness(p)).not.toContain(key)
    expect(readFileSync(join(p, 'sensing', 'direct-inventory.json'), 'utf8')).not.toContain(key)
    expect(JSON.parse(readFileSync(join(p, 'secrets', 'smart-devices', d.id + '.json'), 'utf8')).hueKey).toBe(key)
    request.mockClear()
    await refreshDirectInventory(p, signal, { interfaces, fetch: request })
    expect(request).not.toHaveBeenCalled() // measured metadata is cached for two minutes
    chooseSmartRoute(p, d.id, 'cloud', owner)
    expect(directInventoryAwareness(p)).not.toContain('LCT015')
    await refreshDirectInventory(p, signal, { interfaces, fetch: request })
    expect(request).not.toHaveBeenCalled()
})

it('does not store a Hue key when consent changes during the registration response', async () => {
    const p = root(), d = addHue(p), local = approve(p, d.id, 'local')
    requestHuePairing(p, local, owner.principalId)
    const request = vi.fn(async (url: any) => {
        if (String(url).endsWith('/api/config')) return json(hue)
        chooseSmartRoute(p, d.id, 'cloud', owner)
        return json([{ success: { username: 'notStoredKey123456789' } }])
    })
    await refreshDirectInventory(p, new AbortController().signal, { interfaces, fetch: request })
    expect(existsSync(join(p, 'secrets', 'smart-devices', d.id + '.json'))).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
})

it('expired pairing and unapproved cloud never create a local registration fallback', async () => {
    const p = root(), d = addHue(p), local = approve(p, d.id, 'local')
    requestHuePairing(p, local, owner.principalId, Date.now() - 121_000)
    const request = vi.fn(async () => json(hue))
    expect((await refreshDirectInventory(p, new AbortController().signal, { interfaces, fetch: request }))[0].status).toBe('access-required')
    expect(request).toHaveBeenCalledTimes(1)
    approve(p, d.id, 'cloud'); request.mockClear()
    await refreshDirectInventory(p, new AbortController().signal, { interfaces, fetch: request })
    expect(request).not.toHaveBeenCalled()
})

it('reports protocol functions rather than inventing a plug type or OEM', () => {
    expect(parseDirectFunctions('shelly', { 'switch:0': { id: 0, output: false }, 'input:0': { id: 0, state: false } }).map(f => f.kind)).toEqual(['switch', 'input'])
    expect(parseDirectFunctions('tasmota', { StatusSTS: { POWER: 'OFF' } })).toEqual([{ id: 'POWER', kind: 'switch', name: 'Tasmota POWER' }])
    expect(() => parseDirectFunctions('hue', [{ error: { type: 1 } }])).toThrow()
    expect(() => parseDirectFunctions('shelly', { code: 401 })).toThrow()
    expect(() => parseDirectFunctions('tasmota', { StatusSTS: {} })).toThrow()
})

it('Tuya cloud uses only fixed signed GETs for the selected device and leaves unknown functions unknown', async () => {
    const request = vi.fn(async (url: any, options: any) => {
        expect(options).toMatchObject({ method: 'GET', redirect: 'manual' })
        expect(options.headers.sign).toMatch(/^[A-F0-9]{64}$/)
        return String(url).includes('/token?') ? json({ success: true, result: { access_token: 'privateTestToken123' } })
            : json({ success: true, result: { functions: [{ code: 'switch_led', type: 'Boolean' }, { code: 'mystery', type: 'Integer' }] } })
    })
    const rows = await readTuyaCloudFunctions('selectedDevice123', new AbortController().signal, { env: { TUYA_API_REGION: 'eu', TUYA_ACCESS_ID: 'testClient', TUYA_ACCESS_SECRET: 'testSecret' }, fetch: request, now: () => 123456789 })
    expect(request.mock.calls.map(c => c[0])).toEqual(['https://openapi.tuyaeu.com/v1.0/token?grant_type=1', 'https://openapi.tuyaeu.com/v1.0/devices/selectedDevice123/specifications'])
    expect(rows.map(f => f.kind)).toEqual(['light', 'unknown'])
    expect(JSON.stringify(rows)).not.toContain('privateTestToken123')
})

it('missing Tuya cloud access, arbitrary regions and aborted requests do not issue requests', async () => {
    const request = vi.fn(), signal = AbortSignal.abort()
    for (const env of [{}, { TUYA_API_REGION: 'https://evil.invalid', TUYA_ACCESS_ID: 'id', TUYA_ACCESS_SECRET: 'secret' }, { TUYA_API_REGION: 'eu', TUYA_ACCESS_ID: 'id', TUYA_ACCESS_SECRET: 'secret' }])
        await expect(readTuyaCloudFunctions('selectedDevice123', signal, { env, fetch: request })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
})
