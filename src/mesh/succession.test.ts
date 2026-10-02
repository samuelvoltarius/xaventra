/**
 * 2.86 package K acceptance: Main failure with full knowledge, in a simulated
 * five-node mesh (no network). Every node is witness, journal replica and
 * share holder; only the ranking decides who may become Main.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QuorumWitnessStore } from './quorum-witness.js'
import { decideQuorumLease } from './witness-quorum.js'
import { JournalReplica, MAIN_STATE_DOMAINS, createMemorySigner, deriveJournalKey, type MainState } from './state-journal.js'
import { ShareHolder, createShareKeyPair, sealSecretVault, type ShareKeyPair } from './secret-shares.js'
import { EmergencyReleaseGate } from './emergency-release.js'
import { rankNodes } from './succession-ranking.js'
import { SuccessionNode, createInProcessWitnessClient, type OwnerNotifier, type SuccessionPeer } from './succession.js'
import type { MeshNode } from './mesh-registry.js'

const ORDER = ['spark', 'ns1', 'lab', 'ns2', 'nas'] as const
type Name = typeof ORDER[number]

function meshNode(nodeId: string, ram: number, cores: number, extra: Partial<MeshNode> = {}): MeshNode {
    return {
        node_id: nodeId, hostname: `${nodeId}.example.com`, platform: 'linux', version: '2.86.0', tools_count: 1,
        status: 'online', capabilities: [], hardware: { ram_gb: ram, cores } as MeshNode['hardware'],
        last_heartbeat: new Date(0).toISOString(), ...extra,
    }
}

const MESH_NODES: MeshNode[] = [
    meshNode('spark', 128, 20, { capabilities: ['gpu', 'local-llm'] }),
    meshNode('ns1', 64, 16),
    meshNode('lab', 32, 8),
    meshNode('ns2', 16, 4),
    meshNode('nas', 8, 4, { capabilities: ['main-ineligible'] }),
]

class SimMesh {
    now = 1_700_000_000_000
    readonly alive = new Set<Name>(ORDER)
    readonly dir = mkdtempSync(join(tmpdir(), 'xaventra-succession-'))
    readonly journalKey = deriveJournalKey(randomBytes(32).toString('hex'))
    readonly signers = Object.fromEntries(ORDER.map(name => [name, createMemorySigner(name)])) as Record<Name, ReturnType<typeof createMemorySigner>>
    readonly trusted = Object.fromEntries(ORDER.map(name => [name, this.signers[name].publicKey]))
    readonly witnesses = Object.fromEntries(ORDER.map(name => [name, new QuorumWitnessStore(`w-${name}`, join(this.dir, `w-${name}.json`))])) as Record<Name, QuorumWitnessStore>
    readonly replicas = Object.fromEntries(ORDER.map(name => [name, new JournalReplica({ nodeId: name, trusted: this.trusted, file: join(this.dir, `j-${name}.json`) })])) as Record<Name, JournalReplica>
    readonly shareKeys = Object.fromEntries(ORDER.map(name => [name, createShareKeyPair()])) as Record<Name, ShareKeyPair>
    readonly gates = Object.fromEntries(ORDER.map(name => [name, new EmergencyReleaseGate({ now: () => this.now })])) as Record<Name, EmergencyReleaseGate>
    readonly telegramToken = `test-${randomBytes(10).toString('hex')}`
    readonly sealed = sealSecretVault({ TELEGRAM_BOT_TOKEN: this.telegramToken }, ORDER.map(nodeId => ({ nodeId, publicKey: this.shareKeys[nodeId].publicKey })), 3, { ownerShare: true })
    readonly holders: Record<Name, ShareHolder>
    readonly inbox: Array<{ from: string; channel: string; text: string }> = []
    /** Reachable for witnesses/ranking, but journal messages to it are lost. */
    readonly journalBlocked = new Set<Name>()
    nodes = {} as Record<Name, SuccessionNode>

    constructor() {
        this.holders = Object.fromEntries(ORDER.map(name => [name, new ShareHolder({
            nodeId: name, keyPair: this.shareKeys[name], sealedShare: this.sealed.sealedShares[name],
            verifyMainClaim: claim => this.majorityConfirms(name, claim.requester, claim.epoch),
            emergencyGate: this.gates[name],
        })])) as Record<Name, ShareHolder>
        for (const name of ORDER) this.nodes[name] = this.boot(name)
    }

    /** What the holder itself can see: a live lease for requester@epoch on a majority of reachable witnesses. */
    majorityConfirms(holder: Name, requester: string, epoch: number): boolean {
        if (!this.alive.has(holder)) return false
        let confirmations = 0
        for (const name of ORDER) {
            if (!this.alive.has(name)) continue
            const lease = this.witnesses[name].peek('nova-main')
            if (lease && lease.holderNodeId === requester && lease.epoch === epoch && Date.parse(lease.expiresAt) > this.now) confirmations++
        }
        return confirmations >= 3
    }

    boot(name: Name): SuccessionNode {
        const notifiers: OwnerNotifier[] = [
            { channel: 'telegram', send: async () => false }, // token locked outside a Main: undeliverable
            { channel: 'app', send: async text => { this.inbox.push({ from: name, channel: 'app', text }); return true } },
        ]
        return new SuccessionNode({
            nodeId: name, signer: this.signers[name], journalKey: this.journalKey, trusted: this.trusted,
            localReplica: this.replicas[name], clusterSize: ORDER.length,
            witnesses: ORDER.map(w => createInProcessWitnessClient(this.witnesses[w], {
                reachable: () => this.alive.has(name) && this.alive.has(w), now: () => this.now,
            })),
            peers: () => ORDER.filter(peer => peer !== name).map(peer => this.peer(name, peer)),
            rank: () => rankNodes('main', MESH_NODES),
            now: () => this.now, leaseTtlMs: 30_000, vacancyGraceMs: 15_000, handbackStableMs: 20_000,
            notifiers, emergencyGate: this.gates[name], shareHolder: this.holders[name], shareKeyPair: this.shareKeys[name],
            vault: this.sealed.vault,
        })
    }

    peer(from: Name, to: Name): SuccessionPeer {
        const up = () => this.alive.has(from) && this.alive.has(to)
        return {
            nodeId: to, reachable: up,
            deliver: async message => up() && !this.journalBlocked.has(to) ? this.replicas[to].receive(message) : null,
            exportJournal: async () => up() ? this.replicas[to].export() : null,
            requestShare: async request => up() ? this.holders[to].release(request) : null,
            registerEmergencyRecord: async record => { if (!up()) return false; this.gates[to].register(record); return true },
            yieldEmergency: async () => up() ? this.nodes[to].yieldEmergency('majority restored') : false,
        }
    }

    acting(): Name[] { return ORDER.filter(name => this.alive.has(name) && this.nodes[name].isActingMain()) }
    pollers(): Name[] { return ORDER.filter(name => this.alive.has(name) && this.nodes[name].canStartTelegramPoller()) }

    assertNeverTwoMains(): void {
        expect(this.acting().length).toBeLessThanOrEqual(1)
        expect(this.pollers().length).toBeLessThanOrEqual(1)
        // A failed acquire may leave a short minority lease on single witnesses;
        // what must never exist is a second holder backed by a witness majority.
        const votes = new Map<string, number>()
        for (const name of ORDER) {
            const lease = this.witnesses[name].peek('nova-main')
            if (lease && Date.parse(lease.expiresAt) > this.now) votes.set(lease.holderNodeId, (votes.get(lease.holderNodeId) || 0) + 1)
        }
        expect([...votes.values()].filter(count => count >= 3).length).toBeLessThanOrEqual(1)
    }

    async round(ms = 10_000): Promise<void> {
        this.now += ms
        for (const name of ORDER) {
            if (!this.alive.has(name)) continue
            await this.nodes[name].tick()
            this.assertNeverTwoMains()
        }
    }

    /** One round in which only `names` get to run (others are reachable but hang). */
    async roundOnly(names: Name[], ms = 10_000): Promise<void> {
        this.now += ms
        for (const name of names) {
            if (!this.alive.has(name)) continue
            await this.nodes[name].tick()
            this.assertNeverTwoMains()
        }
    }

    async until(predicate: () => boolean, maxRounds = 20): Promise<number> {
        for (let i = 1; i <= maxRounds; i++) {
            await this.round()
            if (predicate()) return i
        }
        throw new Error(`condition not reached after ${maxRounds} rounds; acting=${this.acting().join(',')}`)
    }
}

