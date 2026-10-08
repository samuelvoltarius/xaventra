/**
 * 2.89.4 Fix 1 over the real entry (createDaemonMessageEntry → message-pipeline →
 * runNovaAgent, Telegram input, scripted model): after the answer is delivered the
 * Live-Statuskarte is deleted — "✅ Fertig · N s" stood BEFORE the reply and read
 * like an empty answer. Only the model and the Telegram transport record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 60_000

describe('2.89.4 Live-Statuskarte after the answer (real entry)', () => {
    it('deletes the progress card once the reply is delivered, never leaves "✅ Fertig" before it', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Schreib mir einen kurzen Satz über Wetter.', [
            { text: 'Heute ist es mild und bewölkt.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('mild')

        // Same wiring as daemon-channels startTelegram: progress into the card, answer out.
        const { TelegramPresentationSession } = await h.module('channels/telegram-presentation.js')
        const sent: string[] = []
        const progress: string[] = []
        const edits: string[] = []
        const deleted: number[] = []
        const adapter = {
            send: async (msg: any) => { sent.push(String(msg?.content ?? '')) },
            sendProgress: async (_chatId: string, text: string) => { progress.push(String(text)); return 42 },
            editMessage: async (_chatId: string, _id: number, text: string) => { edits.push(String(text)) },
            deleteMessage: async (_chatId: string, messageId: number) => { deleted.push(messageId) },
        }
        const session = new TelegramPresentationSession(adapter, OWNER_TELEGRAM_ID, { statusCard: true, minEditIntervalMs: 0 })
        await session.deliver('⚙️ Schritt 1/2: mesh_status')
        await session.deliver(result.final)
        await session.clearProgress()
        expect(progress.length).toBeGreaterThan(0)
        expect(sent).toEqual([result.final])
        expect(deleted).toEqual([42])
        expect(edits.some(text => /^✅/.test(text))).toBe(false)
    }, T)
})
