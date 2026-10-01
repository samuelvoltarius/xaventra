import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    answerApprovalCard, cardKeyboard, createApprovalCard, listApprovalCards, maintainApprovalCards, readThoughts,
    registerCardExecutor, unregisterCardExecutor, type ApprovalCard, type CardStoreOptions,
} from './approval-cards.js'

// Phase 1 / CL-10: Ja-Knopf-Rahmen. Every safeguard below has a Gegenprobe
// (remove the guard -> this file turns red), see the branch report.

const OWNER = '111'
let clock = Date.parse('2026-10-01T10:00:00Z')
let opts: CardStoreOptions
let ledger: { recordApproval: ReturnType<typeof vi.fn> }
let executed: Array<{ id: string; answer: string }>

const tokenFor = (card: ApprovalCard, answer: string) => card.buttons.find(button => button.answer === answer)!.token
const dataFor = (card: ApprovalCard, answer: string) => `ac:${tokenFor(card, answer)}`
const press = (data: string, userId = OWNER, ownerIds: string[] = [OWNER]) => answerApprovalCard(data, { userId, ownerIds }, opts)

function newCard(overrides: Record<string, unknown> = {}) {
    const result = createApprovalCard({
        art: 'test-intern', titel: 'Testvorschlag', beleg: 'Messwert 42', vorschlag: 'Bitte ausführen',
        aktion: { kind: 'test-intern', ref: 'ref-1' }, ...overrides,
    }, opts)
    if (!result.ok) throw new Error(result.reason)
    return result.card
}

beforeEach(() => {
    clock = Date.parse('2026-10-01T10:00:00Z')
    ledger = { recordApproval: vi.fn() }
    opts = { dataDir: mkdtempSync(join(tmpdir(), 'approval-cards-')), now: () => clock, ledger }
    executed = []
    for (const kind of ['test-intern', 'drucken', 'email-senden']) {
        unregisterCardExecutor(kind)
        registerCardExecutor({
            kind,
            allowAlways: () => true,
            async execute(card, answer) { executed.push({ id: card.id, answer }); return { ok: true, message: 'ausgeführt' } },
            async reject(card) { executed.push({ id: card.id, answer: 'nein' }); return { ok: true, message: 'abgelehnt' } },
        })
    }
})

describe('callback_data', () => {
    it('is a short code id (<= 64 bytes) without parameters', () => {
        const card = newCard({ aktion: { kind: 'test-intern', ref: 'iq-0123456789ab' } })
        const buttons = cardKeyboard(card).flat()
        expect(buttons.length).toBeGreaterThanOrEqual(3)
        for (const button of buttons) {
            expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64)
            expect(button.callback_data).toMatch(/^ac:[a-f0-9]{16}$/)
            expect(button.callback_data).not.toContain(card.id)
            expect(button.callback_data).not.toContain('iq-')
        }
        expect(new Set(buttons.map(button => button.callback_data)).size).toBe(buttons.length)
    })

    it('rejects anything that is not a known code id', async () => {
        newCard()
        expect((await press('ac:ffffffffffffffff')).code).toBe('unbekannt')
        expect((await press('ac:../../etc')).code).toBe('unbekannt')
        expect(executed).toHaveLength(0)
    })
})

describe('only the owner can press', () => {
    it('refuses a non-owner and leaves the card answerable for the owner', async () => {
        const card = newCard()
        const denied = await press(dataFor(card, 'ja'), '222')
        expect(denied).toMatchObject({ ok: false, code: 'kein-owner' })
        expect(executed).toHaveLength(0)
        expect(listApprovalCards({ ...opts, status: 'offen' })).toHaveLength(1)
        const accepted = await press(dataFor(card, 'ja'))
        expect(accepted).toMatchObject({ ok: true, code: 'ok' })
        expect(executed).toEqual([{ id: card.id, answer: 'ja' }])
    })

    it('accepts only numeric Telegram ids from allowFrom, never usernames', async () => {
        const card = newCard()
        expect((await press(dataFor(card, 'ja'), 'alfred', ['@alfred', 'alfred'])).code).toBe('kein-owner')
        expect((await press(dataFor(card, 'ja'), '111', ['@alfred'])).code).toBe('kein-owner')
        expect(executed).toHaveLength(0)
    })
})

