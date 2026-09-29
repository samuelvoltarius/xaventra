import { describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from './telegram.js'

function attachBot(adapter: TelegramAdapter) {
    const effects = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        sendChatAction: vi.fn(async () => undefined),
        setMessageReaction: vi.fn(async () => undefined),
    }
    ;(adapter as any).bot = (adapter as any).guardBotEffects({ ...effects })
    return effects
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

describe('H12 Telegram persists inbound updates before the authority check', () => {
    it('persists synchronously in the update listener, before any authority round-trip', async () => {
        const persisted: any[] = []
        const verifyAuthority = vi.fn(async () => false)
        const adapter = new TelegramAdapter({ token: 'fixture', verifyAuthority, persistInbound: entry => { persisted.push(entry) } })
        attachBot(adapter)
        adapter.onMessage(async () => undefined)
        ;(adapter as any).onRawMessage({ message_id: 5, date: 1, text: 'hello', chat: { id: 100, type: 'private' }, from: { id: 9 } })
        // Synchronous: the library advances the poll offset right after the emit returns.
        expect(persisted).toEqual([{ id: 'tg:100:5', chatId: '100', from: '9', content: 'hello' }])
        expect(verifyAuthority).not.toHaveBeenCalled()
        await flush()
    })

    it('hands a persisted update to the durable consumer even without live authority, without Bot API effects', async () => {
        const adapter = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => false, persistInbound: () => undefined })
        const bot = attachBot(adapter)
        const handler = vi.fn(async () => undefined)
        adapter.onMessage(handler)
        ;(adapter as any).onRawMessage({ message_id: 6, date: 1, text: 'defer me', chat: { id: 100, type: 'private' }, from: { id: 9 } })
        await flush()
        expect(handler).toHaveBeenCalledTimes(1)
        expect(bot.setMessageReaction).not.toHaveBeenCalled()
        expect(bot.sendChatAction).not.toHaveBeenCalled()
    })

    it('does not persist updates that the allowlist rejects', async () => {
        const persisted: any[] = []
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['1'], verifyAuthority: async () => true, persistInbound: entry => { persisted.push(entry) } })
        attachBot(adapter)
        const handler = vi.fn(async () => undefined)
        adapter.onMessage(handler)
        ;(adapter as any).onRawMessage({ message_id: 7, date: 1, text: 'intruder', chat: { id: 555, type: 'private' }, from: { id: 555 } })
        await flush()
        expect(persisted).toEqual([])
        expect(handler).not.toHaveBeenCalled()
    })
})
