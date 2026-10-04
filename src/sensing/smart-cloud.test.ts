import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, expect, vi } from 'vitest'
import { recordCandidates, loadDevices, approveDevice, sensingDeviceFingerprint } from './device-registry.js'
import { chooseSmartRoute, approveSmartRoute } from './smart-device-route.js'
import { submitSmartCloudAccess, getShellyCloudAccess, getTuyaCloudAccess, validShellyCloudHost } from './smart-device-access.js'
import { refreshDirectInventory } from './direct-smart-devices.js'
import { readShellyCloudFunctions } from './shelly-cloud-inventory.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const owner = { permission: 'owner', principalId: 'owner' }
const key = 'private_cloud_key_12345'
function fixture(connector: 'shelly-readonly' | 'tuya-announcements' = 'shelly-readonly') {
    const root = mkdtempSync(join(tmpdir(), 'cloud-device-')); roots.push(root)
    const d = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 80, via: 'http', hardware: {
        kind: 'unknown', label: 'Device', certainty: 'confirmed', connector, identity: connector === 'shelly-readonly' ? 'shellyplus1-b48a0a1cd978' : 'tuya123456789', observedAt: new Date().toISOString(),
    } }])[0]
    chooseSmartRoute(root, d.id, 'cloud', owner); approveDevice(root, d.id, owner)
    const approved = loadDevices(root)[0]; approveSmartRoute(root, approved, 'cloud', owner.principalId)
    return { root, d: approved, fp: sensingDeviceFingerprint(approved) }
}
it('rejects arbitrary cloud URLs and binds private keys to the current owner/identity/route', () => {
    const { root, d, fp } = fixture(), value = { host: 'shelly-13-eu.shelly.cloud', key }
    for (const host of ['evil.example', 'shelly-13-eu.shelly.cloud.evil.example', 'https://shelly-13-eu.shelly.cloud', '127.0.0.1', 'shelly-13-eu.shelly.cloud:443', 'shelly-13-eu.shelly.cloud@evil.example']) expect(validShellyCloudHost(host)).toBe(false)
    expect(submitSmartCloudAccess(root, d.id, fp, value, { ...owner, permission: 'user' }).ok).toBe(false)
    expect(submitSmartCloudAccess(root, d.id, 'old', value, owner).ok).toBe(false)
    expect(submitSmartCloudAccess(root, d.id, fp, value, owner).ok).toBe(true)
    expect(getShellyCloudAccess(root, d)).toEqual(value)
    expect(readFileSync(join(root, 'sensing', 'smart-routes.json'), 'utf8')).not.toContain(key)
    chooseSmartRoute(root, d.id, 'local', owner); expect(getShellyCloudAccess(root, d)).toBeUndefined()
})
it('uses v2 selected-device status only, validates returned identity and records functions without secrets', async () => {
    const { root, d, fp } = fixture(), value = { host: 'shelly-13-eu.shelly.cloud', key }
    submitSmartCloudAccess(root, d.id, fp, value, owner)
    const fetch = vi.fn(async (url, options) => {
        expect(String(url)).toBe(`https://${value.host}/v2/devices/api/get?auth_key=${key}`)
        expect(options).toMatchObject({ method: 'POST', redirect: 'manual' })
        expect(JSON.parse(options.body)).toEqual({ ids: ['b48a0a1cd978'], select: ['status'] })
        return new Response(JSON.stringify([{ id: 'b48a0a1cd978', online: 1, status: { sys: { mac: 'B48A0A1CD978', uptime: 4 }, 'switch:0': { id: 0, output: true } } }]))
    })
    const [row] = await refreshDirectInventory(root, new AbortController().signal, { fetch: fetch as any })
    expect(row).toMatchObject({ protocol: 'shelly-cloud', status: 'ok', functions: [{ id: 'switch:0', kind: 'switch', available: true }] })
    expect(readFileSync(join(root, 'sensing', 'direct-inventory.json'), 'utf8')).not.toContain(key)
})
it('rejects identity substitution and consent revocation during a cloud response', async () => {
    const access = { host: 'shelly-13-eu.shelly.cloud', key: key + '_different' }
    await expect(readShellyCloudFunctions('b48a0a1cd978', access, new AbortController().signal, (async () => new Response(JSON.stringify([{ id: '112233445566', online: 1, status: { uptime: 1 } }]))) as any)).rejects.toThrow('read failed')
    const { root, d, fp } = fixture(); submitSmartCloudAccess(root, d.id, fp, { ...access, key: key + '_third' }, owner)
    const [row] = await refreshDirectInventory(root, new AbortController().signal, { fetch: (async () => {
        chooseSmartRoute(root, d.id, 'local', owner)
        return new Response(JSON.stringify([{ id: 'b48a0a1cd978', online: 1, status: { uptime: 1 } }]))
    }) as any })
    expect(row.status).not.toBe('ok'); expect(row.functions).toEqual([])
})
it('stores Tuya cloud access independently of local keys and rejects missing fields', () => {
    const { root, d, fp } = fixture('tuya-announcements')
    expect(submitSmartCloudAccess(root, d.id, fp, { region: 'eu' }, owner).ok).toBe(false)
    const access = { client: 'testclient123', secret: key, region: 'eu' }
    expect(submitSmartCloudAccess(root, d.id, fp, access, owner).ok).toBe(true)
    expect(getTuyaCloudAccess(root, d)).toEqual(access)
})
