import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor } from './approval-cards.js'
import { deliverPendingCards } from './approval-card-sources.js'
import { deliverBundles, requestBundleResend } from './card-bundle.js'
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
    registerCardExecutor({ isStillOpen: () => true, kind: 'install', impact: 'intern', async execute() { return { ok: true, message: 'installiert' } }, async reject() { return { ok: true, message: 'nein' } } })
    registerCardExecutor({ isStillOpen: () => true, kind: 'geraet-verbinden', impact: 'intern', async execute() { return { ok: true, message: 'verbunden' } }, async reject() { return { ok: true, message: 'nein' } } })
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

// 2.86 Zusammenstecken (N + M): die Warteschlange gilt auch für Geräte-Karten;
// eine Antwort auf das, was der Owner GERADE verlangt hat, wartet aber nicht hinter alten Fragen.
describe('direkte Antworten auf eine Owner-Bitte', () => {
    it('eine eben verlangte Vorschau kommt sofort, ein Fehler-Angebot wartet; nach 10 Minuten ist sie keine direkte Antwort mehr', async () => {
        const tg = telegram()
        card('Alte Frage', 'q-alt', { ablaufMs: 24 * HOUR })
        expect(await deliverPendingCards(tg, opts())).toBe(1)
        t += 60_000
        const vorschau = card('Jeden Tag um 23:00 schalte ich die Stehlampe aus', 'q-vorschau', { ablaufMs: 24 * HOUR, direkteAntwort: true })
        card('Nochmal versuchen, wenn es wieder an ist?', 'q-nochmal', { ablaufMs: 6 * HOUR })
        const plan = planQuestions({ cards: listApprovalCards({ ...opts(), status: 'offen' }), bundleVisible: () => false, now: t })
        expect(plan.karten).toEqual([vorschau.id])
        expect(plan.wartend).toBe(1)
        const spaet = card('Später verlangt', 'q-spaet', { ablaufMs: 24 * HOUR, direkteAntwort: true })
        t += 11 * 60_000
        expect(planQuestions({ cards: listApprovalCards({ ...opts(), status: 'offen' }), bundleVisible: () => false, now: t }).karten).not.toContain(spaet.id)
    })

    it('„Welche Geräte findest du?“: die Geräte-Nachricht kommt neu, auch wenn gerade eine andere Frage offen ist', async () => {
        const tg = telegram()
        card('Hue Bridge', 'g-hue', { art: 'geraet-verbinden', aktion: { kind: 'geraet-verbinden', ref: 'g-hue' }, buendel: 'geraete', kurz: 'Hue Bridge', gruppe: 'g-hue', ablaufMs: 24 * HOUR })
        await deliverBundles(tg, opts())
        expect(tg.log.filter(item => item.op === 'send')).toHaveLength(1)
        card('Platte kritisch voll', 'q-kritisch', { ablaufMs: 24 * HOUR, wichtigkeit: 'hoch' })
        expect(await deliverPendingCards(tg, opts())).toBe(1)
        t += 60_000
        requestBundleResend('geraete', opts())
        await deliverBundles(tg, opts())
        const sends = tg.log.filter(item => item.op === 'send')
        expect(sends).toHaveLength(3)
        expect(sends.at(-1)!.text).toContain('gefunden')
    })
})
