import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
    JournalReplica, NoQuorumError, StateJournalWriter, deriveJournalKeys, restoreMainState, sealEntry, verifyChain,
    type JournalReplicationTarget,
} from './state-journal.js'
import {
    ShareHolder, combineShares, createShareKeyPair, openSealedShare, sealSecretVault, shareThreshold, splitSecret,
    unlockVaultWithOwnerCode, unlockVaultWithShares,
} from './secret-vault.js'
import { EmergencyCodeGate, createEmergencyCodeRecord, normalizeEmergencyCode } from './emergency-code.js'
import { isNodeMainEligible, parseSuccessionConfig } from './succession-config.js'

const keys = deriveJournalKeys('k'.repeat(48))
const target = (replica: JournalReplica): JournalReplicationTarget => ({ nodeId: replica.nodeId, deliver: async message => replica.append(message) })

describe('2.88 state journal', () => {
    it('replicates, commits on a majority and restores the full Main state', async () => {
        const a = new JournalReplica('node-a', keys)
        const b = new JournalReplica('node-b', keys)
        const c = new JournalReplica('node-c', keys)
        const writer = new StateJournalWriter({ nodeId: 'node-a', epoch: 1, keys, local: a, targets: () => [target(b), target(c)], quorum: 2 })
        await writer.start()
        const result = await writer.record([
            { domain: 'memory', key: 'fact:1', value: { text: 'Lieblingsfarbe blau' } },
            { domain: 'connections', key: 'mail', value: { provider: 'example.com', status: 'verbunden' } },
            { domain: 'responsibilities', key: 'heizung', value: { owner: 'Main' } },
            { domain: 'cards', key: 'card-1', value: { open: true } },
            { domain: 'config', key: 'language', value: 'de' },
        ])
        expect(result.committed).toBe(true)
        expect(result.acks.sort()).toEqual(['node-a', 'node-b', 'node-c'])
        const restored = restoreMainState(keys, [b.export(), c.export()], { quorum: 2 })
        expect(restored.state.memory['fact:1']).toEqual({ text: 'Lieblingsfarbe blau' })
        expect(restored.state.config.language).toBe('de')
        expect(restored.maxEpoch).toBe(1)
        // Replicas store ciphertext only.
        expect(JSON.stringify(b.export())).not.toContain('Lieblingsfarbe')
    })

    it('fails closed without a majority of readable replicas', () => {
        const a = new JournalReplica('node-a', keys)
        expect(() => restoreMainState(keys, [a.export()], { quorum: 2 })).toThrow(NoQuorumError)
    })

    it('rejects tampered entries and a broken chain', async () => {
        const a = new JournalReplica('node-a', keys)
        const writer = new StateJournalWriter({ nodeId: 'node-a', epoch: 1, keys, local: a, targets: () => [], quorum: 1 })
        await writer.start()
        await writer.record({ domain: 'memory', key: 'x', value: 1 })
        const log = a.log()
        log[1] = { ...log[1], data: Buffer.from('evil').toString('base64') }
        expect(verifyChain(keys, log).ok).toBe(false)
        const fresh = new JournalReplica('node-b', keys)
        expect(fresh.append({ entries: log, replace: true }).reason).toBe('invalid')
        const otherKeys = deriveJournalKeys('z'.repeat(48))
        expect(new JournalReplica('node-c', otherKeys).append({ entries: a.log() }).reason).toBe('invalid')
    })

    it('fences an old writer once any replica saw a newer term', async () => {
        const a = new JournalReplica('node-a', keys)
        const b = new JournalReplica('node-b', keys)
        const c = new JournalReplica('node-c', keys)
        const old = new StateJournalWriter({ nodeId: 'node-a', epoch: 1, keys, local: a, targets: () => [target(b), target(c)], quorum: 2 })
        await old.start()
        await old.record({ domain: 'memory', key: 'before', value: 1 })
        const restored = restoreMainState(keys, [b.export(), c.export()], { quorum: 2 })
        b.adoptRestoredLog(restored.entries)
        const successor = new StateJournalWriter({ nodeId: 'node-b', epoch: 2, keys, local: b, targets: () => [target(c)], quorum: 2, state: restored.state })
        await successor.start()
        await expect(old.record({ domain: 'memory', key: 'after-takeover', value: 1 })).rejects.toThrow(/fenced/)
        expect(old.isFenced()).toBe(true)
        await expect(old.record({ domain: 'memory', key: 'again', value: 1 })).rejects.toThrow(/fenced/)
        expect(restoreMainState(keys, [b.export(), c.export()], { quorum: 2 }).state.memory['after-takeover']).toBeUndefined()
    })

    it('catches up a lagging replica and drops an old uncommitted tail', async () => {
        const a = new JournalReplica('node-a', keys)
        const b = new JournalReplica('node-b', keys)
        const c = new JournalReplica('node-c', keys)
        let cOnline = false
        const writer = new StateJournalWriter({
            nodeId: 'node-a', epoch: 1, keys, local: a, quorum: 2,
            targets: () => [target(b), { nodeId: 'node-c', deliver: async message => cOnline ? c.append(message) : null }],
        })
        await writer.start()
        await writer.record({ domain: 'memory', key: 'one', value: 1 })
        cOnline = true
        const result = await writer.record({ domain: 'memory', key: 'two', value: 2 })
        expect(result.acks).toContain('node-c')
        expect(c.lastSeq()).toBe(a.lastSeq())
        // Old tail at seq 4 only on node-a (never committed), then a new term on b+c.
        a.append({ entries: [sealEntry(keys, { seq: 4, epoch: 1, nodeId: 'node-a', kind: 'change', prevHash: a.lastHash(), payload: [{ domain: 'memory', key: 'lost', value: 1 }] })] })
        const restored = restoreMainState(keys, [b.export(), c.export()], { quorum: 2 })
        b.adoptRestoredLog(restored.entries)
        const successor = new StateJournalWriter({ nodeId: 'node-b', epoch: 2, keys, local: b, targets: () => [target(a), target(c)], quorum: 2, state: restored.state })
        const start = await successor.start()
        expect(start.acks.sort()).toEqual(['node-a', 'node-b', 'node-c'])
        expect(restoreMainState(keys, [a.export()], { quorum: 1 }).state.memory.lost).toBeUndefined()
    })

    it('compacts to a snapshot and still restores', async () => {
        const a = new JournalReplica('node-a', keys)
        const b = new JournalReplica('node-b', keys)
        const writer = new StateJournalWriter({ nodeId: 'node-a', epoch: 1, keys, local: a, targets: () => [target(b)], quorum: 2, snapshotEvery: 3 })
        await writer.start()
        for (let i = 0; i < 4; i++) await writer.record({ domain: 'cards', key: `c${i}`, value: i })
        expect(a.log()[0].kind).toBe('snapshot')
        const restored = restoreMainState(keys, [a.export(), b.export()], { quorum: 2 })
        expect(Object.keys(restored.state.cards).sort()).toEqual(['c0', 'c1', 'c2', 'c3'])
    })

    it('keeps its high-water mark across restarts and refuses a corrupt file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'xv-journal-'))
        const file = join(dir, 'journal.json')
        const replica = new JournalReplica('node-b', keys, file)
        replica.observeEpoch(7)
        expect(new JournalReplica('node-b', keys, file).highWater()).toBe(7)
        const stale = sealEntry(keys, { seq: 1, epoch: 3, nodeId: 'node-a', kind: 'term', prevHash: '', payload: {} })
        expect(new JournalReplica('node-b', keys, file).append({ entries: [stale] }).reason).toBe('stale-epoch')
        writeFileSync(file, '{broken')
        expect(() => new JournalReplica('node-b', keys, file)).toThrow(/refusing/)
    })
})

