import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { buildBriefing } from '../planner/briefing.js'
import { createThoughtStore, deliverPendingThoughts } from '../planner/thoughts.js'
import { createPlannerTelegramPort } from '../core/planner-card-bridge.js'
import { TelegramAdapter } from '../channels/telegram.js'

// 2.86 Paket M Übersichtlichkeit + Telegram-Anbindung: sofort nur Fragen/Kritisches, Rest in den
// Tagesbericht; der Bericht nennt die wartenden Fragen; Systemnachrichten mit Ampel-Kopf; Menü mit
// „Einrichtung“ und „Ich komm nicht weiter“; ein Beispielsatz-Knopf läuft als normale Anfrage.

let dir: string
let t: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-int-')); t = Date.parse('2026-10-06T08:00:00.000Z') /* 10:00 Wien */ })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function port() {
    const sent: any[] = []
    return { sent, port: { name: 'test', deliver: async (msg: any) => { sent.push(msg); return { status: 'zugestellt' as const } } } }
}

describe('Bündeln: sofort nur Fragen und Kritisches', () => {
    it('plain information waits for the report while it is on; critical wording and questions go at once', async () => {
        const store = createThoughtStore({ dataDir: dir, now: () => t })
        const info = store.add({ source: 'nachtwache', title: 'Backup 26 h alt', severity: 'warning' }).thought
        const critical = store.add({ source: 'nachtwache', title: 'Platte kritisch voll', severity: 'warning' }).thought
        const question = store.add({ source: 'nachtwache', kind: 'vorschlag', title: 'Alte Protokolle aufräumen?', severity: 'warning' }).thought
        const { port: p, sent } = port()
        const result = await deliverPendingThoughts(store, p, { briefingEnabled: true })
        expect(sent.map(msg => msg.thoughtId).sort()).toEqual([critical.id, question.id].sort())
        expect(result.held).toBe(1)
        expect(store.get(info.id)).toMatchObject({ notice: 'zurueckgehalten', noticeReason: 'tagesbericht' })
        // nothing lost: the report lists it (without a technical reason)
        const briefing = buildBriefing('abend', { dataDir: dir, thoughts: store, runsFile: join(dir, 'runs.jsonl'), timeZone: 'Europe/Vienna' }, t - 3_600_000, t + 1)
        expect(briefing.sections.find(section => section.titel === 'Zurückgehalten')?.zeilen).toEqual(['Backup 26 h alt'])
    })

    it('without a report everything goes out as before', async () => {
        const store = createThoughtStore({ dataDir: dir, now: () => t })
        store.add({ source: 'nachtwache', title: 'Backup 26 h alt', severity: 'warning' })
        const { port: p, sent } = port()
        await deliverPendingThoughts(store, p, { briefingEnabled: false })
        expect(sent).toHaveLength(1)
    })
})

describe('Bericht: wartende Fragen als Zahl', () => {
    it('lists how many questions wait behind the visible one', () => {
        const store = createThoughtStore({ dataDir: dir, now: () => t })
        const briefing = buildBriefing('morgen', { dataDir: dir, thoughts: store, runsFile: join(dir, 'runs.jsonl'), timeZone: 'Europe/Vienna', cards: { bundled: () => [], release: () => 0, waiting: () => 3 } } as any, t - 3_600_000, t)
        expect(briefing.sections.find(section => section.titel === 'Fragen in der Warteschlange')?.zeilen).toEqual(['3 Fragen warten – sie kommen einzeln, die wichtigste zuerst.'])
        expect(briefing.kopf).toBe('🟡 Alles läuft — 3 Fragen warten')
    })
})

