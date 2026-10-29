import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { verifiedMeshOwnerRequest } from './mesh-transport-runtime.js'
import { isConfiguredOwner, reconcileConfiguredOwner, runAsVerifiedMeshOwner, type UserRecord } from '../users/multi-user-middleware.js'

// 2.90.1 (Peer-Test 29.10. 13:50): the Main sends the owner's user id with a signed agent.request, but the peer
// checked allowFrom only on channel "telegram" - every mesh task ran as guest. The owner holds on the peer only
// for a signed agent.request from a configured peer with a pinned key whose user id is the configured owner,
// and only for that one request. Never for unsigned, foreign or unpinned ways.
const OWNER = '1000000001'
const allowFrom = [OWNER]
const dir = () => mkdtempSync(join(tmpdir(), 'mesh-owner-'))
const main = new MeshIdentity('main-node', dir())
const stranger = new MeshIdentity('main-node', dir())
const principal = { id: 'node:main-node', role: 'system' as const, channel: 'mesh' }
const request = (identity: MeshIdentity, userId: string, kind: any = 'agent.request') =>
    identity.create({ kind, targetNode: 'peer-node', principal, payload: { prompt: 'uptime', idempotencyKey: 'k', userId } })
const peers = [{ nodeId: 'main-node', transport: 'direct' as const, status: 'unknown' as const, publicKey: main.publicKey, roles: ['system' as const] }]

describe('owner on a peer only for a signed request from a pinned peer', () => {
    it('a signed agent.request from the pinned Main with the configured owner is the owner', () => {
        expect(verifiedMeshOwnerRequest(request(main, OWNER), peers, allowFrom)).toBe(true)
    })
    it('the same user id signed with another key stays guest', () => {
        expect(verifiedMeshOwnerRequest(request(stranger, OWNER), peers, allowFrom)).toBe(false)
    })
    it('a peer without a pinned key, an unknown node or a TOFU key is never trusted for the owner', () => {
        expect(verifiedMeshOwnerRequest(request(main, OWNER), [{ ...peers[0], publicKey: undefined }], allowFrom)).toBe(false)
        expect(verifiedMeshOwnerRequest(request(main, OWNER), [], allowFrom)).toBe(false)
    })
    it('a user id that is not the configured owner stays guest', () => {
        expect(verifiedMeshOwnerRequest(request(main, '1000000002'), peers, allowFrom)).toBe(false)
        expect(verifiedMeshOwnerRequest(request(main, `telegram:${OWNER}:x`), peers, allowFrom)).toBe(false)
        expect(verifiedMeshOwnerRequest(request(main, OWNER), peers, [])).toBe(false)
    })
    it('a changed user id after signing or another envelope kind is refused', () => {
        const forged = request(main, '1000000002')
        ;(forged.payload as any).userId = OWNER
        expect(verifiedMeshOwnerRequest(forged, peers, allowFrom)).toBe(false)
        expect(verifiedMeshOwnerRequest(request(main, OWNER, 'tool.request'), peers, allowFrom)).toBe(false)
    })
})

describe('the mesh owner grant holds for exactly one request', () => {
    it('mesh-direct is never owner outside a verified request, whatever the user id', () => {
        expect(isConfiguredOwner(OWNER, 'mesh-direct', allowFrom)).toBe(false)
        expect(isConfiguredOwner(OWNER, 'mesh', allowFrom)).toBe(false)
    })
    it('inside the verified request only that user id is owner', async () => {
        await runAsVerifiedMeshOwner(OWNER, async () => {
            await Promise.resolve()
            expect(isConfiguredOwner(OWNER, 'mesh-direct', allowFrom)).toBe(true)
            expect(isConfiguredOwner('1000000002', 'mesh-direct', allowFrom)).toBe(false)
            expect(isConfiguredOwner(OWNER, 'rest-api', allowFrom)).toBe(false)
        })
        expect(isConfiguredOwner(OWNER, 'mesh-direct', allowFrom)).toBe(false)
    })
    it('a stored owner record of a mesh user falls back to guest outside the request', () => {
        const record: UserRecord = { id: OWNER, permission: 'owner', permissionSource: 'configured', firstSeen: 0, lastSeen: 0, messageCount: 1, channel: 'mesh-direct', onboarded: true }
        expect(reconcileConfiguredOwner(record, allowFrom).user.permission).toBe('guest')
        expect(runAsVerifiedMeshOwner(OWNER, () => reconcileConfiguredOwner({ ...record, permission: 'guest', permissionSource: undefined }, allowFrom).user.permission)).toBe('owner')
    })
})
