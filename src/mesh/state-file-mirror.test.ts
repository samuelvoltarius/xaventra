import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JournalReplica, MAIN_STATE_DOMAINS, StateJournalWriter, createMemorySigner, deriveJournalKey, restoreMainState } from './state-journal.js'
import { MAIN_STATE_FILES, materializeStateFiles, scanStateFileChanges } from './state-file-mirror.js'

function put(dir: string, rel: string, content: string) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
}

describe('state file mirror (.nova-data stores ↔ journal)', () => {
    it('covers every Main state domain with a real store file', () => {
        for (const domain of MAIN_STATE_DOMAINS) expect(MAIN_STATE_FILES.some(file => file.domain === domain)).toBe(true)
    })

    it('journals file changes and materializes the full state on the successor', async () => {
        const main = mkdtempSync(join(tmpdir(), 'xaventra-mirror-main-'))
        const successor = mkdtempSync(join(tmpdir(), 'xaventra-mirror-next-'))
        put(main, 'auftraege.json', JSON.stringify([{ id: 'a1', title: 'Backup prüfen' }]))
        put(main, 'approval-cards/cards.json', '{"cards":[]}')
        put(main, 'learning/procedures.json', '{"procedures":[1]}')
        const names = ['spark', 'ns1', 'nas']
        const signers = Object.fromEntries(names.map(name => [name, createMemorySigner(name)]))
        const trusted = Object.fromEntries(names.map(name => [name, signers[name].publicKey]))
        const replicas = Object.fromEntries(names.map(name => [name, new JournalReplica({ nodeId: name, trusted })]))
        const key = deriveJournalKey(randomBytes(32).toString('hex'))
        const writer = new StateJournalWriter({
            signer: signers.spark, key, epoch: 1, local: replicas.spark,
            targets: () => ['ns1', 'nas'].map(nodeId => ({ nodeId, deliver: async message => replicas[nodeId].receive(message) })),
        })
        await writer.promote()

        const first = scanStateFileChanges(main, writer.state())
        expect(first.changes.map(change => change.key).sort()).toEqual(['approval-cards/cards.json', 'auftraege.json', 'learning/procedures.json'])
        expect((await writer.record(first.changes)).committed).toBe(true)
        expect(scanStateFileChanges(main, writer.state()).changes).toEqual([])

        put(main, 'approval-cards/cards.json', '{"cards":[{"id":"c1"}]}')
        rmSync(join(main, 'learning/procedures.json'))
        const second = scanStateFileChanges(main, writer.state())
        expect(second.changes.map(change => `${change.op}:${change.key}`).sort()).toEqual(['delete:learning/procedures.json', 'put:approval-cards/cards.json'])
        await writer.record(second.changes)

        const restored = restoreMainState([replicas.ns1.export(), replicas.nas.export()], { key, trusted })
        const written = materializeStateFiles(restored.state, successor)
        expect(written.sort()).toEqual(['approval-cards/cards.json', 'auftraege.json'])
        expect(readFileSync(join(successor, 'approval-cards/cards.json'), 'utf8')).toBe('{"cards":[{"id":"c1"}]}')
        expect(readFileSync(join(successor, 'auftraege.json'), 'utf8')).toContain('Backup prüfen')
        expect(existsSync(join(successor, 'learning/procedures.json'))).toBe(false)
    })

    it('never writes outside the known store files', () => {
        const target = mkdtempSync(join(tmpdir(), 'xaventra-mirror-evil-'))
        const evil = { missions: { '../../escape.json': { sha256: 'x', content: 'boom' } }, cards: { 'approval-cards/cards.json': { sha256: 'bad', content: 'tampered' } } }
        expect(materializeStateFiles(evil, target)).toEqual([])
        expect(existsSync(join(target, '..', '..', 'escape.json'))).toBe(false)
    })
})
