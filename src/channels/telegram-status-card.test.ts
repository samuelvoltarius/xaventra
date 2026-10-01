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

    it('keeps the card and marks it ✅ before the final answer instead of deleting it', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true, minEditIntervalMs: 2_000 })
        await session.deliver('⚙️ Schritt 2/3: screenshot')
        vi.advanceTimersByTime(2_500)
        await session.deliver('⚙️ Schritt 3/3: antwort')
        await session.deliver('Hier ist der Screenshot.')
        await session.finishProgress(true)
        expect(a.sendProgress).toHaveBeenCalledOnce()
        expect(a.deleteMessage).not.toHaveBeenCalled()
        expect(a.editMessage).toHaveBeenLastCalledWith('chat', 42, expect.stringMatching(/^✅/))
        expect(a.send).toHaveBeenCalledOnce()
    })

    it('marks the card ❌ when the task fails', async () => {
        const a = adapter()
        const session = new TelegramPresentationSession(a, 'chat', { statusCard: true })
        await session.deliver('⚙️ Schritt 1/2: browser')
        await session.finishProgress(false)
        expect(a.editMessage).toHaveBeenLastCalledWith('chat', 42, expect.stringMatching(/^❌/))
    })
})