async function fillAllDomains(node: SuccessionNode, tag: string): Promise<void> {
    for (const domain of MAIN_STATE_DOMAINS) {
        const result = await node.record({ domain, key: `${tag}-${domain}`, op: 'put', value: { tag, domain, at: tag } })
        expect(result.committed).toBe(true)
    }
}

const visible = (state: MainState) => Object.fromEntries(MAIN_STATE_DOMAINS.map(domain => [domain, state[domain]]))

describe('majority lease over n witnesses', () => {
    it('needs floor(n/2)+1 approvals and lets the holder release cleanly', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-quorum5-'))
        const stores = [1, 2, 3, 4, 5].map(i => new QuorumWitnessStore(`w${i}`, join(dir, `w${i}.json`)))
        let now = 10_000
        const up = new Set([0, 1, 2, 3, 4])
        const ask = (nodeId: string) => (proposedEpoch: number) => Promise.resolve(stores.map((store, index) => up.has(index)
            ? store.acquire({ service: 'nova-main', nodeId, holderHostname: nodeId, ttlMs: 30_000, requestId: 'r', proposedEpoch }, now)
            : null))
        const first = await decideQuorumLease({ service: 'nova-main', nodeId: 'a', ttlMs: 30_000, witnessCount: 5, ask: ask('a'), now: () => now, highWater: new Map() })
        expect(first.leader).toBe(true)
        expect((await decideQuorumLease({ service: 'nova-main', nodeId: 'b', ttlMs: 30_000, witnessCount: 5, ask: ask('b'), now: () => now, highWater: new Map() })).leader).toBe(false)
        for (const store of stores) expect(store.release({ service: 'nova-main', nodeId: 'a', epoch: first.epoch! }, now)).toBe(true)
        expect(stores[0].release({ service: 'nova-main', nodeId: 'b', epoch: first.epoch! }, now)).toBe(false)
        up.delete(3); up.delete(4); up.delete(2)
        const minority = await decideQuorumLease({ service: 'nova-main', nodeId: 'b', ttlMs: 30_000, witnessCount: 5, ask: ask('b'), now: () => now, highWater: new Map() })
        expect(minority.leader).toBe(false)
        expect(minority.reason).toContain('2/3')
        up.add(2)
        now += 1
        const majority = await decideQuorumLease({ service: 'nova-main', nodeId: 'b', ttlMs: 30_000, witnessCount: 5, ask: ask('b'), now: () => now, highWater: new Map() })
        expect(majority.leader).toBe(true)
        expect(majority.epoch).toBeGreaterThan(first.epoch!)
    })
})

