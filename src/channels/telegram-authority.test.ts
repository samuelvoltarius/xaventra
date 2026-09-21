import { describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from './telegram.js'

function attachBot(adapter: TelegramAdapter, overrides: Record<string, any> = {}) {
    const effects = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        sendChatAction: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => undefined),
        editMessageReplyMarkup: vi.fn(async () => undefined),
        deleteMessage: vi.fn(async () => undefined),
        answerCallbackQuery: vi.fn(async () => undefined),
        sendDocument: vi.fn(async () => undefined),
        sendPhoto: vi.fn(async () => undefined),
        setMessageReaction: vi.fn(async () => undefined),
        stopPolling: vi.fn(async () => undefined),
        ...overrides,
    }
    const bot = { ...effects }
    ;(adapter as any).bot = (adapter as any).guardBotEffects(bot)
    return { bot, effects }
}

describe('Telegram authority boundary', () => {
    it('fences every Bot API effect on the predecessor and admits only the successor', async () => {
        let owner = 'node-a'
        const predecessor = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => owner === 'node-a' })
        const successor = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => owner === 'node-b' })
        const oldBot = attachBot(predecessor)
        const newBot = attachBot(successor)

        await predecessor.send({ to: 'chat', content: 'before takeover' })
        expect(oldBot.effects.sendMessage).toHaveBeenCalledTimes(1)

        owner = 'node-b'
        await expect(predecessor.send({ to: 'chat', content: 'stale reply' })).rejects.toThrow('fenced')
        await expect(oldBot.bot.sendMessage('chat', 'legacy direct reply')).rejects.toThrow('fenced')
        await expect(predecessor.sendThinking('chat')).resolves.toBeNull()
        expect(oldBot.effects.sendMessage).toHaveBeenCalledTimes(1)

        await successor.send({ to: 'chat', content: 'successor reply' })
        expect(newBot.effects.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('drops a stale inbound update before reactions or pipeline dispatch', async () => {
        let authorized = false
        const adapter = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => authorized })
        const bot = attachBot(adapter)
        const handler = vi.fn(async () => undefined)
        adapter.onMessage(handler)
        const update = { message_id: 7, date: 1, text: 'hello', chat: { id: 42, type: 'private' }, from: { id: 9 } }

        await (adapter as any).handleMessage(update)
        expect(handler).not.toHaveBeenCalled()
        expect(bot.effects.setMessageReaction).not.toHaveBeenCalled()

        authorized = true
        await (adapter as any).handleMessage(update)
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('rechecks authority between chunks and stops after takeover', async () => {
        let authorized = true
        const adapter = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => authorized })
        const sendMessage = vi.fn(async () => {
            authorized = false
            return { message_id: 1 }
        })
        attachBot(adapter, { sendMessage })

        await expect(adapter.send({ to: 'chat', content: `${'a'.repeat(3900)}\n${'b'.repeat(3900)}` })).rejects.toThrow('fenced')
        expect(sendMessage).toHaveBeenCalledTimes(1)
    })

    it('always permits disconnect cleanup after authority is lost', async () => {
        const adapter = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => false })
        const bot = attachBot(adapter)
        await adapter.disconnect()
        expect(bot.effects.stopPolling).toHaveBeenCalledWith({ cancel: true })
    })
})
