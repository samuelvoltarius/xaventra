import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { MeshPolicy, parseWorkloadPeers, pruneEphemeralPeerStates, workloadPeerFor } from './mesh-policy.js'
import type { MeshPeer, MeshPrincipal } from './transport-contracts.js'

// P19 (2.88): scalable Kubernetes worker Deployments. Every replica has its own
// node id (pod name) but signs with the one workload key the owner provided
// as a Secret. The Main trusts them through ONE explicit prefix entry with a
// pinned key — never TOFU, never a wildcard, same role rules as named peers.

const dir = (tag: string) => mkdtempSync(join(tmpdir(), `nova-wl-${tag}-`))
const system = (nodeId: string): MeshPrincipal => ({ id: `node:${nodeId}`, role: 'system', channel: 'mesh' })
let counter = 0
const heartbeat = (source: MeshIdentity, target = 'xv-main-0') =>
    source.create({ kind: 'node.heartbeat', targetNode: target, principal: system(source.nodeId), payload: { status: 'online', n: ++counter } })

/** The owner's workload key file, as `npm run mesh:identity` writes it for node id `xv-worker-general`. */
function workloadKeyFile(nodeId = 'xv-worker-general'): { path: string; publicKey: string } {
    const source = dir('seed')
    const generated = new MeshIdentity(nodeId, source)
    const file = join(dir('secret'), 'identity.json')
    writeFileSync(file, readFileSync(join(source, `${nodeId}.json`), 'utf8'))
    return { path: file, publicKey: generated.publicKey }
}

