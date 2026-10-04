import express from 'express'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { registerSmartAccessApi } from './smart-access-api.js'
import { recordCandidates, approveDevice, loadDevices, sensingDeviceFingerprint } from './device-registry.js'
import { chooseSmartRoute, approveSmartRoute } from './smart-device-route.js'

it('authenticates and fences secret submission, never returns entered credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smart-api-')), app = express(), owner = { permission: 'owner', principalId: 'owner' }
    const d = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 6668, via: 'udp', hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'tuya12345678', connector: 'tuya-announcements', observedAt: new Date().toISOString() } }])[0]
    chooseSmartRoute(root, d.id, 'local', owner); approveDevice(root, d.id, owner); approveSmartRoute(root, loadDevices(root)[0], 'local', owner.principalId)
    let authoritative = false
    app.use(express.json({ limit: '8kb' }))
    registerSmartAccessApi(app, { root: () => root, owner: async () => owner, authoritative: () => authoritative,
        ownerOnly: (req, res) => { if (req.headers.authorization === 'Bearer test-owner') return true; res.status(403).end(); return false } })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/desktop/smart-geraete`
    const key = 'a'.repeat(16), body = { fingerprint: sensingDeviceFingerprint(loadDevices(root)[0]), values: { key, version: '3.3' } }
    const request = (auth = true) => fetch(`${base}/${d.id}/zugang`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-owner' } : {}) }, body: JSON.stringify(body) })
    try {
        expect((await request(false)).status).toBe(403)
        expect((await request()).status).toBe(409)
        authoritative = true
        const reply = await request(); expect(reply.status).toBe(200); expect(await reply.text()).not.toContain(key)
        const view = await fetch(base, { headers: { Authorization: 'Bearer test-owner' } })
        const text = await view.text(); expect(text).not.toContain(key); expect(JSON.parse(text).devices[0].accessStored).toBe(true)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
it('the HTTP control path never writes on preparation and requires separate owner confirmation exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-api-')), app = express(), owner = { permission: 'owner', principalId: 'owner' }
    const found = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 80, via: 'http', hardware: { kind: 'plug', label: 'Shelly', certainty: 'confirmed', identity: 'shellyplus1-b48a0a1cd978', connector: 'shelly-readonly', probe: 'shelly-info', observedAt: new Date().toISOString() } }])[0]
    chooseSmartRoute(root, found.id, 'local', owner); approveDevice(root, found.id, owner); const d = loadDevices(root)[0]; approveSmartRoute(root, d, 'local', 'owner')
    mkdirSync(join(root, 'sensing'), { recursive: true }); writeFileSync(join(root, 'sensing', 'direct-inventory.json'), JSON.stringify({ devices: [{ deviceId: d.id, fingerprint: sensingDeviceFingerprint(d), approvedAt: d.approvedAt, protocol: 'shelly', status: 'ok', at: new Date().toISOString(), functions: [{ id: 'switch:0', kind: 'switch', name: 'Output', available: true }] }] }))
    let authority = true
    const execute = vi.fn(async (_root, _d, a, _signal, authorize) => { expect(authorize()).toBe(true); expect(a.on).toBe(true); return true })
    app.use(express.json({ limit: '8kb' }))
    registerSmartAccessApi(app, { root: () => root, owner: async () => owner, authoritative: () => authority, controlExecute: execute,
        ownerOnly: (req, res) => { if (req.headers.authorization === 'owner') return true; res.status(403).end(); return false } })
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/desktop`
    const post = (url: string, body: object, auth = true) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'owner' } : {}) }, body: JSON.stringify(body) })
    try {
        expect((await post(`/smart-geraete/${d.id}/aktion`, { functionId: 'switch:0', on: true }, false)).status).toBe(403)
        const p = await (await post(`/smart-geraete/${d.id}/aktion`, { functionId: 'switch:0', on: true })).json() as any
        expect(p.ok).toBe(true); expect(execute).not.toHaveBeenCalled()
        const url = `/smart-aktionen/${p.confirmationId}/bestaetigen`
        expect((await post(url, {})).status).toBe(409); authority = false
        expect((await post(url, { confirm: 'ja' })).status).toBe(409); expect(execute).not.toHaveBeenCalled()
        authority = true; expect((await post(url, { confirm: 'ja' })).status).toBe(200)
        expect((await post(url, { confirm: 'ja' })).status).toBe(409); expect(execute).toHaveBeenCalledOnce()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
it('requires a separate Matter pairing confirmation and rejects completion after Main authority loss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'matter-api-')), app = express(), owner = { permission: 'owner', principalId: 'owner' }
    const found = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter', certainty: 'probable', identity: 'device', connector: 'matter-ip', ecosystem: 'matter', observedAt: new Date().toISOString() } }])[0]
    chooseSmartRoute(root, found.id, 'local', owner); approveDevice(root, found.id, owner); approveSmartRoute(root, loadDevices(root)[0], 'local', 'owner')
    let authoritative = true
    const matterRead = vi.fn(async (_input, _storage, _signal, authorize) => {
        expect(authorize()).toBe(true)
        authoritative = false
        return { peerId: 'peer-1', functions: [] }
    })
    app.use(express.json({ limit: '8kb' }))
    registerSmartAccessApi(app, { root: () => root, owner: async () => owner, authoritative: () => authoritative, ownerOnly: () => true, matterRead })
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/desktop/smart-geraete`
    const code = '34970112332', fingerprint = sensingDeviceFingerprint(loadDevices(root)[0])
    const post = (values: any) => fetch(`${base}/${found.id}/zugang`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint, values }) })
    try {
        expect((await post({ pairingCode: code })).status).toBe(409); expect(matterRead).not.toHaveBeenCalled()
        const reply = await post({ pairingCode: code, confirmPairing: 'ja' }); expect(reply.status).toBe(409); expect(await reply.text()).not.toContain(code)
        const view = await fetch(base); const text = await view.text()
        expect(text).not.toContain(code); expect(JSON.parse(text).devices[0].accessState).toBe('unclear')
        authoritative = true
        expect((await post({ pairingCode: code, confirmPairing: 'ja' })).status).toBe(409); expect(matterRead).toHaveBeenCalledOnce()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
