import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveStatusCard, listActiveStatusCards } from './telegram-status-card.js'
import { TelegramPresentationSession } from './telegram-presentation.js'

// Phase 1 Teil A: one Telegram message per task, edited in place
// (⏳ Schritt n/m … → ✅/❌), throttled, and never broken by a failing edit.

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-01T10:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const transport = () => ({
    send: vi.fn(async (_text: string) => 42 as number | null),
    edit: vi.fn(async (_id: number, _text: string) => undefined),
    delete: undefined as undefined | ((messageId: number) => Promise<void>),
})

describe('LiveStatusCard', () => {
    it('sends one message, throttles edits to one per 2 s and always edits that message', async () => {
        const t = transport()
        const card = new LiveStatusCard(t, { minIntervalMs: 2_000 })
        await card.update('⚙️ Schritt 1/4: browser')
        await card.update('⚙️ Schritt 2/4: screenshot')
        vi.advanceTimersByTime(500)
        await card.update('⚙️ Schritt 3/4: analyse')
        expect(t.send).toHaveBeenCalledOnce()
        expect(t.edit).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1_600)
        expect(t.edit).toHaveBeenCalledOnce()
        expect(t.edit).toHaveBeenLastCalledWith(42, expect.stringContaining('Schritt 3/4'))
        await card.update('⚙️ Schritt 4/4: antwort')
        expect(t.edit).toHaveBeenCalledOnce()
        await card.finish(true)
        expect(t.send).toHaveBeenCalledOnce()
        expect(t.edit).toHaveBeenCalledTimes(2)
        expect(t.edit).toHaveBeenLastCalledWith(42, expect.stringMatching(/^✅/))
        for (const call of t.edit.mock.calls) expect(call[0]).toBe(42)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(t.edit).toHaveBeenCalledTimes(2)
    })

    it('a failing edit never throws and never stops the card', async () => {
        const t = transport()
        t.edit.mockRejectedValue(new Error('Bad Request: message to edit not found'))
        const card = new LiveStatusCard(t, { minIntervalMs: 2_000 })
        await card.update('⚙️ Schritt 1/2: a')
        vi.advanceTimersByTime(2_100)
        await expect(card.update('⚙️ Schritt 2/2: b')).resolves.toBeUndefined()
        await expect(card.finish(false, 'Werkzeug fehlgeschlagen')).resolves.toBeUndefined()
        expect(t.edit).toHaveBeenLastCalledWith(42, expect.stringMatching(/^❌/))
    })

    it('a failing first send leaves the task untouched and sends no flood', async () => {
        const t = transport()
        t.send.mockRejectedValue(new Error('network'))
        const card = new LiveStatusCard(t, { minIntervalMs: 2_000 })
        await expect(card.update('⏳ a')).resolves.toBeUndefined()
        vi.advanceTimersByTime(5_000)
        await card.update('⏳ b')
        await card.finish(true)
        expect(t.send).toHaveBeenCalledOnce()
        expect(t.edit).not.toHaveBeenCalled()
    })

    it('is listed as active while running and removed when finished', async () => {
        const card = new LiveStatusCard(transport(), { minIntervalMs: 2_000, chatId: 'c1' })
        await card.update('⚙️ Schritt 1/2: browser')
        expect(listActiveStatusCards().some(item => item.chatId === 'c1' && /browser/.test(item.text))).toBe(true)
        await card.finish(true)
        expect(listActiveStatusCards().some(item => item.chatId === 'c1')).toBe(false)
    })
})