describe('every answer is single-use', () => {
    it('rejects a replay of the same button and every other button of the card', async () => {
        const card = newCard()
        expect((await press(dataFor(card, 'ja'))).ok).toBe(true)
        expect(await press(dataFor(card, 'ja'))).toMatchObject({ ok: false, code: 'verbraucht' })
        expect(await press(dataFor(card, 'nein'))).toMatchObject({ ok: false, code: 'verbraucht' })
        expect(executed).toEqual([{ id: card.id, answer: 'ja' }])
    })

    it('rejects an expired card', async () => {
        const card = newCard({ ablaufMs: 60_000 })
        clock += 61_000
        expect(await press(dataFor(card, 'ja'))).toMatchObject({ ok: false, code: 'abgelaufen' })
        expect(executed).toHaveLength(0)
        expect(listApprovalCards(opts)[0].status).toBe('abgelaufen')
    })

    it('"Später" consumes the tokens and resurfaces the card with fresh ones', async () => {
        const card = newCard({ ablaufMs: 24 * 3600_000 })
        expect((await press(dataFor(card, 'spaeter'))).ok).toBe(true)
        expect(executed).toHaveLength(0)
        clock += 5 * 3600_000
        const { resurfaced } = maintainApprovalCards(opts)
        expect(resurfaced).toHaveLength(1)
        expect(await press(dataFor(card, 'ja'))).toMatchObject({ code: 'verbraucht' })
        expect((await press(dataFor(resurfaced[0], 'ja'))).ok).toBe(true)
        expect(executed).toEqual([{ id: card.id, answer: 'ja' }])
    })

    it('writes every answer into the outcome ledger', async () => {
        const card = newCard()
        await press(dataFor(card, 'nein'))
        expect(ledger.recordApproval).toHaveBeenCalledWith(`approval-card-${card.id}`, expect.objectContaining({ answer: 'nein', decidedBy: 'telegram:111', art: 'test-intern' }))
    })
})

describe('Nie-Liste', () => {
    it('never creates a card for a Nie-Liste effect or kind, but records the discarded thought', () => {
        expect(createApprovalCard({ art: 'test-intern', titel: 'Backups aufräumen', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-intern', ref: 'x' }, effects: ['backup:loeschen'] }, opts))
            .toMatchObject({ ok: false })
        expect(createApprovalCard({ art: 'db-migration', titel: 'Schema', beleg: 'b', vorschlag: 'v', aktion: { kind: 'db-migration', ref: 'x' } }, opts))
            .toMatchObject({ ok: false })
        expect(createApprovalCard({ art: 'test-intern', titel: 'NAS', beleg: 'b', vorschlag: 'v', aktion: { kind: 'nas-neustart', ref: 'x' } }, opts))
            .toMatchObject({ ok: false })
        expect(listApprovalCards(opts)).toHaveLength(0)
        expect(readThoughts(opts).filter(item => item.status === 'verworfen')).toHaveLength(3)
    })
})

describe('"Immer erlauben"', () => {
    const labels = (card: ApprovalCard) => cardKeyboard(card).flat().map(button => button.text)

    it('is offered for internal actions whose executor supports a standing permission', () => {
        expect(labels(newCard())).toEqual(expect.arrayContaining([expect.stringMatching(/Ja/), expect.stringMatching(/Nein/), expect.stringMatching(/Später/), expect.stringMatching(/Immer erlauben/)]))
    })

    it('is never offered for printing or sending, even if the caller claims "intern"', () => {
        const print = newCard({ art: 'drucken', wirkung: 'intern', aktion: { kind: 'drucken', ref: 'job-1' } })
        const mail = newCard({ art: 'email-senden', wirkung: 'intern', aktion: { kind: 'email-senden', ref: 'draft-1' } })
        for (const card of [print, mail]) {
            expect(card.wirkung).not.toBe('intern')
            expect(labels(card).some(text => /Immer/.test(text))).toBe(false)
            expect(card.buttons.some(button => button.answer === 'immer')).toBe(false)
            expect(labels(card)).toEqual(expect.arrayContaining([expect.stringMatching(/Ja/), expect.stringMatching(/Nein/), expect.stringMatching(/Später/)]))
        }
    })

    it('is not offered when the executor has no standing permission', () => {
        unregisterCardExecutor('test-intern')
        registerCardExecutor({ kind: 'test-intern', async execute() { return { ok: true, message: 'x' } } })
        expect(labels(newCard()).some(text => /Immer/.test(text))).toBe(false)
    })
})

describe('dedupe', () => {
    it('returns the open card for the same dedupe key instead of a second one', () => {
        const first = createApprovalCard({ art: 'test-intern', titel: 't', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-intern', ref: 'r' }, dedupeKey: 'k1' }, opts)
        const second = createApprovalCard({ art: 'test-intern', titel: 't', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-intern', ref: 'r' }, dedupeKey: 'k1' }, opts)
        expect(first.ok && second.ok && first.card.id === second.card.id && second.created === false).toBe(true)
        expect(listApprovalCards(opts)).toHaveLength(1)
    })
})