describe('2.88 secret vault', () => {
    const holders = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'].map(nodeId => ({ nodeId, pair: createShareKeyPair() }))
    const sealed = sealSecretVault({ TELEGRAM_BOT_TOKEN: 'test-telegram-token', MAIL_TOKEN: 'test-mail-token' },
        holders.map(item => ({ nodeId: item.nodeId, publicKey: item.pair.publicKey })), { ownerCode: 'Sonne-Mond-42' })

    it('needs a majority of shares; fewer reveal nothing', () => {
        expect(sealed.vault.k).toBe(shareThreshold(5))
        const shares = holders.map(item => openSealedShare(sealed.sealedShares[item.nodeId], item.pair))
        expect(() => unlockVaultWithShares(sealed.vault, shares.slice(0, 2))).toThrow(/needs 3/)
        expect(unlockVaultWithShares(sealed.vault, shares.slice(2)).get('TELEGRAM_BOT_TOKEN')).toBe('test-telegram-token')
        const raw = Buffer.from('0123456789abcdef')
        expect(combineShares(splitSecret(raw, 5, 3).slice(1, 4)).equals(raw)).toBe(true)
    })

    it('stores only ciphertext and redacts unlocked secrets', () => {
        expect(JSON.stringify(sealed)).not.toContain('test-telegram-token')
        const secrets = unlockVaultWithOwnerCode(sealed.vault, 'sonne mond 42')
        expect(JSON.stringify(secrets)).not.toContain('test-telegram-token')
        expect(String(secrets)).not.toContain('test-telegram-token')
        expect(inspect(secrets)).not.toContain('test-telegram-token')
        secrets.wipe()
        expect(secrets.get('TELEGRAM_BOT_TOKEN')).toBeUndefined()
    })

    it('opens with the right owner code only; the error never echoes the code', () => {
        expect(() => unlockVaultWithOwnerCode(sealed.vault, 'falscher-code-1')).toThrow(/does not match/)
        try { unlockVaultWithOwnerCode(sealed.vault, 'falscher-code-1') } catch (error) { expect(String(error)).not.toContain('falscher') }
    })

    it('a holder releases its share only for a confirmed, current Main claim', async () => {
        const requester = createShareKeyPair()
        let confirmed = false
        const holder = new ShareHolder({
            nodeId: 'node-c', keyPair: holders[2].pair, sealedShare: sealed.sealedShares['node-c'],
            verifyMainClaim: claim => confirmed && claim.requester === 'node-b' && claim.epoch === 5, highWater: () => 5,
        })
        expect((await holder.release({ requester: 'node-b', requesterPublicKey: requester.publicKey, epoch: 5 })).ok).toBe(false)
        confirmed = true
        expect((await holder.release({ requester: 'node-b', requesterPublicKey: requester.publicKey, epoch: 4 })).reason).toMatch(/stale/)
        const release = await holder.release({ requester: 'node-b', requesterPublicKey: requester.publicKey, epoch: 5 })
        expect(release.ok).toBe(true)
        expect(openSealedShare(release.share!, requester)).toMatch(/^xvs1\./)
        expect(() => openSealedShare(release.share!, holders[0].pair)).toThrow()
    })

    it('two nodes cannot split a majority: the owner code is then required', () => {
        const two = holders.slice(0, 2).map(item => ({ nodeId: item.nodeId, publicKey: item.pair.publicKey }))
        expect(() => sealSecretVault({ A: 'b' }, two)).toThrow(/owner emergency code/)
        const small = sealSecretVault({ A: 'b' }, two, { ownerCode: 'nur-mit-code-1' })
        expect(small.vault.k).toBe(0)
        expect(Object.keys(small.sealedShares)).toEqual([])
    })
})

