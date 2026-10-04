import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, vi, afterEach } from 'vitest'
import { readTuyaSdk, readEspHomeSdk } from './smart-native-worker.js'
import { readLocalTuya } from './smart-native-client.js'
import { getTuyaLocalAccess, submitTuyaLocalAccess } from './smart-device-access.js'
import { recordCandidates, loadDevices, approveDevice, sensingDeviceFingerprint } from './device-registry.js'
import { chooseSmartRoute, approveSmartRoute } from './smart-device-route.js'
import { refreshDirectInventory } from './direct-smart-devices.js'
import { verifyHardwareConnection } from './hardware-recognition.js'
import { discoverDevices } from './discovery.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
const owner = { permission: 'owner', principalId: 'owner' }
const input = { host: '192.168.1.21', identity: 'tuya123456789', key: 'a'.repeat(16), version: '3.4' }
const interfaces = { eth: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'tuya-native-')); roots.push(root)
    const d = recordCandidates(root, [{ type: 'networkservice', host: input.host, port: 6668, via: 'udp', hardware: {
        kind: 'unknown', label: 'Tuya', certainty: 'confirmed', connector: 'tuya-announcements', ecosystem: 'tuya', identity: input.identity, observedAt: new Date().toISOString(),
    } }])[0]
    chooseSmartRoute(root, d.id, 'local', owner); approveDevice(root, d.id, owner)
    const approved = loadDevices(root)[0]; approveSmartRoute(root, approved, 'local', owner.principalId)
    return { root, d: approved, fingerprint: sensingDeviceFingerprint(approved) }
}
it('reads datapoints without inventing device types or emitting raw state and secrets', async () => {
    const disconnect = vi.fn(), set = vi.fn(), connect = vi.fn()
    const factory = vi.fn(options => ({ connect, disconnect, set, on: vi.fn(), get: async () => ({ dps: { 1: true, 2: 'secret-state', 3: 45, bad: true, 4: { key: input.key } } }) }))
    const result = await readTuyaSdk(input, factory)
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ issueGetOnConnect: false, issueRefreshOnConnect: false, issueRefreshOnPing: false }))
    expect(result.map(d => d.id)).toEqual(['dp:1', 'dp:2', 'dp:3'])
    expect(result.every(d => d.kind === 'unknown')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-state'); expect(set).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce()
})
it('blocks SDK get-to-CONTROL fallback and always disconnects', async () => {
    const set = vi.fn(), disconnect = vi.fn()
    const device: any = { set, disconnect, connect: async () => {}, on: vi.fn(), get: async () => device.set({ dps: { 1: null } }) }
    await expect(readTuyaSdk(input, () => device)).rejects.toThrow('rejects CONTROL')
    expect(set).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce()
    await expect(readTuyaSdk({ ...input, version: '3.2' }, () => device)).rejects.toThrow('Invalid Tuya access')
})
it('rejects an ESPHome plaintext fallback before a second socket is opened', async () => {
    const psk = Buffer.alloc(32, 1).toString('base64'), open = vi.fn(async () => ({})), disconnect = vi.fn()
    const create = (options: any) => ({ disconnect, connect: async () => { await options.transportFactory({}); await options.transportFactory({}) } })
    await expect(readEspHomeSdk({ host: input.host, port: 6053, psk, identity: 'lamp' }, create, open)).rejects.toThrow('fallback denied')
    expect(open).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce()
})
it('reports authenticated ESPHome entity types, never controls entities, and validates identity', async () => {
    const psk = Buffer.alloc(32, 1).toString('base64'), disconnect = vi.fn(), command = vi.fn()
    const create = vi.fn(options => ({ connect: async () => {}, disconnect, command, health: () => ({ encrypted: true }), deviceInfo: () => ({ name: 'lamp', manufacturer: 'Test', model: 'ESP32' }), getEntitiesWithIds: () => [{ id: 'light:1', type: 'light', name: 'Desk' }, { id: 'sensor:2', type: 'sensor', name: 'Temperature' }] }))
    const rows = await readEspHomeSdk({ host: input.host, port: 6053, psk, identity: 'lamp' }, create, async () => ({}))
    expect(rows.map(r => r.kind)).toEqual(['light', 'sensor']); expect(command).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ reconnect: false, keepAlive: false, serverName: 'lamp' }))
    await expect(readEspHomeSdk({ host: input.host, port: 6053, psk, identity: 'other' }, create, async () => ({}))).rejects.toThrow('identity changed')
})
it('rejects public targets and aborted requests before worker creation', async () => {
    await expect(readLocalTuya({ ...input, host: '8.8.8.8' }, new AbortController().signal, interfaces)).rejects.toThrow('scope')
    const controller = new AbortController(); controller.abort()
    await expect(readLocalTuya(input, controller.signal, interfaces)).rejects.toThrow()
})
it('accepts secrets only for the approved identity and route, without exposing them in observations', async () => {
    const { root, d, fingerprint } = fixture(), value = { key: input.key, version: input.version }
    expect(submitTuyaLocalAccess(root, d.id, fingerprint, value, { ...owner, permission: 'user' }).ok).toBe(false)
    expect(submitTuyaLocalAccess(root, d.id, 'wrong', value, owner).ok).toBe(false)
    expect(submitTuyaLocalAccess(root, d.id, fingerprint, { ...value, version: '3.2' }, owner).ok).toBe(false)
    expect(submitTuyaLocalAccess(root, d.id, fingerprint, value, owner).ok).toBe(true)
    expect(getTuyaLocalAccess(root, d)).toEqual(value)
    const read = vi.fn(async () => [{ id: 'dp:1', kind: 'unknown' as const, name: 'Datenpunkt 1', available: true }])
    expect((await refreshDirectInventory(root, new AbortController().signal, { interfaces, tuyaRead: read }))[0].status).toBe('ok')
    expect(read).toHaveBeenCalledOnce()
    expect(readFileSync(join(root, 'sensing', 'direct-inventory.json'), 'utf8')).not.toContain(input.key)
    chooseSmartRoute(root, d.id, 'cloud', owner)
    expect(getTuyaLocalAccess(root, d)).toBeUndefined()
})
it('does not report success when approval changes during a local read', async () => {
    const { root, d, fingerprint } = fixture()
    submitTuyaLocalAccess(root, d.id, fingerprint, input, owner)
    const read = vi.fn(async () => { chooseSmartRoute(root, d.id, 'cloud', owner); return [{ id: 'dp:1', kind: 'unknown' as const, name: 'Datenpunkt', available: true }] })
    const [row] = await refreshDirectInventory(root, new AbortController().signal, { interfaces, tuyaRead: read })
    expect(row.status).not.toBe('ok'); expect(row.functions).toEqual([])
})
it('invalidates measured inventory when the local key is replaced', async () => {
    const { root, d, fingerprint } = fixture()
    submitTuyaLocalAccess(root, d.id, fingerprint, input, owner)
    const read = vi.fn(async () => [{ id: 'dp:1', kind: 'unknown' as const, name: 'Datenpunkt', available: true }])
    await refreshDirectInventory(root, new AbortController().signal, { interfaces, tuyaRead: read })
    submitTuyaLocalAccess(root, d.id, fingerprint, { ...input, key: 'b'.repeat(16) }, owner)
    read.mockRejectedValueOnce(new Error('Authentication failed'))
    const [row] = await refreshDirectInventory(root, new AbortController().signal, { interfaces, tuyaRead: read })
    expect(read).toHaveBeenCalledTimes(2); expect(row.status).not.toBe('ok')
})
it('offers an ESPHome mDNS endpoint without falsely confirming its physical type or credentials', async () => {
    const mdnsBrowse = async () => [{ type: 'networkservice' as const, host: input.host, port: 6053, name: 'lamp', hints: { service: '_esphomelib._tcp.local' } }]
    const report = await discoverDevices({ mdns: true, maxHosts: 1, deadlineMs: 1000, ratePerSec: 200, concurrency: 2, tailnetHosts: [] }, {
        interfaces, mdnsBrowse, neighbors: async () => [], tcpProbe: async () => false, httpProbe: async () => null,
    })
    const d = report.candidates.find(d => d.port === 6053)!
    expect(d.hardware).toMatchObject({ certainty: 'probable', kind: 'unknown', connector: 'esphome-native', identity: 'lamp' })
    expect(await verifyHardwareConnection(d, { interfaces, mdnsBrowse })).toBe(true)
    expect(await verifyHardwareConnection(d, { interfaces, mdnsBrowse: async () => [] })).toBe(false)
})
it('rotates bounded polls over all approved devices rather than starving the ninth device', async () => {
    const { root } = fixture()
    for (let index = 1; index < 12; index++) {
        const d = recordCandidates(root, [{ type: 'networkservice', host: `192.168.1.${21 + index}`, port: 6668, via: 'udp', hardware: {
            kind: 'unknown', label: 'Tuya', certainty: 'confirmed', connector: 'tuya-announcements', identity: `tuya1234567${index}`, observedAt: new Date().toISOString(),
        } }])[0]
        chooseSmartRoute(root, d.id, 'local', owner); approveDevice(root, d.id, owner); approveSmartRoute(root, loadDevices(root).find(v => v.id === d.id)!, 'local', owner.principalId)
    }
    for (const d of loadDevices(root)) submitTuyaLocalAccess(root, d.id, sensingDeviceFingerprint(d), input, owner)
    const read = vi.fn(async () => [{ id: 'dp:1', kind: 'unknown' as const, name: 'Datenpunkt', available: true }])
    for (let i = 0; i < 2; i++) await refreshDirectInventory(root, new AbortController().signal, { interfaces, tuyaRead: read })
    expect(read).toHaveBeenCalledTimes(12)
    const rows = JSON.parse(readFileSync(join(root, 'sensing', 'direct-inventory.json'), 'utf8')).devices
    expect(rows).toHaveLength(12)
    expect(new Set(rows.map((r: any) => r.deviceId)).size).toBe(12)
})
