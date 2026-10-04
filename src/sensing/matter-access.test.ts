import { it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCandidates, approveDevice, loadDevices, sensingDeviceFingerprint } from './device-registry.js'
import { chooseSmartRoute, approveSmartRoute } from './smart-device-route.js'
import { submitMatterAccess, getMatterAccess, beginMatterAttempt, finishMatterAttempt, matterFabricPath } from './smart-device-access.js'
it('requires explicit private pairing consent, claims once, consumes code, preserves ambiguous fabric state', () => {
    const root = mkdtempSync(join(tmpdir(), 'matter-private-')), owner = { permission: 'owner', principalId: 'owner' }
    try {
        const found = recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.21', port: 5540, via: 'mdns', hardware: { kind: 'unknown', certainty: 'probable', label: 'Matter', connector: 'matter-ip', ecosystem: 'matter', identity: 'device', observedAt: new Date().toISOString() } }])[0]
        chooseSmartRoute(root, found.id, 'local', owner); approveDevice(root, found.id, owner)
        const d = loadDevices(root)[0]; approveSmartRoute(root, d, 'local', 'owner')
        const fp = sensingDeviceFingerprint(d), code = '34970112332'
        expect(submitMatterAccess(root, d.id, fp, { pairingCode: code }, owner).ok).toBe(false)
        expect(submitMatterAccess(root, d.id, fp, { pairingCode: code, confirmPairing: 'ja' }, { ...owner, permission: 'user' }).ok).toBe(false)
        expect(submitMatterAccess(root, d.id, fp, { pairingCode: code, confirmPairing: 'ja' }, owner).ok).toBe(true)
        const access = beginMatterAttempt(root, d)!
        expect(beginMatterAttempt(root, d)).toBeUndefined()
        expect(matterFabricPath(root, d, access.revision)).toContain(join('secrets', 'matter-fabrics', d.id))
        finishMatterAttempt(root, d, access.revision)
        expect(getMatterAccess(root, d)?.state).toBe('unclear')
        expect(readFileSync(join(root, 'secrets', 'smart-devices', d.id + '.json'), 'utf8')).not.toContain(code)
        expect(submitMatterAccess(root, d.id, fp, { pairingCode: code, confirmPairing: 'ja' }, owner).ok).toBe(false)
        chooseSmartRoute(root, d.id, 'cloud', owner); expect(getMatterAccess(root, d)).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
})
