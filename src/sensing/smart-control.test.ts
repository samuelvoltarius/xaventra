import { it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCandidates, approveDevice, loadDevices, sensingDeviceFingerprint, setDeviceStatus } from './device-registry.js'
import { chooseSmartRoute, approveSmartRoute } from './smart-device-route.js'
import { currentSmartFunctions, proposeSmartSwitch, confirmSmartSwitch } from './smart-control.js'
import { executeSmartSwitch } from './smart-control-http.js'
import { identifyHardware } from './hardware-recognition.js'
import { controlTuyaBoolean } from './tuya-cloud-inventory.js'
import { readEspHomeSdk } from './smart-native-worker.js'
import { nativeAccessRevision } from './smart-device-access.js'
import { controlShellyCloudBoolean } from './shelly-cloud-inventory.js'

const roots: string[] = [], owner = { principalId: 'owner', permission: 'owner' }
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
const interfaces = { eth: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const hue = { bridgeid: '001788fffe123456', modelid: 'BSB002', swversion: '1967054020' }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'smart-control-')); roots.push(root)
    const found = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 80, via: 'http', hardware: identifyHardware({ status: 200, body: JSON.stringify(hue) }, 'hue-config')! }])[0]
    chooseSmartRoute(root, found.id, 'local', owner); approveDevice(root, found.id, owner)
    const d = loadDevices(root)[0]; approveSmartRoute(root, d, 'local', owner.principalId)
    mkdirSync(join(root, 'secrets', 'smart-devices'), { recursive: true }); writeFileSync(join(root, 'secrets', 'smart-devices', `${d.id}.json`), JSON.stringify({ hueKey: 'a'.repeat(20) }))
    writeFileSync(join(root, 'sensing', 'direct-inventory.json'), JSON.stringify({ devices: [{ deviceId: d.id, fingerprint: sensingDeviceFingerprint(d), approvedAt: d.approvedAt, accessRevision: nativeAccessRevision(root, d), protocol: 'hue', status: 'ok', at: new Date().toISOString(), functions: [{ id: 'light:1', kind: 'light', name: 'Desk', available: true }] }] }))
    return { root, d, a: { deviceId: d.id, functionId: 'light:1', on: true } }
}
it('preparing cannot execute and requires current owner, function and Boolean state', () => {
    const { root, a } = fixture()
    expect(proposeSmartSwitch(root, a, { ...owner, permission: 'user' }).ok).toBe(false)
    expect(proposeSmartSwitch(root, { ...a, functionId: 'light:2' }, owner).ok).toBe(false)
    expect(proposeSmartSwitch(root, { ...a, on: 'true' }, owner).ok).toBe(false)
    const p = proposeSmartSwitch(root, a, owner)
    expect(p.ok).toBe(true); expect(p.message).toContain('Noch nicht ausgeführt')
})
it('claims once before awaiting, rejects duplicate confirmations and reports failed readback as unclear', async () => {
    const { root, a } = fixture(), p = proposeSmartSwitch(root, a, owner).proposal!
    let finish!: (v: boolean) => void
    const execute = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const first = confirmSmartSwitch(root, p.id, owner, () => true, execute)
    expect((await confirmSmartSwitch(root, p.id, owner, () => true, execute)).ok).toBe(false)
    finish(false); expect((await first).message).toContain('bereits erfolgt')
    expect((await confirmSmartSwitch(root, p.id, owner, () => true, execute)).ok).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
})
it('revocation, wrong owner, expiry and stale observations deny any physical write', async () => {
    const { root, d, a } = fixture(), p = proposeSmartSwitch(root, a, owner).proposal!, execute = vi.fn(async () => true)
    expect((await confirmSmartSwitch(root, p.id, { ...owner, principalId: 'other' }, () => true, execute)).ok).toBe(false)
    expect((await confirmSmartSwitch(root, p.id, owner, () => false, execute)).ok).toBe(false)
    expect((await confirmSmartSwitch(root, p.id, owner, () => true, execute, Date.now() + 121_000)).ok).toBe(false)
    expect(currentSmartFunctions(root, d, Date.now() + 121_000)).toEqual([])
    setDeviceStatus(root, d.id, 'aus', owner)
    expect((await confirmSmartSwitch(root, p.id, owner, () => true, execute)).ok).toBe(false); expect(execute).not.toHaveBeenCalled()
})
it('Hue uses exact PUT then fresh state read, never calls success on HTTP acknowledgment alone', async () => {
    const { root, d, a } = fixture(), calls: any[] = []
    const mock: any = async (url: string, options: any) => {
        calls.push([url, options])
        const data = url.endsWith('/api/config') ? hue : options.method === 'PUT' ? [{ success: { '/lights/1/state/on': true } }] : { state: { on: false, reachable: true } }
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    expect(await executeSmartSwitch(root, d, a, new AbortController().signal, () => true, { fetch: mock, interfaces })).toBe(false)
    const writes = calls.filter(c => c[1].method === 'PUT'); expect(writes).toHaveLength(1); expect(JSON.parse(writes[0][1].body)).toEqual({ on: true })
    expect(calls.at(-1)[0]).toContain('/lights/1'); expect(calls.every(c => c[1].redirect === 'manual')).toBe(true)
})
it('does not leak Hue key to a substituted target or issue a write after authority loss', async () => {
    const { root, d, a } = fixture(); let authority = true
    const mock = vi.fn(async () => { authority = false; return new Response(JSON.stringify(hue), { headers: { 'Content-Type': 'application/json' } }) })
    await expect(executeSmartSwitch(root, d, a, new AbortController().signal, () => authority, { fetch: mock, interfaces })).rejects.toThrow()
    expect(mock).toHaveBeenCalledOnce(); expect(mock.mock.calls[0][0]).not.toContain('privatekey')
})
it('Tuya cloud verifies Boolean schema and reads actual state after one signed command', async () => {
    const calls: any[] = []
    const mock: any = async (url: string, options: any) => {
        calls.push([url, options]); const result = url.includes('/token?') ? { access_token: 'token123456' } : url.endsWith('/specifications') ? { functions: [{ code: 'switch_led', type: 'Boolean' }] } : url.endsWith('/commands') ? true : [{ code: 'switch_led', value: true }]
        return new Response(JSON.stringify({ success: true, result }), { headers: { 'Content-Type': 'application/json' } })
    }
    expect(await controlTuyaBoolean('device12345', 'switch_led', true, { client: 'client12345', secret: 'secret12345', region: 'eu' }, new AbortController().signal, mock)).toBe(true)
    const command = calls.find(c => c[1].method === 'POST'); expect(JSON.parse(command[1].body)).toEqual({ commands: [{ code: 'switch_led', value: true }] }); expect(command[1].headers.sign).toMatch(/^[A-F0-9]{64}$/)
    await expect(controlTuyaBoolean('device12345', 'unlock', true, { client: 'client12345', secret: 'secret12345', region: 'eu' }, new AbortController().signal, mock)).rejects.toThrow()
    expect(calls.filter(c => c[1].method === 'POST')).toHaveLength(1)
})
it('ESPHome requires separate just-in-time control permission and measured state feedback', async () => {
    const psk = Buffer.alloc(32, 1).toString('base64'), command = vi.fn(async () => ({ state: true })), disconnect = vi.fn()
    const create = () => ({ connect: async () => {}, disconnect, health: () => ({ encrypted: true }), deviceInfo: () => ({ name: 'lamp' }), getEntitiesWithIds: () => [{ id: 'switch-desk', type: 'switch', name: 'Desk' }], commandAndAwait: command })
    const input = { host: '192.168.1.21', port: 6053, psk, identity: 'lamp', action: { functionId: 'entity:switch-desk', on: true } }
    await expect(readEspHomeSdk(input, create, async () => ({}))).rejects.toThrow('permission'); expect(command).not.toHaveBeenCalled()
    expect((await readEspHomeSdk(input, create, async () => ({}), async () => true))[0].confirmedOn).toBe(true)
    command.mockResolvedValueOnce({ state: false }); await expect(readEspHomeSdk(input, create, async () => ({}), async () => true)).rejects.toThrow('not confirmed')
})
it('Shelly cloud respects the shared one-request-per-second gate and requires matching selected-device state', async () => {
    const times: number[] = [], calls: any[] = []
    const mock: any = async (url: string, options: any) => {
        times.push(Date.now()); calls.push([url, options])
        return url.includes('/set/') ? new Response('{}') : new Response(JSON.stringify([{ id: 'b48a0a1cd978', online: 1, status: { sys: { mac: 'B48A0A1CD978' }, 'switch:0': { id: 0, output: calls.length > 1 } } }]))
    }
    expect(await controlShellyCloudBoolean('shellyplus1-b48a0a1cd978', 'switch:0', true, { host: 'shelly-13-eu.shelly.cloud', key: 'private_control_key' }, new AbortController().signal, mock)).toBe(true)
    expect(calls).toHaveLength(3); expect(times[1] - times[0]).toBeGreaterThanOrEqual(950); expect(times[2] - times[1]).toBeGreaterThanOrEqual(950)
    expect(JSON.parse(calls[1][1].body)).toEqual({ id: 'b48a0a1cd978', channel: 0, on: true })
})
it.each([
    ['shelly-info', { id: 'shellyplus1-b48a0a1cd978', model: 'SNPL-00112EU', gen: 2 }, 'switch:0', { 'switch:0': { id: 0, output: false } }, { 'switch:0': { id: 0, output: true } }, '/rpc/Switch.Set'],
    ['shelly-gen1', { mac: 'b48a0a1cd978', type: 'SHPLG-S' }, 'relays:0', { relays: [{ ison: false }] }, { relays: [{ ison: true }] }, '/relay/0?turn=on'],
    ['tasmota-info', { Status: { Module: 1 }, StatusFWR: { Version: '14.0.0(release)' }, StatusNET: { Mac: 'b4:8a:0a:1c:d9:78' } }, 'POWER1', { StatusSTS: { POWER1: 'OFF' } }, { StatusSTS: { POWER1: 'ON' } }, '/cm?cmnd=POWER1%20ON'],
])('executes the exact %s output and reads back independently', async (probe, identity, functionId, before, after, writePath) => {
    const root = mkdtempSync(join(tmpdir(), 'switch-http-')); roots.push(root)
    const found = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 80, via: 'http', hardware: identifyHardware({ status: 200, body: JSON.stringify(identity) }, probe as any)! }])[0]
    chooseSmartRoute(root, found.id, 'local', owner); approveDevice(root, found.id, owner); const d = loadDevices(root)[0]; approveSmartRoute(root, d, 'local', 'owner')
    let reads = 0; const calls: any[] = []
    const mock: any = async (url: string, options: any) => {
        calls.push([url, options]); const step = calls.length
        const data = step === 1 ? identity : url.endsWith(writePath) ? {} : ++reads === 1 ? before : after
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    expect(await executeSmartSwitch(root, d, { deviceId: d.id, functionId: String(functionId), on: true }, new AbortController().signal, () => true, { interfaces, fetch: mock })).toBe(true)
    expect(calls.filter(c => c[0].endsWith(writePath))).toHaveLength(1); expect(reads).toBe(2)
})
