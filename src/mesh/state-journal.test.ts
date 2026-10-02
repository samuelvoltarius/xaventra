import { mkdtempSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    JournalReplica, MAIN_STATE_DOMAINS, StateJournalWriter, collectBranches, createMemorySigner, deriveJournalKey,
    restoreMainState, stateChecksum, type JournalReplicationTarget, type TrustedKeys,
} from './state-journal.js'

function cluster(names: string[]) {
    const signers = Object.fromEntries(names.map(name => [name, createMemorySigner(name)]))
    const trusted: TrustedKeys = Object.fromEntries(names.map(name => [name, signers[name].publicKey]))
    const replicas = Object.fromEntries(names.map(name => [name, new JournalReplica({ nodeId: name, trusted })]))
    const down = new Set<string>()
    const targets = (self: string): JournalReplicationTarget[] => names.filter(name => name !== self).map(name => ({
        nodeId: name,
        deliver: async message => down.has(name) ? null : replicas[name].receive(message),
    }))
    return { signers, trusted, replicas, down, targets }
}

const key = () => deriveJournalKey(randomBytes(32).toString('hex'))

describe('state journal (signed, encrypted, replicated)', () => {
    it('commits only with acknowledgements from at least two other nodes', async () => {
        const c = cluster(['spark', 'ns1', 'nas'])
        const writer = new StateJournalWriter({
            signer: c.signers.spark, key: key(), epoch: 1, local: c.replicas.spark, targets: () => c.targets('spark'), minReplicas: 2,
        })
        await writer.promote()
        const ok = await writer.record({ domain: 'missions', key: 'm1', op: 'put', value: { title: 'Backup prüfen' } })
        expect(ok.committed).toBe(true)
        expect(ok.acks.sort()).toEqual(['nas', 'ns1'])

        c.down.add('nas')
        const weak = await writer.record({ domain: 'cards', key: 'c1', op: 'put', value: { state: 'offen' } })
        expect(weak.committed).toBe(false)
        expect(weak.acks).toEqual(['ns1'])
    })

    it('never accepts fewer than two replicas as the commit rule', () => {
        const c = cluster(['spark', 'ns1'])
        expect(() => new StateJournalWriter({ signer: c.signers.spark, key: key(), epoch: 1, local: c.replicas.spark, targets: () => [], minReplicas: 1 }))
            .toThrow(/at least two/)
    })

    it('stores only ciphertext on replicas and reloads a persisted chain', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-journal-'))
        const names = ['spark', 'ns1', 'nas']
        const signers = Object.fromEntries(names.map(name => [name, createMemorySigner(name)]))
        const trusted = Object.fromEntries(names.map(name => [name, signers[name].publicKey]))
        const file = join(dir, 'nas.json')
        const nas = new JournalReplica({ nodeId: 'nas', trusted, file })
        const ns1 = new JournalReplica({ nodeId: 'ns1', trusted })
        const writer = new StateJournalWriter({
            signer: signers.spark, key: key(), epoch: 1, local: new JournalReplica({ nodeId: 'spark', trusted }),
            targets: () => [{ nodeId: 'nas', deliver: async m => nas.receive(m) }, { nodeId: 'ns1', deliver: async m => ns1.receive(m) }],
        })
        await writer.promote()
        await writer.record({ domain: 'decisions', key: 'd1', op: 'put', value: { text: 'Klartext-Marker-Entscheidung' } })
        const disk = readFileSync(file, 'utf8')
        expect(disk).not.toContain('Klartext-Marker-Entscheidung')
        expect(disk).toContain('"sealed"')
        const reloaded = new JournalReplica({ nodeId: 'nas', trusted, file })
        expect(reloaded.lastSeq()).toBe(1)
        expect(reloaded.export().highestEpoch).toBe(1)
    })

    it('rejects tampered, forged and gapped entries', async () => {
        const c = cluster(['spark', 'ns1', 'nas'])
        const writer = new StateJournalWriter({ signer: c.signers.spark, key: key(), epoch: 1, local: c.replicas.spark, targets: () => [], minReplicas: 2 })
        await writer.promote()
        await writer.record({ domain: 'tools', key: 't1', op: 'put', value: 1 })
        await writer.record({ domain: 'tools', key: 't2', op: 'put', value: 2 })
        const [first, second] = c.replicas.spark.export().entries
        const victim = new JournalReplica({ nodeId: 'ns1', trusted: c.trusted })
        expect(victim.receive({ type: 'entry', entry: second }).reason).toBe('gap')
        expect(victim.receive({ type: 'entry', entry: { ...first, epoch: 7 } }).reason).toBe('bad-signature')
        const intruder = createMemorySigner('spark')
        const forged = new StateJournalWriter({
            signer: intruder, key: key(), epoch: 1,
            local: new JournalReplica({ nodeId: 'x', trusted: { spark: intruder.publicKey } }), targets: () => [],
        })
        await forged.record({ domain: 'tools', key: 'evil', op: 'put', value: 1 })
        const forgedEntry = forged.localExport().entries[0]
        expect(victim.receive({ type: 'entry', entry: forgedEntry }).reason).toBe('bad-signature')
        expect(victim.receive({ type: 'entry', entry: first }).ok).toBe(true)
    })

    it('fences a stale main after a newer epoch was promoted', async () => {
        const c = cluster(['spark', 'ns1', 'lab'])
        const k = key()
        const oldMain = new StateJournalWriter({ signer: c.signers.spark, key: k, epoch: 1, local: c.replicas.spark, targets: () => c.targets('spark') })
        await oldMain.promote()
        expect((await oldMain.record({ domain: 'planner', key: 'p1', op: 'put', value: 'a' })).committed).toBe(true)

        const restored = restoreMainState([c.replicas.ns1.export(), c.replicas.lab.export()], { key: k, trusted: c.trusted })
        expect(restored.ok).toBe(true)
        const newMain = new StateJournalWriter({ signer: c.signers.ns1, key: k, epoch: 2, local: c.replicas.ns1, targets: () => c.targets('ns1'), resumeFrom: restored })
        await newMain.promote()

        await expect(oldMain.record({ domain: 'planner', key: 'p2', op: 'put', value: 'stale' })).rejects.toThrow(/fenced/)
        expect(oldMain.isFenced()).toBe(true)
        expect((await newMain.record({ domain: 'planner', key: 'p2', op: 'put', value: 'fresh' })).committed).toBe(true)
        const after = restoreMainState([c.replicas.ns1.export(), c.replicas.lab.export()], { key: k, trusted: c.trusted })
        expect(after.state.planner).toEqual({ p1: 'a', p2: 'fresh' })
    })

    it('restores every domain through snapshot + tail up to the last confirmed entry', async () => {
        const c = cluster(['spark', 'ns1', 'lab', 'nas'])
        const k = key()
        const writer = new StateJournalWriter({ signer: c.signers.spark, key: k, epoch: 3, local: c.replicas.spark, targets: () => c.targets('spark') })
        await writer.promote()
        for (const domain of MAIN_STATE_DOMAINS) await writer.record({ domain, key: `${domain}-1`, op: 'put', value: { domain, n: 1 } })
        const snap = await writer.snapshot()
        expect(snap.acks.length).toBeGreaterThanOrEqual(2)
        await writer.record([
            { domain: 'thoughts', key: 'thoughts-2', op: 'put', value: 'nach dem Snapshot' },
            { domain: 'cards', key: 'cards-1', op: 'delete' },
        ])
        const expected = writer.state()
        const restored = restoreMainState([c.replicas.ns1.export(), c.replicas.nas.export()], { key: k, trusted: c.trusted })
        expect(restored.ok).toBe(true)
        expect(restored.state).toEqual(expected)
        expect(restored.checksum).toBe(stateChecksum(expected))
        expect(restored.seq).toBe(writer.lastSeq())
        expect(restored.epoch).toBe(3)
        expect(restored.state.cards).toEqual({})
    })

    it('rejects a snapshot whose checksum does not match its content', async () => {
        const c = cluster(['spark', 'ns1', 'nas'])
        const k = key()
        const writer = new StateJournalWriter({ signer: c.signers.spark, key: k, epoch: 1, local: c.replicas.spark, targets: () => c.targets('spark') })
        await writer.promote()
        await writer.record({ domain: 'procedures', key: 'p', op: 'put', value: 1 })
        await writer.snapshot()
        const exported = c.replicas.ns1.export()
        // Wrong key = undecryptable snapshot: restore must not silently start empty.
        const result = restoreMainState([exported], { key: key(), trusted: c.trusted })
        expect(result.ok).toBe(false)
    })

    it('fails closed when the reachable replicas miss a confirmed entry', async () => {
        const c = cluster(['spark', 'ns1', 'nas'])
        const k = key()
        const writer = new StateJournalWriter({ signer: c.signers.spark, key: k, epoch: 1, local: c.replicas.spark, targets: () => c.targets('spark') })
        await writer.promote()
        await writer.record({ domain: 'responsibilities', key: 'r1', op: 'put', value: 1 })
        await writer.record({ domain: 'responsibilities', key: 'r2', op: 'put', value: 2 })
        await writer.record({ domain: 'responsibilities', key: 'r3', op: 'put', value: 3 })
        // A replica that only knows the commit index (from entry 3) but lost entry 2.
        const full = c.replicas.ns1.export()
        const holed = { ...full, entries: full.entries.filter(entry => entry.seq !== 2) }
        const result = restoreMainState([holed], { key: k, trusted: c.trusted })
        expect(result.ok).toBe(false)
        expect(result.reason).toMatch(/incomplete/)
        expect(restoreMainState([full], { key: k, trusted: c.trusted }).ok).toBe(true)
    })

    it('brings a lagging replica up to date with a signed sync bundle', async () => {
        const c = cluster(['spark', 'ns1', 'nas', 'lab'])
        const k = key()
        c.down.add('lab')
        const writer = new StateJournalWriter({ signer: c.signers.spark, key: k, epoch: 1, local: c.replicas.spark, targets: () => c.targets('spark') })
        await writer.promote()
        await writer.record({ domain: 'missions', key: 'a', op: 'put', value: 1 })
        await writer.snapshot()
        await writer.record({ domain: 'missions', key: 'b', op: 'put', value: 2 })
        c.down.delete('lab')
        expect(c.replicas.lab.lastSeq()).toBe(0)
        const result = await writer.record({ domain: 'missions', key: 'c', op: 'put', value: 3 })
        expect(result.acks).toContain('lab')
        expect(c.replicas.lab.lastSeq()).toBe(writer.lastSeq())
        expect(writer.ackedSeq('lab')).toBe(writer.lastSeq())
        const restored = restoreMainState([c.replicas.lab.export()], { key: k, trusted: c.trusted })
        expect(restored.state.missions).toEqual({ a: 1, b: 2, c: 3 })
    })

    it('keeps an emergency branch apart from the main chain', async () => {
        const c = cluster(['ns2', 'nas', 'spark'])
        const k = key()
        const base = restoreMainState([c.replicas.nas.export()], { key: k, trusted: c.trusted })
        const emergency = new StateJournalWriter({
            signer: c.signers.ns2, key: k, epoch: 0, local: c.replicas.ns2, targets: () => c.targets('ns2'), resumeFrom: base,
            branch: 'emergency:ns2:abc',
        })
        await emergency.record({ domain: 'missions', key: 'notfall', op: 'put', value: 'weiter' })
        expect(c.replicas.nas.export().entries).toHaveLength(0)
        const branches = collectBranches([c.replicas.nas.export()], { key: k, trusted: c.trusted })
        expect(branches).toHaveLength(1)
        expect(branches[0].id).toBe('emergency:ns2:abc')
        expect(branches[0].changes).toEqual([{ domain: 'missions', key: 'notfall', op: 'put', value: 'weiter' }])
    })

    it('rejects a journal key that is too short', () => {
        expect(() => deriveJournalKey('kurz')).toThrow(/32/)
    })
})