describe('Workload-Peers (Kubernetes-Worker mit mehreren Replikas)', () => {
    it('parses only explicit, keyed prefix entries that end in "-"', () => {
        const key = workloadKeyFile().publicKey
        const parsed = parseWorkloadPeers([
            { nodeIdPrefix: 'xv-worker-general-', publicKey: key, roles: ['system', 'worker'] },
            { nodeIdPrefix: 'xv-worker-voice', publicKey: key },          // no trailing "-"
            { nodeIdPrefix: 'xv-*-', publicKey: key },                    // wildcard
            { nodeIdPrefix: '-', publicKey: key },                        // too short
            { nodeIdPrefix: 'xv-worker-tools-' },                         // no key: never TOFU
            { nodeId: 'named', publicKey: key },                          // regular peer, not a workload entry
        ])
        expect(parsed).toEqual([{ nodeIdPrefix: 'xv-worker-general-', publicKey: key, roles: ['system', 'worker'] }])
        expect(parseWorkloadPeers([{ nodeIdPrefix: 'xv-worker-a-', publicKey: key }])[0].roles).toEqual(['worker'])
        expect(parseWorkloadPeers(undefined)).toEqual([])
    })

    it('matches replica node ids by prefix only with a non-empty pod suffix', () => {
        const entry = { nodeIdPrefix: 'xv-worker-general-', publicKey: 'k', roles: ['worker' as const] }
        expect(workloadPeerFor('xv-worker-general-7d9f8-abcde', [entry])?.nodeId).toBe('xv-worker-general-7d9f8-abcde')
        expect(workloadPeerFor('xv-worker-general-', [entry])).toBeNull()
        expect(workloadPeerFor('xv-worker-generalx-1', [entry])).toBeNull()
        expect(workloadPeerFor('xv-worker-general-A_B', [entry])).toBeNull()
        expect(workloadPeerFor('other-xv-worker-general-1', [entry])).toBeNull()
    })

    it('accepts every replica signed with the pinned workload key and nothing else', () => {
        const keyFile = workloadKeyFile()
        const replicaA = new MeshIdentity('xv-worker-general-7d9f8-aaaaa', dir('a'), keyFile.path)
        const replicaB = new MeshIdentity('xv-worker-general-7d9f8-bbbbb', dir('b'), keyFile.path)
        expect(replicaA.publicKey).toBe(keyFile.publicKey)
        expect(replicaB.publicKey).toBe(keyFile.publicKey)
        const policy = new MeshPolicy({ mode: 'direct', peers: [], workloadPeers: parseWorkloadPeers([{ nodeIdPrefix: 'xv-worker-general-', publicKey: keyFile.publicKey, roles: ['system', 'worker'] }]) }, 'xv-main-0')
        expect(policy.verify(heartbeat(replicaA))).toMatchObject({ accepted: true })
        expect(policy.verify(heartbeat(replicaB))).toMatchObject({ accepted: true })
        // Gegenprobe: a self-made key under a matching name is refused.
        const intruder = new MeshIdentity('xv-worker-general-7d9f8-ccccc', dir('c'))
        expect(policy.verify(heartbeat(intruder))).toMatchObject({ accepted: false, reason: 'public_key_mismatch' })
        // Gegenprobe: the workload key outside the prefix is no trusted node.
        const elsewhere = new MeshIdentity('xv-worker-voice-1', dir('d'))
        expect(policy.verify(heartbeat(elsewhere))).toMatchObject({ accepted: false, reason: 'untrusted_node' })
    })

    it('keeps role limits: a workload entry without system role cannot send system envelopes', () => {
        const keyFile = workloadKeyFile()
        const replica = new MeshIdentity('xv-worker-general-1-aaaaa', dir('r'), keyFile.path)
        const policy = new MeshPolicy({ mode: 'direct', peers: [], workloadPeers: parseWorkloadPeers([{ nodeIdPrefix: 'xv-worker-general-', publicKey: keyFile.publicKey }]) }, 'xv-main-0')
        expect(policy.verify(heartbeat(replica))).toMatchObject({ accepted: false, reason: 'role_not_allowed' })
    })

    it('lets an exact named peer win over a prefix entry', () => {
        const keyFile = workloadKeyFile()
        const named = new MeshIdentity('xv-worker-general-pinned', dir('n'))
        const peer: MeshPeer = { nodeId: 'xv-worker-general-pinned', transport: 'direct', status: 'unknown', publicKey: named.publicKey, roles: ['system'] }
        const policy = new MeshPolicy({ mode: 'direct', peers: [peer], workloadPeers: parseWorkloadPeers([{ nodeIdPrefix: 'xv-worker-general-', publicKey: keyFile.publicKey, roles: ['system'] }]) }, 'xv-main-0')
        expect(policy.verify(heartbeat(named))).toMatchObject({ accepted: true })
        const withWorkloadKey = new MeshIdentity('xv-worker-general-pinned', dir('m'), keyFile.path)
        expect(policy.verify(heartbeat(withWorkloadKey))).toMatchObject({ accepted: false, reason: 'public_key_mismatch' })
    })

    it('shared key file: used read-only, refused for a node id outside its workload', () => {
        const keyFile = workloadKeyFile()
        const local = dir('ro')
        new MeshIdentity('xv-worker-general-1-aaaaa', local, keyFile.path)
        expect(readdirSync(local)).toEqual([])  // nothing written next to the Secret
        expect(() => new MeshIdentity('xv-worker-voice-1', dir('x'), keyFile.path)).toThrow(/Workload-Schlüssel/)
        expect(() => new MeshIdentity('xv-worker-general', dir('y'), keyFile.path)).toThrow(/Workload-Schlüssel/)
        expect(() => new MeshIdentity('xv-worker-general-1', dir('z'), join(dir('missing'), 'nope.json'))).toThrow(/Workload-Schlüssel/)
    })

    it('prunes long-gone replica states, never named peers', () => {
        const now = Date.parse('2026-10-07T12:00:00Z')
        const entry = parseWorkloadPeers([{ nodeIdPrefix: 'xv-worker-general-', publicKey: 'k' }])
        const states = {
            'xv-worker-general-old-aaaaa': { nodeId: 'xv-worker-general-old-aaaaa', lastSeen: now - 25 * 3600_000 },
            'xv-worker-general-new-bbbbb': { nodeId: 'xv-worker-general-new-bbbbb', lastSeen: now - 60_000 },
            'spark': { nodeId: 'spark', lastSeen: now - 30 * 24 * 3600_000 },
        }
        expect(Object.keys(pruneEphemeralPeerStates(states, entry, now))).toEqual(['xv-worker-general-new-bbbbb', 'spark'])
    })
})
