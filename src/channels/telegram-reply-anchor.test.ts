import { describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from './telegram.js'

// 2.89.4 Fix 2: when several messages are queued, the answer to N arrived after
// the user already sent N+1 and looked shifted onto the newest input. The answer
// is now sent as a reply to the triggering message (reply_to_message_id); when
// nothing newer arrived it is sent normally.

function attachBot(adapter: TelegramAdapter) {
    let id = 100
    // guardBotEffects wraps the methods — keep the spies ourselves.
    const sendMessage = vi.fn(async () => ({ message_id: ++id }))
    const bot = {
        sendMessage,
        sendChatAction: vi.fn(async () => undefined),
        setMessageReaction: vi.fn(async () => undefined),
    }
    ;(adapter as any).bot = (adapter as any).guardBotEffects(bot)
    return { ...bot, sendMessage }
}

function raw(messageId: number, text: string, chatId = 111) {
    return { message_id: messageId, date: 1, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, username: 'owner' } }
}

describe('2.89.4 Telegram reply anchor (queued answers)', () => {
    it('replies to the triggering message when a newer user message already arrived', async () => {
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true })
        const send = attachBot(adapter)
        let release!: () => void
        const firstRunning = new Promise<void>(resolve => { release = resolve })
        adapter.onMessage(async (msg: any) => {
            if (msg.content === 'erste') {
                await firstRunning
                await adapter.send({ channel: 'telegram', to: '111', content: 'Antwort zur ersten' })
            } else {
                await adapter.send({ channel: 'telegram', to: '111', content: 'Antwort zur zweiten' })
            }
        })
        // Arrival order (onRawMessage) is what the user sees in the chat.
        void (adapter as any).onRawMessage(raw(1, 'erste'))
        void (adapter as any).onRawMessage(raw(2, 'zweite'))
        // Let the first answer run while message 2 is already in the chat.
        release()
        await vi.waitFor(() => expect(send.sendMessage).toHaveBeenCalledTimes(2))
        const first = send.sendMessage.mock.calls[0] as any[]
        const second = send.sendMessage.mock.calls[1] as any[]
        expect(first[2]?.reply_to_message_id).toBe(1)
        expect(second[2]?.reply_to_message_id).toBeUndefined()
    })

    it('sends normally when the user has not moved on', async () => {
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true })
        const send = attachBot(adapter)
        adapter.onMessage(async (msg: any) => {
            await adapter.send({ channel: 'telegram', to: '111', content: `ok:${msg.content}` })
        })
        await (adapter as any).onRawMessage(raw(7, 'nur eine'))
        await vi.waitFor(() => expect(send.sendMessage).toHaveBeenCalled())
        expect((send.sendMessage.mock.calls[0] as any[])[2]?.reply_to_message_id).toBeUndefined()
    })

    it('keeps an explicit replyTo and anchors button replies the same way', async () => {
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true })
        const send = attachBot(adapter)
        let release!: () => void
        const running = new Promise<void>(resolve => { release = resolve })
        adapter.onMessage(async (msg: any) => {
            if (msg.content === 'erste') {
                await running
                await adapter.send({ channel: 'telegram', to: '111', content: 'explizit', replyTo: '99' })
                await adapter.sendWithButtons('111', 'mit Knöpfen', [[{ text: 'Ja', callback_data: 'x' }]])
            } else {
                await adapter.send({ channel: 'telegram', to: '111', content: 'zweite fertig' })
            }
        })
        void (adapter as any).onRawMessage(raw(1, 'erste'))
        void (adapter as any).onRawMessage(raw(2, 'zweite'))
        release()
        await vi.waitFor(() => expect(send.sendMessage).toHaveBeenCalledTimes(3))
        // Explicit replyTo wins on the first send; the button reply of the same
        // older turn is anchored to message 1; the newest message sends normally.
        expect((send.sendMessage.mock.calls[0] as any[])[2]?.reply_to_message_id).toBe(99)
        expect((send.sendMessage.mock.calls[1] as any[])[2]?.reply_to_message_id).toBe(1)
        expect((send.sendMessage.mock.calls[2] as any[])[2]?.reply_to_message_id).toBeUndefined()
    })
})
