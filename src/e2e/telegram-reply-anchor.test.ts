/**
 * 2.89.4 Fix 2 over the real entry (createDaemonMessageEntry → message-pipeline →
 * runNovaAgent, Telegram input, scripted model) and the real TelegramAdapter send
 * path: when the user already sent a newer message while one was still running,
 * the answer is a reply to the triggering message (reply_to_message_id) — otherwise
 * queued answers look shifted onto the newest input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 60_000

function raw(messageId: number, text: string) {
    return { message_id: messageId, date: 1, text, chat: { id: Number(OWNER_TELEGRAM_ID), type: 'private' }, from: { id: Number(OWNER_TELEGRAM_ID), username: 'owner' } }
}

describe('2.89.4 Telegram reply anchor (real entry)', () => {
    it('answers an older queued message as a reply once a newer one has arrived', async () => {
        h = await createE2EHarness()
        const { TelegramAdapter } = await h.module('channels/telegram.js')
        const sendMessage = vi.fn(async () => ({ message_id: 900 }))
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: [OWNER_TELEGRAM_ID], verifyAuthority: async () => true } as any)
        ;(adapter as any).bot = { sendMessage, sendChatAction: async () => undefined, setMessageReaction: async () => undefined }
        adapter.onMessage(async (incoming: any) => {
            const script = incoming.content === 'erste Frage'
                ? [{ delayMs: 120, then: { text: 'Antwort zur ersten Frage.' } }]
                : [{ text: 'Antwort zur zweiten Frage.' }]
            h!.model.load(incoming.content, script as any)
            await h!.entry('Telegram', incoming.from, incoming.content, async (text: string) => {
                await adapter.send({ channel: 'telegram', to: String(incoming.to || incoming.from), content: String(text) })
            }, undefined, undefined, { chatId: String(incoming.to || incoming.from) })
        })
        void (adapter as any).onRawMessage(raw(11, 'erste Frage'))
        // The second message arrives while the first is still running.
        await new Promise(resolve => setTimeout(resolve, 30))
        void (adapter as any).onRawMessage(raw(12, 'zweite Frage'))
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 15_000 })
        const first = sendMessage.mock.calls[0] as any[]
        const second = sendMessage.mock.calls[1] as any[]
        expect(String(first[1])).toContain('ersten Frage')
        expect(first[2]?.reply_to_message_id).toBe(11)
        expect(String(second[1])).toContain('zweiten Frage')
        expect(second[2]?.reply_to_message_id).toBeUndefined()
    }, T)
})
