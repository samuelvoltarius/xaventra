import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor } from './approval-cards.js'
import { deliverPendingCards } from './approval-card-sources.js'
import { deliverBundles } from './card-bundle.js'
import { planQuestions, waitingQuestionCount } from './question-queue.js'

// 2.86 Paket M Punkt 2: immer nur EINE Frage zur Zeit; der Rest wartet geordnet.

let dir: string
let t: number
const HOUR = 60 * 60_000
const opts = () => ({ dataDir: dir, now: () => t, ledger: null })
function telegram() {
    const log: Array<{ op: 'send' | 'edit'; text: string; keyboard: any[][] }> = []
    let id = 10
    return {
        log,
        canSend: async () => true, ownerChatIds: () => ['111'],
        send: async (_chatId: string, text: string, keyboard: any[][]) => { log.push({ op: 'send', text, keyboard }); return ++id },
        edit: async (_chatId: string, _messageId: number, text: string, keyboard: any[][]) => { log.push({ op: 'edit', text, keyboard }) },
    }
}
const card = (titel: string, ref: string, extra: Record<string, unknown> = {}) => {
    const created = createApprovalCard({ art: 'install', titel, beleg: 'Katalog', vorschlag: 'Installieren', aktion: { kind: 'install', ref }, ...extra } as any, opts())
    if (!created.ok) throw new Error('card')
    return created.card
}
const press = (data: string) => answerApprovalCard(data, { userId: '111', ownerIds: ['111'] }, opts())

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'question-queue-'))
    t = Date.parse('2026-10-06T10:00:00.000Z')
    registerCardExecutor({ kind: 'install', impact: 'intern', async execute() { return { ok: true, message: 'installiert' } }, async reject() { return { ok: true, message: 'nein' } } })
    registerCardExecutor({ kind: 'geraet-verbinden', impact: 'intern', async execute() { return { ok: true, message: 'verbunden' } }, async reject() { return { ok: true, message: 'nein' } } })
})
afterEach(() => { unregisterCardExecutor('install'); unregisterCardExecutor('geraet-verbinden'); rmSync(dir, { recursive: true, force: true }) })

describe('Frage-Warteschlange', () => {
    it('pushes only ONE question; the next comes after the answer, ordered by importance', async () => {
        card('ffmpeg installieren?', 'iq-1', { ablaufMs: 48 * HOUR })
        card('Kamera einrichten?', 'iq-2', { ablaufMs: 24 * HOUR })
        card('Drucker prüfen?', 'iq-3', { ablaufMs: 30 * HOUR, wirkung: 'physisch' })
        const tg = telegram()
        expect(await deliverPendingCards(tg, opts())).toBe(1)
        expect(await deliverPendingCards(tg, opts())).toBe(0)
        expect(tg.log).toHaveLength(1)
        // physical first (more important), then the earlier deadline
        expect(tg.log[0].text).toContain('Drucker prüfen?')
        expect(waitingQuestionCount(opts())).toBe(2)
        await press(tg.log[0].keyboard[0][0].callback_data)
        expect(await deliverPendingCards(tg, opts())).toBe(1)
        expect(tg.log[1].text).toContain('Kamera einrichten?')
        await press(tg.log[1].keyboard[0][1].callback_data) // Nein also frees the slot
        expect(await deliverPendingCards(tg, opts())).toBe(1)
        expect(tg.log[2].text).toContain('ffmpeg installieren?')
        expect(waitingQuestionCount(opts())).toBe(0)
        // nothing lost: every card was asked
        expect(listApprovalCards(opts()).every(item => item.deliveredAt)).toBe(true)
    })

    it('critical questions and real deadlines jump the queue', async () => {
        card('ffmpeg installieren?', 'iq-1')
        const tg = telegram()
        expect(await deliverPendingCards(tg, opts())).toBe(1)
        card('Speicher fast voll – Ausfall droht', 'iq-2', { wichtigkeit: 'hoch' })
        card('Update bis heute Abend?', 'iq-3', { ablaufMs: HOUR })
        card('Kamera einrichten?', 'iq-4')
        expect(await deliverPendingCards(tg, opts())).toBe(2)
        expect(tg.log.map(item => item.text.split('\n')[0])).toEqual(['🔘 ffmpeg installieren?', '🔘 Speicher fast voll – Ausfall droht', '🔘 Update bis heute Abend?'])
        expect(waitingQuestionCount(opts())).toBe(1)
    })

    it('a device bundle counts as one question and waits while a card is visible (and vice versa)', async () => {
        card('ffmpeg installieren?', 'iq-1')
        const tg = telegram()
        await deliverPendingCards(tg, opts())
        createApprovalCard({ art: 'geraet-verbinden', titel: 'Hue verbinden?', beleg: 'Fund', vorschlag: 'Ja', aktion: { kind: 'geraet-verbinden', ref: 'dev-0000000001' }, buendel: 'geraete', kurz: 'Hue Bridge', ablaufMs: 72 * HOUR } as any, opts())
        expect(await deliverBundles(tg, opts())).toBe(0)
        expect(tg.log).toHaveLength(1)
        await press(tg.log[0].keyboard[0][0].callback_data)
        expect(await deliverBundles(tg, opts())).toBe(1)
        expect(tg.log[1].text).toMatch(/Gerät gefunden/)
        // while the bundle is out, a new normal card waits
        card('Kamera einrichten?', 'iq-2')
        expect(await deliverPendingCards(tg, opts())).toBe(0)
        expect(waitingQuestionCount({ ...opts(), bundleVisible: () => true })).toBe(1)
    })

    it('plan: nothing open → nothing visible, nothing waiting', () => {
        expect(planQuestions({ cards: [], bundleVisible: () => false, now: t })).toEqual({ karten: [], buendel: [], wartend: 0, sichtbar: null })
    })
})
