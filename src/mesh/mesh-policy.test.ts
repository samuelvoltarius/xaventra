import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { DEFAULT_PEER_ROLES, MeshPolicy, peersWithoutKeys } from './mesh-policy.js'
import type { MeshPeer, MeshPrincipal } from './transport-contracts.js'

function identity(nodeId: string): MeshIdentity {
    return new MeshIdentity(nodeId, mkdtempSync(join(tmpdir(), `nova-policy-${nodeId}-`)))
}
const worker = (nodeId: string): MeshPrincipal => ({ id: `node:${nodeId}`, role: 'worker', channel: 'mesh' })
const system = (nodeId: string): MeshPrincipal => ({ id: `node:${nodeId}`, role: 'system', channel: 'mesh' })
let counter = 0
const heartbeat = (source: MeshIdentity, target: string, principal: MeshPrincipal) =>
    source.create({ kind: 'node.heartbeat', targetNode: target, principal, payload: { status: 'online', n: ++counter } })

describe('K3 mesh peer trust is fail-closed', () => {
    it('rejects a configured peer without publicKey when TOFU is not explicitly enabled', () => {
        const attacker = identity('spark')
        const peer: MeshPeer = { nodeId: 'spark', transport: 'direct', status: 'unknown', roles: ['worker'] }
        const policy = new MeshPolicy({ mode: 'direct', peers: [peer] }, 'main')
        expect(policy.verify(heartbeat(attacker, 'main', worker('spark')))).toMatchObject({ accepted: false, reason: 'missing_peer_key' })
    })

    it('rejects a self-generated key for a keyed peer even if the envelope is self-consistent', () => {
        const real = identity('spark')
        const attacker = identity('spark')
        const peer: MeshPeer = { nodeId: 'spark', transport: 'direct', status: 'unknown', publicKey: real.publicKey, roles: ['worker'] }
        const policy = new MeshPolicy({ mode: 'direct', peers: [peer] }, 'main')
        expect(policy.verify(heartbeat(attacker, 'main', worker('spark')))).toMatchObject({ accepted: false, reason: 'public_key_mismatch' })
        expect(policy.verify(heartbeat(real, 'main', worker('spark')))).toMatchObject({ accepted: true })
    })

    it('verifies the signature against the configured key, not the key embedded in the envelope', () => {
        const real = identity('spark')
        const attacker = identity('spark-x')
        const peer: MeshPeer = { nodeId: 'spark', transport: 'direct', status: 'unknown', publicKey: real.publicKey, roles: ['worker'] }
        const policy = new MeshPolicy({ mode: 'direct', peers: [peer] }, 'main')
        // Attacker copies the configured public key into the envelope but signs with its own private key.
        const forged = attacker.create({ kind: 'node.heartbeat', targetNode: 'main', principal: worker('spark'), payload: { status: 'online' } })
        const withRealKey = { ...forged, sourceNode: 'spark', publicKey: real.publicKey }
        expect(policy.verify(withRealKey).accepted).toBe(false)
    })

    it('grants only non-privileged default roles to peers without configured roles', () => {
        expect(DEFAULT_PEER_ROLES).not.toContain('owner')
        expect(DEFAULT_PEER_ROLES).not.toContain('admin')
        expect(DEFAULT_PEER_ROLES).not.toContain('system')
        const spark = identity('spark')
        const peer: MeshPeer = { nodeId: 'spark', transport: 'direct', status: 'unknown', publicKey: spark.publicKey }
        const policy = new MeshPolicy({ mode: 'direct', peers: [peer] }, 'main')
        const owner = spark.create({ kind: 'node.heartbeat', targetNode: 'main', principal: { id: 'x', role: 'owner' }, payload: { status: 'online' } })
        expect(policy.verify(owner)).toMatchObject({ accepted: false, reason: 'role_not_allowed' })
        expect(policy.verify(heartbeat(spark, 'main', worker('spark')))).toMatchObject({ accepted: true })
    })

    it('does not let a remote envelope claim the local node id', () => {
        const local = identity('main')
        const attacker = identity('main')
        const policy = new MeshPolicy({ mode: 'direct', peers: [] }, 'main', local.publicKey)
        expect(policy.verify(heartbeat(attacker, '*', system('main')))).toMatchObject({ accepted: false, reason: 'local_node_spoof' })
        expect(policy.verify(heartbeat(local, '*', system('main')))).toMatchObject({ accepted: true })
        // Without a known local key every self-sourced envelope is refused.
        const blind = new MeshPolicy({ mode: 'direct', peers: [] }, 'main')
        expect(blind.verify(heartbeat(local, '*', system('main')))).toMatchObject({ accepted: false, reason: 'local_node_spoof' })
    })

    it('with explicit allowTofu pins the first key seen and still refuses privileged default roles', () => {
        const first = identity('pi')
        const second = identity('pi')
        const policy = new MeshPolicy({ mode: 'direct', peers: [], allowTofu: true }, 'main')
        expect(policy.verify(heartbeat(first, 'main', worker('pi')))).toMatchObject({ accepted: true })
        expect(policy.verify(heartbeat(second, 'main', worker('pi')))).toMatchObject({ accepted: false, reason: 'public_key_mismatch' })
        const owner = first.create({ kind: 'node.heartbeat', targetNode: 'main', principal: { id: 'x', role: 'owner' }, payload: { status: 'online' } })
        expect(policy.verify(owner)).toMatchObject({ accepted: false, reason: 'role_not_allowed' })
    })

    it('lists peers without keys for the startup migration warning', () => {
        const peers: MeshPeer[] = [
            { nodeId: 'spark', transport: 'direct', status: 'unknown' },
            { nodeId: 'ns1', transport: 'direct', status: 'unknown', publicKey: identity('ns1').publicKey },
            { nodeId: 'pi', transport: 'direct', status: 'unknown', publicKey: '  ' },
        ]
        expect(peersWithoutKeys(peers)).toEqual(['spark', 'pi'])
    })
})
