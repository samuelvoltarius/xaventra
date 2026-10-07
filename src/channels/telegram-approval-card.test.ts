import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 1 Teil A: the Telegram callback for button cards. Only the owner
// (numeric id from allowFrom) can press; the button carries only a code id.

vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'
import { createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor, type ApprovalCard } from '../core/approval-cards.js'

function adapter(allowFrom: string[] = ['111'], authority = true) {
    const instance = new TelegramAdapter({ token: 'fixture', allowFrom, verifyAuthority: async () => authority })
    const bot = {
        sendMessage: vi.fn(async () => ({ message_id: 9 })),
        answerCallbackQuery: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true),
        editMessageReplyMarkup: vi.fn(async () => true),
    }
    ;(instance as any).bot = bot
    return { instance, bot }
}
const press = (userId: number, data: string) => ({
    id: `cb-${userId}`, data, from: { id: userId, username: `u${userId}` },
    message: { message_id: 9, chat: { id: userId, type: 'private' }, text: 'card' },
})

let executed: string[]
let card: ApprovalCard
const data = (answer: string) => `ac:${card.buttons.find(button => button.answer === answer)!.token}`

beforeEach(() => {
    executed = []
    unregisterCardExecutor('tg-test')
    registerCardExecutor({ isStillOpen: () => true, kind: 'tg-test', async execute(c) { executed.push(c.id); return { ok: true, message: 'erledigt' } } })
    const created = createApprovalCard({ art: 'tg-test', titel: 'Telegram-Test', beleg: 'b', vorschlag: 'v', aktion: { kind: 'tg-test', ref: 'r1' } })
    if (!created.ok) throw new Error(created.reason)
    card = created.card
})

describe('Telegram approval card callback', () => {
    it('refuses a non-owner press without touching the card', async () => {
        const { instance, bot } = adapter(['111'])
        await (instance as any).handleFeedback(press(222, data('ja')))
        expect(executed).toHaveLength(0)
        expect(String(bot.answerCallbackQuery.mock.calls[0]?.[1]?.text)).toMatch(/Owner/)
        expect(bot.editMessageText).not.toHaveBeenCalled()
        expect(listApprovalCards().find(item => item.id === card.id)?.status).toBe('offen')
    })

    it('lets the owner press once, edits the card and removes the buttons; a replay is refused', async () => {
        const { instance, bot } = adapter(['111'])
        await (instance as any).handleFeedback(press(111, data('ja')))
        expect(executed).toEqual([card.id])
        const edit = bot.editMessageText.mock.calls.at(-1)
        expect(edit?.[1]).toMatchObject({ chat_id: '111', message_id: 9, reply_markup: { inline_keyboard: [] } })
        expect(String(edit?.[0])).toMatch(/Ja/)
        await (instance as any).handleFeedback(press(111, data('ja')))
        expect(executed).toEqual([card.id])
        expect(String(bot.answerCallbackQuery.mock.calls.at(-1)?.[1]?.text)).toMatch(/bereits|verbraucht/i)
    })

    it('a node without live Main/Telegram authority ignores presses', async () => {
        const { instance } = adapter(['111'], false)
        await (instance as any).handleFeedback(press(111, data('ja')))
        expect(executed).toHaveLength(0)
    })
})
