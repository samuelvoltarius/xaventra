import { mkdtempSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { MeshPolicy } from './mesh-policy.js'
import { isSafeMeshKind, type MeshRole } from './transport-contracts.js'
import { JournalReplica, StateJournalWriter, deriveJournalKey, signerFromMeshIdentity } from './state-journal.js'
import { EmergencyReleaseGate, issueEmergencyCode } from './emergency-release.js'
import { ShareHolder, createShareKeyPair, sealSecretVault } from './secret-shares.js'
import { createMeshSuccessionPeer, handleSuccessionRequest, registerSuccessionEndpoint, type SuccessionSend } from './succession-transport.js'

afterEach(() => registerSuccessionEndpoint(null))

describe('succession over the mesh channel', () => {
    it('is a known envelope kind that only system principals may send', () => {
        expect(isSafeMeshKind('succession.request')).toBe(true)
        const worker = new MeshIdentity('ns1', mkdtempSync(join(tmpdir(), 'xaventra-succ-policy-')))
        const policyFor = (roles: MeshRole[]) => new MeshPolicy({ mode: 'direct', peers: [{ nodeId: 'ns1', transport: 'direct', status: 'unknown', publicKey: worker.publicKey, roles }] }, 'spark')
        const envelope = (role: MeshRole) => worker.create({ kind: 'succession.request', targetNode: 'spark', principal: { id: 'succession', role }, payload: { op: 'export', idempotencyKey: `k-${role}` } })
        expect(policyFor(['worker']).verify(envelope('worker')).accepted).toBe(false)
        expect(policyFor(['worker']).verify(envelope('system')).accepted).toBe(false)
        expect(policyFor(['system', 'worker']).verify(envelope('worker')).accepted).toBe(false)
        expect(policyFor(['system', 'worker']).verify(envelope('system')).accepted).toBe(true)
    })

    it('fails closed without a registered endpoint and validates requests', async () => {
        expect(await handleSuccessionRequest({ op: 'export', idempotencyKey: 'a' }, 'ns1')).toMatchObject({ success: false, error: 'succession not active on this node' })
        registerSuccessionEndpoint({ replica: new JournalReplica({ nodeId: 'nas', trusted: {} }) })
        expect(await handleSuccessionRequest({ op: 'rm -rf', idempotencyKey: 'a' }, 'ns1')).toMatchObject({ success: false })
        expect(await handleSuccessionRequest({ op: 'share', idempotencyKey: 'a', body: { requester: 'ns1' } }, 'ns1')).toMatchObject({ success: false })
    })

    it('releases a share only to the verified envelope sender', async () => {
        const keys = { nas: createShareKeyPair(), ns1: createShareKeyPair() }
        const sealed = sealSecretVault({ A: randomBytes(8).toString('hex') }, [{ nodeId: 'nas', publicKey: keys.nas.publicKey }, { nodeId: 'ns1', publicKey: keys.ns1.publicKey }], 2)
        registerSuccessionEndpoint({
            replica: new JournalReplica({ nodeId: 'nas', trusted: {} }),
            shareHolder: new ShareHolder({ nodeId: 'nas', keyPair: keys.nas, sealedShare: sealed.sealedShares.nas, verifyMainClaim: () => true }),
        })
        const body = { requester: 'ns1', requesterPublicKey: keys.ns1.publicKey, epoch: 3 }
        expect(await handleSuccessionRequest({ op: 'share', idempotencyKey: 's1', body }, 'lab')).toMatchObject({ success: false, error: 'share request refused' })
        const granted = await handleSuccessionRequest({ op: 'share', idempotencyKey: 's2', body }, 'ns1')
        expect(granted.success).toBe(true)
        expect((granted.result as { ok: boolean }).ok).toBe(true)
    })

    it('replicates signed journal entries and binds requests to the verified sender', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-succ-transport-'))
        const spark = new MeshIdentity('spark', dir)
        const trusted = { spark: spark.publicKey }
        const nasReplica = new JournalReplica({ nodeId: 'nas', trusted })
        const ns1Replica = new JournalReplica({ nodeId: 'ns1', trusted })
        const gate = new EmergencyReleaseGate()
        // Two in-process "nodes" behind one fake mesh: each request is answered by the target's endpoint.
        const endpoints: Record<string, Parameters<typeof registerSuccessionEndpoint>[0]> = {
            nas: { replica: nasReplica, emergencyGate: gate },
            ns1: { replica: ns1Replica },
        }
        const send: SuccessionSend = async (target, payload) => {
            registerSuccessionEndpoint(endpoints[target])
            return handleSuccessionRequest(JSON.parse(JSON.stringify(payload)), 'spark')
        }
        let nasUp = true
        const nas = createMeshSuccessionPeer('nas', { reachable: () => nasUp, send })
        const ns1 = createMeshSuccessionPeer('ns1', { reachable: () => true, send })
        const writer = new StateJournalWriter({
            signer: signerFromMeshIdentity(spark), key: deriveJournalKey(randomBytes(32).toString('hex')), epoch: 1,
            local: new JournalReplica({ nodeId: 'spark', trusted }),
            targets: () => [nas, ns1].map(peer => ({ nodeId: peer.nodeId, deliver: message => peer.deliver(message) })),
        })
        await writer.promote()
        expect((await writer.record({ domain: 'missions', key: 'm', op: 'put', value: 1 })).committed).toBe(true)
        expect(nasReplica.lastSeq()).toBe(1)
        expect((await nas.exportJournal())?.entries).toHaveLength(1)

        // Emergency records must come from the node they are bound to.
        const foreign = issueEmergencyCode({ nodeId: 'lab', now: Date.now() })
        expect(await nas.registerEmergencyRecord(foreign.record)).toBe(false)
        const own = issueEmergencyCode({ nodeId: 'spark', now: Date.now() })
        expect(await nas.registerEmergencyRecord(own.record)).toBe(true)

        nasUp = false
        expect(await nas.exportJournal()).toBeNull()
        expect((await writer.record({ domain: 'missions', key: 'n', op: 'put', value: 2 })).committed).toBe(false)
    })
})
