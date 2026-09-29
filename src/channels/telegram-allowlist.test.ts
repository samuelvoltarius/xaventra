import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from './telegram.js'

function adapterWith(allowFrom: string[]) {
    const adapter = new TelegramAdapter({ token: 'fixture', allowFrom, verifyAuthority: async () => true })
    ;(adapter as any).bot = (adapter as any).guardBotEffects({
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        sendChatAction: vi.fn(async () => undefined),
        setMessageReaction: vi.fn(async () => undefined),
    })
    const handler = vi.fn(async () => undefined)
    adapter.onMessage(handler)
    return { adapter, handler }
}

const dm = (userId: number, username?: string) => ({
    message_id: userId, date: 1, text: 'hi', chat: { id: userId, type: 'private' }, from: { id: userId, username },
})

afterEach(() => vi.restoreAllMocks())

describe('Telegram allowlist matches immutable user ids only', () => {
    it('does not admit a user whose mutable username equals a bare allowlist entry', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { adapter, handler } = adapterWith(['12345', 'alfred'])
        await (adapter as any).handleMessage(dm(999, 'alfred'))
        expect(handler).not.toHaveBeenCalled()
        await (adapter as any).handleMessage(dm(12345, 'someone-else'))
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('never admits anyone through an empty entry (TELEGRAM_ALLOW_FROM="" or trailing comma)', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        for (const allowFrom of [[''], ['', ' '], ['12345', '']]) {
            const { adapter, handler } = adapterWith(allowFrom)
            await (adapter as any).handleMessage(dm(999, ''))
            expect(handler, JSON.stringify(allowFrom)).not.toHaveBeenCalled()
        }
    })

    it('matches a username only for entries explicitly marked with @ and warns about it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { adapter, handler } = adapterWith(['@alfred'])
        expect(warn.mock.calls.some(call => String(call[0]).includes('@alfred'))).toBe(true)
        await (adapter as any).handleMessage(dm(999, 'alfred'))
        expect(handler).toHaveBeenCalledTimes(1)
        await (adapter as any).handleMessage(dm(1000, 'alfredo'))
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