describe('TelegramPresentationSession in status-card mode', () => {
    const adapter = () => ({
        send: vi.fn(async () => undefined),
        sendProgress: vi.fn(async () => 42),
        editMessage: vi.fn(async () => undefined),
        deleteMessage: vi.fn(async () => undefined),
    })

    it('removes the card after the answer so "✅ Fertig" never stands before the reply (2.89.4)', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true, minEditIntervalMs: 2_000 })
        await session.deliver('⚙️ Schritt 2/3: screenshot')
        vi.advanceTimersByTime(2_500)
        await session.deliver('⚙️ Schritt 3/3: antwort')
        await session.deliver('Hier ist der Screenshot.')
        await session.finishProgress(true)
        expect(a.sendProgress).toHaveBeenCalledOnce()
        expect(a.deleteMessage).toHaveBeenCalledWith('chat', 42)
        // The ✅ line is not written before the answer — the card is gone.
        expect(a.editMessage).not.toHaveBeenCalledWith('chat', 42, expect.stringMatching(/^✅/))
        expect(a.send).toHaveBeenCalledOnce()
        expect(a.deleteMessage.mock.invocationCallOrder.at(-1)).toBeGreaterThan(a.send.mock.invocationCallOrder[0])
    })

    it('keeps a short ✅ line only when deleteMessage fails (2.89.4 fallback)', async () => {
        const a = adapter()
        a.deleteMessage.mockRejectedValue(new Error('message to delete not found'))
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true, minEditIntervalMs: 2_000 })
        await session.deliver('⚙️ Schritt 1/1: antwort')
        vi.advanceTimersByTime(2_500)
        await session.deliver('Alles erledigt.')
        expect(a.deleteMessage).toHaveBeenCalledWith('chat', 42)
        expect(a.editMessage).toHaveBeenLastCalledWith('chat', 42, expect.stringMatching(/^✅ Fertig · \d+ s$/))
    })

    it('never labels cleanup after progress-only output as answer delivery', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true })
        await session.deliver('⏳ Werkzeuge laufen')
        await session.clearProgress()
        expect(a.send).not.toHaveBeenCalled()
        expect(a.editMessage).toHaveBeenLastCalledWith('chat', 42, expect.stringMatching(/^❌/))
        expect(a.deleteMessage).not.toHaveBeenCalled()
    })

    // 2.89.4 (live): "❌ Abgebrochen · 6 s" without a reason.
    it('an abort always carries one honest sentence', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true })
        await session.deliver('⚙️ Schritt 1/2: browser')
        await session.finishProgress(false)
        const text = String(a.editMessage.mock.calls.at(-1)?.[2])
        expect(text).toMatch(/^❌ Abgebrochen · \d+ s\n\S/)
    })

    it('does not claim success if final delivery fails and measures from request creation', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true })
        vi.advanceTimersByTime(25_000)
        await session.deliver('⏳ Ich arbeite noch (25s): LLM/Tools laufen')
        vi.advanceTimersByTime(5_000)
        a.send.mockRejectedValueOnce(new Error('delivery failed'))
        await expect(session.deliver('Antwort')).rejects.toThrow('delivery failed')
        const text = String(a.editMessage.mock.calls.at(-1)?.[2])
        expect(text).toMatch(/^❌ Abgebrochen · 30 s/)
        expect(text).toContain('delivery failed')
    })

    it('marks the card ❌ when the task fails', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true })
        await session.deliver('⚙️ Schritt 1/2: browser')
        await session.finishProgress(false)
        expect(a.editMessage).toHaveBeenLastCalledWith('chat', 42, expect.stringMatching(/^❌/))
    })
})

describe('LiveStatusCard closing line (2.89.3)', () => {
    it('is short, has no internal counters and says "Fertig" / "Abgebrochen"', async () => {
        const ok = transport()
        const done = new LiveStatusCard(ok)
        await done.update('⏳ Ich arbeite noch daran (20 s) …')
        vi.advanceTimersByTime(167_000)
        await done.finish(true)
        expect(ok.edit).toHaveBeenLastCalledWith(42, '✅ Fertig · 167 s')
        const bad = transport()
        const failed = new LiveStatusCard(bad)
        await failed.update('⏳ Ich arbeite noch daran (20 s) …')
        await failed.update('⚙️ Schritt 1/3: x')
        await failed.finish(false)
        const text = String(bad.edit.mock.calls.at(-1)?.[1])
        expect(text).toMatch(/^❌ Abgebrochen · \d+ s$/)
        expect(text).not.toMatch(/Statusmeldung|Schritte/)
    })
})

describe('LiveStatusCard.dismiss (2.89.4)', () => {
    it('deletes the card message after the answer arrived', async () => {
        const t = transport()
        t.delete = vi.fn(async (_id: number) => undefined) as any
        const card = new LiveStatusCard(t)
        await card.update('⚙️ Schritt 1/2: a')
        await expect(card.dismiss()).resolves.toBe('deleted')
        expect(t.delete).toHaveBeenCalledWith(42)
        expect(card.isFinished).toBe(true)
        expect(listActiveStatusCards().length).toBe(0)
    })

    it('falls back to one ✅ line when delete is missing or fails', async () => {
        const missing = transport()
        const withoutDelete = new LiveStatusCard(missing)
        await withoutDelete.update('⏳ a')
        await expect(withoutDelete.dismiss()).resolves.toBe('kept')
        expect(missing.edit).toHaveBeenLastCalledWith(42, expect.stringMatching(/^✅ Fertig · \d+ s$/))

        const failing = transport()
        failing.delete = vi.fn(async () => { throw new Error('message to delete not found') }) as any
        const card = new LiveStatusCard(failing)
        await card.update('⏳ a')
        await expect(card.dismiss()).resolves.toBe('kept')
        expect(failing.edit).toHaveBeenLastCalledWith(42, expect.stringMatching(/^✅ Fertig · \d+ s$/))
    })
})
