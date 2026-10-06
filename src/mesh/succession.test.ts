/**
 * 2.88 Main succession — simulated five-node mesh on the real witness store
 * (QuorumWitnessStore) and the real majority core (decideWitnessQuorum):
 * three main-eligible nodes (A strongest, B, C), two workers (D, E), three
 * witnesses. Network cuts are modelled per node.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { QuorumWitnessStore } from './quorum-witness.js'
import { decideWitnessQuorum, summarizeWitnessPeeks } from './witness-quorum.js'
import { JournalReplica, deriveJournalKeys } from './state-journal.js'
import { ShareHolder, createShareKeyPair, sealSecretVault, type ShareKeyPair } from './secret-vault.js'
import { EmergencyCodeGate, createEmergencyCodeRecord } from './emergency-code.js'
import { SuccessionController, SAFE_MODE_TEXT, type SuccessionPeer } from './succession.js'

const SERVICE = 'nova-main'
const TTL = 30_000
const OWNER_CODE = 'Sonne-Mond-42'
const keys = deriveJournalKeys('s'.repeat(48))

function createMesh(options: { emergencyMaxMs?: number } = {}) {
    let now = 1_700_000_000_000
    const dir = mkdtempSync(join(tmpdir(), 'xv-succession-'))
    const witnesses = ['w1', 'w2', 'w3'].map(id => new QuorumWitnessStore(id, join(dir, `${id}.json`)))
    const down = new Set<string>()
    /** Node cannot reach any witness. */
    const noWitness = new Set<string>()
    /** Node cannot reach any other node. */
    const isolated = new Set<string>()
    const witnessDown = new Set<string>()
    const eligible = ['node-a', 'node-b', 'node-c']
    const all = [...eligible, 'node-d', 'node-e']
    const score: Record<string, number> = { 'node-a': 300, 'node-b': 200, 'node-c': 100, 'node-d': 50, 'node-e': 10 }
    const pairs = new Map<string, ShareKeyPair>(all.map(id => [id, createShareKeyPair()]))
    const sealed = sealSecretVault({ TELEGRAM_BOT_TOKEN: 'test-telegram-token', CONNECTOR_TOKEN: 'test-connector-token' },
        all.map(nodeId => ({ nodeId, publicKey: pairs.get(nodeId)!.publicKey })), { ownerCode: OWNER_CODE })
    const record = createEmergencyCodeRecord(OWNER_CODE)

    const canTalk = (from: string, to: string) => !down.has(from) && !down.has(to) && !isolated.has(from) && !isolated.has(to)
    const witnessReachable = (node: string, witness: QuorumWitnessStore) => !down.has(node) && !noWitness.has(node) && !witnessDown.has(witness.witnessId)

    const peekFrom = (node: string) => {
        const view = summarizeWitnessPeeks(witnesses.map(w => witnessReachable(node, w) ? w.peek(SERVICE) : undefined), now)
        return { majorityReachable: view.reachable >= view.majority, holder: view.holder ? { nodeId: view.holder.nodeId, epoch: view.holder.epoch } : undefined }
    }

    const replicas = new Map<string, JournalReplica>(eligible.map(id => [id, new JournalReplica(id, keys)]))
    const holders = new Map<string, ShareHolder>(all.map(id => [id, new ShareHolder({
        nodeId: id, keyPair: pairs.get(id)!, sealedShare: sealed.sealedShares[id],
        // The holder asks ITS OWN view of the witnesses, never the request.
        verifyMainClaim: claim => {
            const view = peekFrom(id)
            return view.majorityReachable && view.holder?.nodeId === claim.requester && view.holder.epoch === claim.epoch
        },
        highWater: () => replicas.get(id)?.highWater() || 0,
    })]))

    const peer = (from: string, to: string): SuccessionPeer => ({
        nodeId: to,
        exportJournal: async () => canTalk(from, to) ? replicas.get(to)?.export() || null : null,
        deliver: async message => canTalk(from, to) && replicas.get(to) ? replicas.get(to)!.append(message) : null,
        requestShare: async request => canTalk(from, to) ? holders.get(to)!.release(request) : null,
    })

    const highWaters = new Map<string, Map<string, number>>(all.map(id => [id, new Map()]))
    const controllers = new Map<string, SuccessionController>()
    const build = (nodeId: string) => {
        const isEligible = eligible.includes(nodeId)
        controllers.set(nodeId, new SuccessionController({
            nodeId, hostname: nodeId.replace('node-', 'Rechner-').toUpperCase(), eligible: isEligible, keys,
            local: replicas.get(nodeId) || new JournalReplica(nodeId, keys),
            replicaCount: eligible.length,
            replicas: () => eligible.filter(id => id !== nodeId).map(id => peer(nodeId, id)),
            shareHolders: () => all.filter(id => id !== nodeId).map(id => peer(nodeId, id)),
            acquireMain: () => decideWitnessQuorum({
                service: SERVICE, nodeId, ttlMs: TTL, witnessCount: 3, now: () => now, highWater: highWaters.get(nodeId),
                ask: async proposedEpoch => witnesses.map(w => witnessReachable(nodeId, w)
                    ? w.acquire({ service: SERVICE, nodeId, holderHostname: nodeId, ttlMs: TTL, requestId: randomUUID(), proposedEpoch }, now)
                    : null),
            }),
            peekMain: async () => peekFrom(nodeId),
            raiseEpochFloor: epoch => {
                const map = highWaters.get(nodeId)!
                map.set(SERVICE, Math.max(map.get(SERVICE) || 0, epoch))
            },
            rank: () => eligible.map(id => ({ nodeId: id, eligible: true, reachable: id === nodeId || canTalk(nodeId, id), score: score[id] }))
                .sort((x, y) => y.score - x.score),
            vault: sealed.vault, ownSealedShare: sealed.sealedShares[nodeId], shareKeyPair: pairs.get(nodeId),
            emergencyGate: new EmergencyCodeGate({ record, now: () => now, maxAttempts: 3, lockMs: 60_000 }),
            emergencyMaxMs: options.emergencyMaxMs ?? 60 * 60_000,
            vacancyGraceMs: 20_000,
            now: () => now,
        }))
    }
    for (const nodeId of all) build(nodeId)
    const node = (id: string) => controllers.get(id)!
    const actingMains = () => all.filter(id => !down.has(id) && node(id).isActingMain())
    const tickAll = async () => { for (const id of all) if (!down.has(id)) await node(id).tick() }
    return {
        node, all, down, noWitness, isolated, witnessDown, replicas, actingMains, tickAll,
        advance: (ms: number) => { now += ms },
        /** Process restart: fresh controller, same persisted replica and witnesses. */
        restart: (id: string) => { highWaters.set(id, new Map()); build(id) },
        now: () => now,
    }
}

