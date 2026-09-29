import { describe, expect, it, vi } from 'vitest'
import { stampTelegramUpdate, TelegramAdapter, telegramInboundKey } from './telegram.js'

function attachBot(adapter: TelegramAdapter) {
    const bot = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        sendChatAction: vi.fn(async () => undefined),
        setMessageReaction: vi.fn(async () => undefined),
    }
    ;(adapter as any).bot = (adapter as any).guardBotEffects(bot)
    return bot
}

describe('H10 Telegram dedup key is globally unique', () => {
    it('prefers update_id and otherwise scopes message_id by chat', () => {
        expect(telegramInboundKey({ chat: { id: 1 }, message_id: 7 })).not.toBe(telegramInboundKey({ chat: { id: 2 }, message_id: 7 }))
        expect(telegramInboundKey({ chat: { id: 1 }, message_id: 7 })).toBe('tg:1:7')
        expect(telegramInboundKey({ chat: { id: 1 }, message_id: 7 }, 123456)).toBe('tg-update:123456')
    })

    it('stamps update_id from the raw update onto the message without changing its JSON', () => {
        const update = { update_id: 99, message: { message_id: 7, chat: { id: 1 } } }
        stampTelegramUpdate(update)
        expect(telegramInboundKey(update.message)).toBe('tg-update:99')
        expect(JSON.stringify(update.message)).not.toContain('99')
    })

    it('hands distinct ids to the pipeline for equal message_ids in different chats', async () => {
        const adapter = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => true })
        attachBot(adapter)
        const ids: string[] = []
        adapter.onMessage(async (msg: any) => { ids.push(msg.id) })
        await (adapter as any).handleMessage({ message_id: 7, date: 1, text: 'a', chat: { id: 1, type: 'private' }, from: { id: 9 } })
        await (adapter as any).handleMessage({ message_id: 7, date: 1, text: 'b', chat: { id: 2, type: 'private' }, from: { id: 9 } })
        expect(ids).toHaveLength(2)
        expect(new Set(ids).size).toBe(2)
    })
})