describe('2.88 owner emergency code', () => {
    it('stores only a salted hash and accepts the right code (format-tolerant)', () => {
        const record = createEmergencyCodeRecord('Sonne-Mond-42')
        expect(JSON.stringify(record)).not.toMatch(/sonne|mond/i)
        const gate = new EmergencyCodeGate({ record })
        expect(gate.verify('sonne mond 42').ok).toBe(true)
        expect(normalizeEmergencyCode(' so-nne_42 ')).toBe('SONNE42')
        expect(() => createEmergencyCodeRecord('kurz')).toThrow(/mindestens/)
    })

    it('counts wrong codes, locks and keeps the lock across restarts', () => {
        let now = 1_000_000
        const dir = mkdtempSync(join(tmpdir(), 'xv-emergency-'))
        const attemptsFile = join(dir, 'attempts.json')
        const record = createEmergencyCodeRecord('Sonne-Mond-42')
        const gate = new EmergencyCodeGate({ record, attemptsFile, now: () => now, maxAttempts: 3, lockMs: 60_000 })
        expect(gate.verify('falsch-falsch-1').reason).toBe('invalid')
        expect(gate.verify('falsch-falsch-2').reason).toBe('invalid')
        expect(gate.verify('falsch-falsch-3').reason).toBe('locked')
        // Even the right code is refused while locked.
        expect(gate.verify('Sonne-Mond-42').ok).toBe(false)
        expect(readFileSync(attemptsFile, 'utf8')).not.toMatch(/falsch|sonne/i)
        const restarted = new EmergencyCodeGate({ record, attemptsFile, now: () => now, maxAttempts: 3, lockMs: 60_000 })
        expect(restarted.verify('Sonne-Mond-42').reason).toBe('locked')
        now += 60_001
        expect(restarted.verify('Sonne-Mond-42').ok).toBe(true)
    })

    it('does the same work without a configured code', () => {
        const gate = new EmergencyCodeGate({ record: null })
        expect(gate.configured()).toBe(false)
        expect(gate.verify('irgendwas-1234').reason).toBe('not-configured')
    })
})

describe('2.88 main eligibility is an owner decision', () => {
    it('defaults to worker once succession is on; legacy rule otherwise', () => {
        const on = { mesh: { succession: { enabled: true } } }
        expect(isNodeMainEligible({}, on)).toBe(false)
        expect(isNodeMainEligible({ NOVA_MAIN_ELIGIBLE: 'true' }, on)).toBe(true)
        expect(isNodeMainEligible({}, { mesh: { succession: { enabled: true, mainEligible: true } } })).toBe(true)
        expect(isNodeMainEligible({ NOVA_MAIN_ELIGIBLE: 'false' }, { mesh: { succession: { enabled: true, mainEligible: true } } })).toBe(false)
        expect(isNodeMainEligible({}, null)).toBe(true)
        expect(isNodeMainEligible({ NOVA_MAIN_ELIGIBLE: 'false' }, null)).toBe(false)
        expect(parseSuccessionConfig({ mesh: { succession: { emergencyMaxMinutes: 99_999 } } }).emergencyMaxMs).toBe(24 * 60 * 60_000)
    })
})
