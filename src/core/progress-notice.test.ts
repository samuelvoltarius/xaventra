import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgressNotice, progressGoesToChat, PROGRESS_FIRST_AFTER_MS } from './progress-notice.js'

afterEach(() => { vi.useRealTimers() })

describe('progress notice (2.89 Paket E)', () => {
    it('chat: exactly one message after ~20 s, no matter how many steps', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const notice = createProgressNotice({ channel: 'Telegram', enabled: true, reply, now: () => Date.now() })
        for (let i = 0; i < 20; i++) notice.update(`⚙️ Schritt ${i}/20: web_search...`)
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS - 1)
        expect(reply).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(reply).toHaveBeenCalledTimes(1)
        expect(String((reply.mock.calls[0] as unknown[])[0])).toMatch(/^⏳ Ich arbeite noch daran/)
        expect(notice.sent).toBe(1)
    })

    it('a routing notice becomes the text of the one message and is kept for the run', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const notice = createProgressNotice({ channel: 'whatsapp', enabled: true, reply })
        notice.update('Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.')
        notice.update('⚙️ Schritt 2/3: read_file...')
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS)
        expect(String((reply.mock.calls[0] as unknown[])[0])).toContain('ich arbeite lokal weiter')
        expect(notice.notices).toEqual(['Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.'])
    })

    it('closed before the delay: nothing is sent', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const notice = createProgressNotice({ channel: 'telegram', enabled: true, reply })
        notice.close()
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS * 2)
        expect(reply).not.toHaveBeenCalled()
    })

    it('collecting channels never get progress through the reply; the side sink does', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const side = vi.fn()
        const notice = createProgressNotice({ channel: 'desktop', enabled: true, reply, onProgress: side })
        notice.update('⚙️ Schritt 2/3: web_search...')
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS * 3)
        expect(reply).not.toHaveBeenCalled()
        expect(side).toHaveBeenCalledWith('⚙️ Schritt 2/3: web_search...')
        for (const channel of ['dashboard', 'rest-api', 'voice', 'internal', 'mobile-mesh', 'even-g2']) expect(progressGoesToChat(channel)).toBe(false)
        for (const channel of ['Telegram', 'WhatsApp', 'Discord']) expect(progressGoesToChat(channel)).toBe(true)
    })

    it('disabled (system message, mesh contract): no timer, no side sink', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const side = vi.fn()
        const notice = createProgressNotice({ channel: 'telegram', enabled: false, reply, onProgress: side })
        notice.update('Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.')
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS * 2)
        expect(reply).not.toHaveBeenCalled()
        expect(side).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('a failed delivery is logged, not thrown into the run', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const notice = createProgressNotice({ channel: 'telegram', enabled: true, reply: async () => { throw new Error('429 Too Many Requests') } })
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS)
        expect(warn.mock.calls.flat().join(' ')).toMatch(/\[Fortschritt\] Hinweis nicht zugestellt \(telegram\): 429/)
        notice.close()
        warn.mockRestore()
    })
})