describe('ranking stub (until package J lands)', () => {
    it('orders by measured strength and marks main-ineligible nodes', () => {
        const ranked = rankNodes('main', MESH_NODES)
        expect(ranked.map(item => item.nodeId)).toEqual(['spark', 'ns1', 'lab', 'ns2', 'nas'])
        expect(ranked.find(item => item.nodeId === 'nas')?.eligible).toBe(false)
        expect(ranked[0].reasons.length).toBeGreaterThan(0)
    })
})

describe('acceptance: Main failure → successor with full state → second failure → return → clean handback', () => {
    it('never has two Mains and always carries the complete Main state', async () => {
        const mesh = new SimMesh()

        // Start: the strongest node becomes Main through the majority lease.
        await mesh.until(() => mesh.acting()[0] === 'spark')
        expect(mesh.nodes.spark.epoch()).toBe(1)
        await mesh.round()
        expect(mesh.pollers()).toEqual(['spark'])
        expect(mesh.nodes.spark.secretsUnlocked()).toBe(true)
        expect(mesh.nodes.ns1.secretsUnlocked()).toBe(false)

        await fillAllDomains(mesh.nodes.spark, 'spark-a')
        await mesh.nodes.spark.snapshot()
        await fillAllDomains(mesh.nodes.spark, 'spark-b')
        const sparkState = visible(mesh.nodes.spark.state())

        // 1st failure: Spark dies. Nobody may take over before its lease expires.
        mesh.alive.delete('spark')
        await mesh.round()
        expect(mesh.acting()).toEqual([])
        await mesh.until(() => mesh.acting().length === 1)
        expect(mesh.acting()).toEqual(['ns1'])
        expect(mesh.nodes.ns1.epoch()).toBe(2)
        expect(visible(mesh.nodes.ns1.state())).toEqual(sparkState)
        await mesh.round()
        expect(mesh.pollers()).toEqual(['ns1'])

        await fillAllDomains(mesh.nodes.ns1, 'ns1-a')
        const ns1State = visible(mesh.nodes.ns1.state())

        // 2nd failure: ns1 dies too → the next in line (lab) takes over with everything.
        mesh.alive.delete('ns1')
        await mesh.until(() => mesh.acting().length === 1)
        expect(mesh.acting()).toEqual(['lab'])
        expect(mesh.nodes.lab.epoch()).toBe(3)
        expect(visible(mesh.nodes.lab.state())).toEqual(ns1State)
        await fillAllDomains(mesh.nodes.lab, 'lab-a')
        await mesh.round()
        expect(mesh.pollers()).toEqual(['lab'])

        // The old Main comes back as a stale process that still believes it is Main.
        mesh.alive.add('spark')
        expect(mesh.nodes.spark.role()).toBe('main')
        expect(mesh.nodes.spark.isActingMain()).toBe(false)
        expect(mesh.nodes.spark.canStartTelegramPoller()).toBe(false)
        await expect(mesh.nodes.spark.record({ domain: 'missions', key: 'stale', op: 'put', value: 1 })).rejects.toThrow(/not the acting Main/)
        mesh.assertNeverTwoMains()

        // Clean handback to the better-ranked node after it is stable and caught up.
        const labState = visible(mesh.nodes.lab.state())
        await mesh.until(() => mesh.acting()[0] === 'spark')
        expect(mesh.nodes.lab.role()).toBe('follower')
        expect(mesh.nodes.spark.epoch()).toBe(4)
        expect(visible(mesh.nodes.spark.state())).toEqual(labState)
        expect(mesh.nodes.spark.state().missions.stale).toBeUndefined()
        await mesh.round()
        expect(mesh.pollers()).toEqual(['spark'])

        // ns1 restarts (fresh process, persisted replica) and simply follows.
        mesh.nodes.ns1 = mesh.boot('ns1')
        mesh.alive.add('ns1')
        await mesh.round(); await mesh.round(); await mesh.round()
        expect(mesh.acting()).toEqual(['spark'])
        expect(mesh.nodes.ns1.role()).toBe('follower')
        await fillAllDomains(mesh.nodes.spark, 'spark-c')
        expect(mesh.replicas.ns1.lastSeq()).toBe(mesh.replicas.spark.lastSeq())
    })

    it('a lower-ranked candidate waits for the better one and only takes over after the grace period', async () => {
        const mesh = new SimMesh()
        await mesh.until(() => mesh.acting()[0] === 'spark')
        await fillAllDomains(mesh.nodes.spark, 'x')
        mesh.alive.delete('spark')
        // ns1 is reachable but hangs (does not tick); lab must give it the grace period (index 1 × 15 s).
        await mesh.roundOnly(['lab', 'ns2', 'nas'], 31_000) // spark lease expired → vacancy observed now
        expect(mesh.acting()).toEqual([])
        await mesh.roundOnly(['lab', 'ns2', 'nas'], 10_000)
        expect(mesh.acting()).toEqual([])
        await mesh.roundOnly(['lab', 'ns2', 'nas'], 10_000)
        expect(mesh.acting()).toEqual(['lab'])
        expect(mesh.nodes.lab.state().missions['x-missions']).toEqual({ tag: 'x', domain: 'missions', at: 'x' })
    })

    it('does not hand back to a better node that cannot receive the journal', async () => {
        const mesh = new SimMesh()
        await mesh.until(() => mesh.acting()[0] === 'spark')
        mesh.alive.delete('spark')
        await mesh.until(() => mesh.acting()[0] === 'ns1')
        await fillAllDomains(mesh.nodes.ns1, 'y')
        mesh.nodes.spark = mesh.boot('spark')
        mesh.journalBlocked.add('spark')
        mesh.alive.add('spark')
        for (let i = 0; i < 8; i++) await mesh.round()
        expect(mesh.acting()).toEqual(['ns1'])
        mesh.journalBlocked.delete('spark')
        await mesh.until(() => mesh.acting()[0] === 'spark')
        expect(mesh.nodes.spark.state().missions['y-missions']).toBeDefined()
    })

    it('without a majority: safety mode, owner notified, then owner emergency release and clean reconciliation', async () => {
        const mesh = new SimMesh()
        await mesh.until(() => mesh.acting()[0] === 'spark')
        await fillAllDomains(mesh.nodes.spark, 'base')
        const baseState = visible(mesh.nodes.spark.state())

        // 3 of 5 fail: only ns2 and the NAS remain → no majority anywhere.
        for (const name of ['spark', 'ns1', 'lab'] as const) mesh.alive.delete(name)
        await mesh.round(); await mesh.round(); await mesh.round(); await mesh.round()
        expect(mesh.acting()).toEqual([])
        expect(mesh.nodes.ns2.role()).toBe('safety')
        expect(mesh.nodes.nas.role()).toBe('safety')
        expect(mesh.nodes.ns2.consequentialActionsAllowed()).toBe(false)
        expect(mesh.pollers()).toEqual([])
        await expect(mesh.nodes.ns2.record({ domain: 'missions', key: 'x', op: 'put', value: 1 })).rejects.toThrow()

        // Owner informed via every reachable way, once per episode; only the best-placed node offers a code.
        const notices = mesh.inbox.filter(item => item.from === 'ns2')
        expect(notices).toHaveLength(1)
        expect(mesh.inbox.filter(item => item.from === 'nas')).toHaveLength(1)
        const code = /([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(notices[0].text)?.[1]
        expect(code).toBeTruthy()
        expect(mesh.inbox.find(item => item.from === 'nas')?.text).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)
        await mesh.round()
        expect(mesh.inbox.filter(item => item.from === 'ns2')).toHaveLength(1)

        // Code is bound to ns2; wrong code and wrong node are refused.
        expect((await mesh.nodes.nas.confirmEmergencyRelease(code!)).ok).toBe(false)
        expect((await mesh.nodes.ns2.confirmEmergencyRelease('AAAA-BBBB-CCCC')).ok).toBe(false)
        const granted = await mesh.nodes.ns2.confirmEmergencyRelease(code!, { ownerRecoveryShare: mesh.sealed.ownerRecoveryShare })
        expect(granted.ok).toBe(true)
        expect(mesh.nodes.ns2.role()).toBe('emergency-main')
        expect(mesh.acting()).toEqual(['ns2'])
        expect(visible(mesh.nodes.ns2.state())).toEqual(baseState)
        expect(mesh.pollers()).toEqual(['ns2'])
        expect((await mesh.nodes.ns2.confirmEmergencyRelease(code!)).ok).toBe(false)
        await mesh.nodes.ns2.record({ domain: 'decisions', key: 'notfall-entscheidung', op: 'put', value: 'im Notbetrieb getroffen' })
        await mesh.round()
        mesh.assertNeverTwoMains()

        // The others return: the emergency Main steps down, the best node takes over and reconciles the branch.
        mesh.nodes.spark = mesh.boot('spark'); mesh.nodes.ns1 = mesh.boot('ns1')
        mesh.alive.add('spark'); mesh.alive.add('ns1')
        await mesh.until(() => mesh.acting()[0] === 'spark')
        expect(mesh.nodes.ns2.role()).toBe('follower')
        expect(mesh.nodes.ns2.canStartTelegramPoller()).toBe(false)
        expect(mesh.nodes.spark.state().decisions['notfall-entscheidung']).toBe('im Notbetrieb getroffen')
        await mesh.round(); await mesh.round()
        expect(mesh.pollers()).toEqual(['spark'])
        expect(mesh.nodes.spark.state().decisions['notfall-entscheidung']).toBe('im Notbetrieb getroffen')
    })
})