describe('Systemnachricht: Ampel + ein Satz', () => {
    it('a plain thought message starts with the traffic light head', async () => {
        const tg = { hasCardAuthority: vi.fn(async () => true), getOwnerChatIds: vi.fn(() => ['111']), sendApprovalCard: vi.fn(async () => 42) }
        await createPlannerTelegramPort(tg).deliver({ id: 'out-0000000000aa', kind: 'gedanke', title: 'Platte kritisch voll', text: 'Platte kritisch voll\nBeleg: 96 %', urgency: 'dringend', createdAt: new Date(t).toISOString() } as any)
        const [, text] = tg.sendApprovalCard.mock.calls[0] as unknown as [string, string]
        expect(text.split('\n')[0]).toBe('🔴 Das braucht dich jetzt.')
        await createPlannerTelegramPort(tg).deliver({ id: 'out-0000000000ab', kind: 'erinnerung', title: 'Müll rausbringen', text: 'Müll rausbringen', urgency: 'normal', createdAt: new Date(t).toISOString() } as any)
        expect((tg.sendApprovalCard.mock.calls[1] as unknown as [string, string])[1]).toBe('Müll rausbringen')
    })
})

describe('Telegram-Menü und geführte Knöpfe', () => {
    function adapter() {
        const instance = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true })
        let id = 70
        const bot = {
            sendMessage: vi.fn(async () => ({ message_id: ++id })), answerCallbackQuery: vi.fn(async () => true), editMessageText: vi.fn(async () => true),
            editMessageReplyMarkup: vi.fn(async () => true), sendChatAction: vi.fn(async () => true), pinChatMessage: vi.fn(async () => true),
        }
        ;(instance as any).bot = bot
        return { instance, bot }
    }
    const press = (userId: number, data: string) => ({ id: `cb-${userId}`, data, from: { id: userId }, message: { message_id: 71, chat: { id: userId, type: 'private' }, text: 'x' } })

    it('/menu has the second row „Einrichtung“ · „Ich komm nicht weiter“', async () => {
        const { instance, bot } = adapter()
        await (instance as any).handleMessage({ message_id: 7, date: 1, text: '/menu', chat: { id: 111, type: 'private' }, from: { id: 111, username: 'owner' } })
        const keyboard = (bot.sendMessage.mock.calls[0] as any[])[2].reply_markup.inline_keyboard
        expect(keyboard.at(-1).map((b: any) => b.text)).toEqual(['🧭 Einrichtung', '🆘 Ich komm nicht weiter'])
        expect(keyboard.at(-1).every((b: any) => /^gf:[a-f0-9]{16}$/.test(b.callback_data))).toBe(true)
    })

    it('/menu shows ONE question and how many wait after it (owner 06.10.: not „6 Fragen warten“)', async () => {
        const { createApprovalCard, listApprovalCards } = await import('../core/approval-cards.js')
        const before = listApprovalCards({ status: 'offen' }).length
        for (let i = 0; i < 6; i++) createApprovalCard({ art: 'install', titel: `Frage ${i + 1}?`, beleg: 'b', vorschlag: 'v', aktion: { kind: 'install', ref: `iq-menu-${i}` } } as any)
        const total = before + 6
        const { instance, bot } = adapter()
        await (instance as any).handleMessage({ message_id: 8, date: 1, text: '/menu', chat: { id: 111, type: 'private' }, from: { id: 111, username: 'owner' } })
        const [, text, options] = bot.sendMessage.mock.calls[0] as any[]
        expect(text.split('\n')[0]).toBe(`🟡 Alles läuft — 1 Frage für dich, ${total - 1} danach`)
        expect(options.reply_markup.inline_keyboard[0][1].text).toBe('Braucht mich (1)')
    })

    it('an example-sentence button runs as a normal owner request; a stranger cannot press it', async () => {
        const { guidedButton } = await import('./telegram-guided.js')
        const { instance } = adapter()
        const handled: any[] = []
        instance.onMessage(async (msg: any) => { handled.push(msg) })
        const button = guidedButton('111', 'Welche Lichter sind gerade an?', { art: 'satz', text: 'Welche Lichter sind gerade an?' })
        await (instance as any).handleFeedback(press(222, button.callback_data))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(handled).toHaveLength(0)
        await (instance as any).handleFeedback(press(111, button.callback_data))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(handled).toHaveLength(1)
        expect(handled[0]).toMatchObject({ channel: 'telegram', from: '111', to: '111', content: 'Welche Lichter sind gerade an?', isGroup: false })
    })
})