async function bootMain(mesh: ReturnType<typeof createMesh>) {
    await mesh.node('node-a').tick()
    expect(mesh.node('node-a').mode()).toBe('main')
    // First Main of the mesh: nothing moved, nothing to announce.
    expect(mesh.node('node-a').takeMoveNotice()).toBeNull()
    await mesh.tickAll()
    await mesh.node('node-a').record([
        { domain: 'memory', key: 'fact:farbe', value: 'blau' },
        { domain: 'connections', key: 'kalender', value: { provider: 'example.com', status: 'verbunden' } },
        { domain: 'responsibilities', key: 'heizung', value: { owner: 'Main', since: '2026-10-07' } },
        { domain: 'cards', key: 'karte-1', value: { frage: 'Licht aus?', offen: true } },
        { domain: 'config', key: 'sprache', value: 'de' },
    ])
}

describe('2.88 Main succession with full knowledge', () => {
    it('failover: the best reachable eligible node takes over with full state, secrets and one move notice', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        expect(mesh.node('node-b').mode()).toBe('follower')
        expect(mesh.node('node-d').mode()).toBe('worker')

        mesh.down.add('node-a')
        // Lease still live: nobody may take over yet (never two Mains).
        await mesh.tickAll()
        expect(mesh.actingMains()).toEqual([])
        expect(mesh.node('node-b').mode()).toBe('follower')

        mesh.advance(TTL + 1)
        // C ticks first but B is stronger and reachable: C waits within the grace.
        await mesh.node('node-c').tick()
        expect(mesh.node('node-c').mode()).toBe('follower')
        await mesh.node('node-b').tick()
        expect(mesh.node('node-b').mode()).toBe('main')
        expect(mesh.node('node-b').epoch()).toBeGreaterThan(1)
        const state = mesh.node('node-b').state()
        expect(state.memory['fact:farbe']).toBe('blau')
        expect(state.connections.kalender).toEqual({ provider: 'example.com', status: 'verbunden' })
        expect(state.responsibilities.heizung).toEqual({ owner: 'Main', since: '2026-10-07' })
        expect(state.cards['karte-1']).toEqual({ frage: 'Licht aus?', offen: true })
        expect(state.config.sprache).toBe('de')
        // Secrets were opened with shares of the other nodes (A is gone).
        expect(mesh.node('node-b').secret('TELEGRAM_BOT_TOKEN')).toBe('test-telegram-token')
        expect(mesh.node('node-b').takeMoveNotice()).toBe('Ich bin jetzt auf RECHNER-B umgezogen, alles da.')
        expect(mesh.node('node-b').takeMoveNotice()).toBeNull()
        await mesh.tickAll()
        expect(mesh.actingMains()).toEqual(['node-b'])
        expect(mesh.node('node-c').mode()).toBe('follower')
        // A worker never becomes Main, even when it is the only one left.
        mesh.down.add('node-b'); mesh.down.add('node-c')
        mesh.advance(TTL + 1)
        await mesh.node('node-d').tick()
        expect(mesh.node('node-d').mode()).toBe('worker')
        expect(mesh.node('node-d').canSend()).toBe(false)
    })

    it('a restarted Main continues with its knowledge and announces no move', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        mesh.restart('node-a')
        expect(mesh.node('node-a').isActingMain()).toBe(false)
        await mesh.node('node-a').tick()
        expect(mesh.node('node-a').mode()).toBe('main')
        expect(mesh.node('node-a').state().memory['fact:farbe']).toBe('blau')
        expect(mesh.node('node-a').takeMoveNotice()).toBeNull()
        await mesh.tickAll()
        expect(mesh.actingMains()).toEqual(['node-a'])
    })

    it('split-brain counter-check: a partitioned old Main and the new Main never act at the same time', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        mesh.isolated.add('node-a'); mesh.noWitness.add('node-a')
        for (let step = 0; step < 6; step++) {
            mesh.advance(10_000)
            await mesh.tickAll()
            expect(mesh.actingMains().length).toBeLessThanOrEqual(1)
        }
        expect(mesh.node('node-b').mode()).toBe('main')
        expect(mesh.node('node-a').mode()).toBe('safe')
        expect(mesh.node('node-a').canSend()).toBe(false)
        expect(mesh.node('node-a').secret('TELEGRAM_BOT_TOKEN')).toBeUndefined()
        await expect(mesh.node('node-a').record({ domain: 'memory', key: 'x', value: 1 })).rejects.toThrow(/not the acting Main/)
        // Partition heals: A follows B, still exactly one Main.
        mesh.isolated.delete('node-a'); mesh.noWitness.delete('node-a')
        await mesh.tickAll()
        expect(mesh.node('node-a').mode()).toBe('follower')
        expect(mesh.actingMains()).toEqual(['node-b'])
    })

    it('fencing: the old Main can no longer write or send after the epoch change', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        // A loses the witnesses but still reaches the replicas and has not ticked.
        mesh.noWitness.add('node-a')
        mesh.advance(TTL + 1)
        // A still looks reachable and is stronger: B first waits one grace period.
        await mesh.node('node-b').tick()
        expect(mesh.node('node-b').mode()).toBe('follower')
        mesh.advance(20_000)
        await mesh.node('node-b').tick()
        expect(mesh.node('node-b').mode()).toBe('main')
        const newEpoch = mesh.node('node-b').epoch()
        // Still believes it is Main locally — the first write is fenced by the replicas.
        await expect(mesh.node('node-a').record({ domain: 'memory', key: 'nach-wechsel', value: 1 })).rejects.toThrow(/fenced/)
        expect(mesh.node('node-a').canSend()).toBe(false)
        expect(mesh.node('node-a').mode()).not.toBe('main')
        expect(mesh.replicas.get('node-c')!.highWater()).toBe(newEpoch)
        expect(mesh.node('node-b').state().memory['nach-wechsel']).toBeUndefined()
        await mesh.node('node-b').record({ domain: 'memory', key: 'neu', value: 1 })
        expect(mesh.node('node-b').state().memory.neu).toBe(1)
    })

    it('safe mode without a majority: read only, nothing sent', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        mesh.down.add('node-a')
        mesh.witnessDown.add('w1'); mesh.witnessDown.add('w2')
        mesh.advance(TTL + 1)
        await mesh.tickAll()
        for (const id of ['node-b', 'node-c']) {
            expect(mesh.node(id).mode()).toBe('safe')
            expect(mesh.node(id).canSend()).toBe(false)
            expect(mesh.node(id).secret('TELEGRAM_BOT_TOKEN')).toBeUndefined()
        }
        expect(mesh.actingMains()).toEqual([])
        expect(SAFE_MODE_TEXT).toMatch(/nur und sende nichts/)
        // The old Main also drops to safe mode when it loses the majority.
        const mesh2 = createMesh()
        await bootMain(mesh2)
        mesh2.witnessDown.add('w1'); mesh2.witnessDown.add('w3')
        await mesh2.node('node-a').tick()
        expect(mesh2.node('node-a').mode()).toBe('safe')
        expect(mesh2.node('node-a').canSend()).toBe(false)
    })

    it('owner emergency code: wrong code refused (and locked), right code makes this node Main until the majority is back', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        mesh.down.add('node-a')
        mesh.witnessDown.add('w1'); mesh.witnessDown.add('w2')
        mesh.advance(TTL + 1)
        await mesh.tickAll()
        const b = mesh.node('node-b')
        expect(b.mode()).toBe('safe')

        const wrong = await b.claimEmergency('falsch-falsch-1')
        expect(wrong.ok).toBe(false)
        expect(wrong.reason).toBe('Der Notfallcode stimmt nicht.')
        expect(JSON.stringify(wrong)).not.toMatch(/falsch|sonne/i)
        expect(b.mode()).toBe('safe')
        expect(b.canSend()).toBe(false)

        // A worker can never be made Main, not even with the right code.
        expect((await mesh.node('node-d').claimEmergency(OWNER_CODE)).ok).toBe(false)

        const right = await b.claimEmergency(OWNER_CODE)
        expect(right.ok).toBe(true)
        expect(b.mode()).toBe('emergency-main')
        expect(b.canSend()).toBe(true)
        expect(b.secret('TELEGRAM_BOT_TOKEN')).toBe('test-telegram-token')
        expect(b.state().memory['fact:farbe']).toBe('blau')
        expect(b.takeMoveNotice()).toBe('Ich bin jetzt auf RECHNER-B umgezogen (Notfall-Main, von dir bestätigt), alles da.')
        const emergencyEpoch = b.epoch()
        await b.record({ domain: 'memory', key: 'im-notfall', value: 1 })
        expect(mesh.actingMains()).toEqual(['node-b'])

        // Majority returns: B becomes a regular Main with an epoch above the emergency term.
        mesh.witnessDown.clear()
        await b.tick()
        expect(b.mode()).toBe('main')
        expect(b.epoch()).toBeGreaterThan(emergencyEpoch)
        expect(b.state().memory['im-notfall']).toBe(1)
        expect(b.takeMoveNotice()).toBeNull()
        await mesh.tickAll()
        expect(mesh.actingMains()).toEqual(['node-b'])
    })

    it('emergency code is refused while a majority is reachable, and locks after repeated wrong codes', async () => {
        const mesh = createMesh()
        await bootMain(mesh)
        const c = mesh.node('node-c')
        const refused = await c.claimEmergency(OWNER_CODE)
        expect(refused.ok).toBe(false)
        expect(refused.reason).toMatch(/Mehrheit ist erreichbar/)
        expect(mesh.actingMains()).toEqual(['node-a'])

        mesh.down.add('node-a')
        mesh.witnessDown.add('w1'); mesh.witnessDown.add('w2')
        mesh.advance(TTL + 1)
        await c.tick()
        for (let i = 0; i < 3; i++) await c.claimEmergency(`falsch-falsch-${i}`)
        const locked = await c.claimEmergency(OWNER_CODE)
        expect(locked.ok).toBe(false)
        expect(locked.reason).toMatch(/Zu viele falsche Versuche/)
        expect(c.mode()).toBe('safe')
    })

    it('an emergency Main ends when its time is over (back to safe mode)', async () => {
        const mesh = createMesh({ emergencyMaxMs: 60_000 })
        await bootMain(mesh)
        mesh.down.add('node-a')
        mesh.witnessDown.add('w1'); mesh.witnessDown.add('w2')
        mesh.advance(TTL + 1)
        await mesh.tickAll()
        expect((await mesh.node('node-b').claimEmergency(OWNER_CODE)).ok).toBe(true)
        mesh.advance(60_001)
        expect(mesh.node('node-b').canSend()).toBe(false)
        await mesh.node('node-b').tick()
        expect(mesh.node('node-b').mode()).toBe('safe')
        expect(mesh.node('node-b').secret('TELEGRAM_BOT_TOKEN')).toBeUndefined()
    })
})
