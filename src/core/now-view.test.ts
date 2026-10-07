import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, createApprovalCard, registerCardExecutor, unregisterCardExecutor, type CardStoreOptions } from './approval-cards.js'
import { collectGedanken, formatGedanken, formatJetzt } from './now-view.js'

// /jetzt and /gedanken: visible proof that Xaventra works and thinks,
// including discarded and rejected ideas.

let opts: CardStoreOptions
let clock = Date.parse('2026-10-01T10:00:00Z')

beforeEach(() => {
    clock = Date.parse('2026-10-01T10:00:00Z')
    opts = { dataDir: mkdtempSync(join(tmpdir(), 'now-view-')), now: () => clock, ledger: { recordApproval: vi.fn() } }
    unregisterCardExecutor('nv-test')
    registerCardExecutor({ isStillOpen: () => true, kind: 'nv-test', async execute() { return { ok: true, message: 'ok' } } })
})

describe('/jetzt', () => {
    it('shows tasks, queue, open cards and the last decisions', () => {
        const text = formatJetzt({
            now: clock,
            tasks: [{ label: '⚙️ Schritt 2/4: screenshot', since: clock - 12_000, source: 'Telegram' }],
            queue: ['iq-0123456789ab: ffmpeg auf spark wartet auf Freigabe'],
            openCards: [{ id: 'k1', art: 'install', titel: 'ffmpeg installieren', createdAt: new Date(clock - 60_000).toISOString(), expiresAt: new Date(clock + 3600_000).toISOString() } as any],
            decisions: [{ id: 'k0', art: 'patch', titel: 'Patch x', answer: 'nein', decidedAt: new Date(clock - 120_000).toISOString(), result: { ok: true, message: 'abgelehnt' } } as any],
        })
        expect(text).toMatch(/Schritt 2\/4: screenshot/)
        expect(text).toMatch(/ffmpeg auf spark/)
        expect(text).toMatch(/ffmpeg installieren/)
        expect(text).toMatch(/Patch x/)
        expect(text).toMatch(/Nein/)
    })

    it('says plainly when nothing is running', () => {
        expect(formatJetzt({ now: clock, tasks: [], queue: [], openCards: [], decisions: [] })).toMatch(/keine laufende Aufgabe/i)
    })
})

describe('/gedanken', () => {
    it('lists ideas including discarded ones from cards, Nie-Liste and the self-heal journal', async () => {
        const created = createApprovalCard({ art: 'nv-test', titel: 'Idee A', beleg: 'b', vorschlag: 'v', aktion: { kind: 'nv-test', ref: 'a' } }, opts)
        if (!created.ok) throw new Error(created.reason)
        await answerApprovalCard(`ac:${created.card.buttons.find(button => button.answer === 'nein')!.token}`, { userId: '111', ownerIds: ['111'] }, opts)
        createApprovalCard({ art: 'nv-test', titel: 'Backups löschen', beleg: 'b', vorschlag: 'v', aktion: { kind: 'nv-test', ref: 'b' }, effects: ['backup:loeschen'] }, opts)
        mkdirSync(join(opts.dataDir!, 'self-heal', 'journal'), { recursive: true })
        writeFileSync(join(opts.dataDir!, 'self-heal', 'journal', '2026-10-01.jsonl'), `${JSON.stringify({ id: 'j1', at: '2026-10-01T09:00:00.000Z', node: 'spark', recipe: 'log-rotation', level: 'auto', signature: 'log>1GB', befund: {}, aktion: 'Logs archiviert', ergebnis: 'geheilt', fence: { held: true, mode: 'observe', note: '' }, message: 'Logs archivieren: geheilt' })}\n`)
        const items = await collectGedanken({ ...opts, installDataDir: join(opts.dataDir!, 'install') })
        const text = formatGedanken(items)
        expect(text).toMatch(/Idee A/)
        expect(text).toMatch(/abgelehnt|Nein/)
        expect(text).toMatch(/Backups löschen/)
        expect(text).toMatch(/verworfen/)
        expect(text).toMatch(/Logs archivieren: geheilt/)
    })
})
