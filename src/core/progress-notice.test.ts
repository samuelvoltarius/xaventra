import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgressNotice, progressGoesToChat, PROGRESS_FIRST_AFTER_MS, PROGRESS_SECOND_AFTER_MS } from './progress-notice.js'

afterEach(() => { vi.useRealTimers() })

describe('progress notice (2.89 Paket E)', () => {
    it('chat: one message after ~20 s and one more after ~90 s, no matter how many steps', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const notice = createProgressNotice({ channel: 'Telegram', enabled: true, reply, now: () => Date.now() })
        for (let i = 0; i < 20; i++) notice.update(`⚙️ Schritt ${i}/20: web_search...`)
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS - 1)
        expect(reply).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(reply).toHaveBeenCalledTimes(2)
        expect(String((reply.mock.calls[0] as unknown[])[0])).toMatch(/^⏳ Ich arbeite noch daran/)
        expect(notice.sent).toBe(2)
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

describe('side-channel heartbeat (2.89)', () => {
    it('repeats the latest status about every 10 s on non-chat channels, falls back to „arbeite noch …“, stops on close()', async () => {
        vi.useFakeTimers()
        const seen: string[] = []
        const notice = createProgressNotice({ channel: 'desktop', enabled: true, reply: async () => undefined, onProgress: s => seen.push(s) })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(seen).toEqual(['arbeite noch …'])
        notice.update('suche im Web …')
        await vi.advanceTimersByTimeAsync(30_000)
        expect(seen).toEqual(['arbeite noch …', 'suche im Web …', 'suche im Web …', 'suche im Web …', 'suche im Web …'])
        notice.close()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(seen).toHaveLength(5)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('chat channels get no heartbeat, plain tool labels are not kept as notices', async () => {
        vi.useFakeTimers()
        const seen: string[] = []
        const reply = vi.fn(async () => undefined)
        const notice = createProgressNotice({ channel: 'telegram', enabled: true, reply, onProgress: s => seen.push(s) })
        notice.update('suche im Web …')
        await vi.advanceTimersByTimeAsync(15_000)
        expect(seen).toEqual([])
        expect(notice.notices).toEqual([])
        notice.close()
    })
})

describe('progress notice 2.89.3: second lifesign', () => {
    it('the second message comes at ~90 s in plain words, never a third', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async (_text: string) => undefined)
        const notice = createProgressNotice({ channel: 'Telegram', enabled: true, reply, now: () => Date.now(), activity: 'ich werte gerade das Bild aus …' })
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS)
        expect(reply).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(PROGRESS_SECOND_AFTER_MS - PROGRESS_FIRST_AFTER_MS - 1)
        expect(reply).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(reply).toHaveBeenCalledTimes(2)
        expect(reply.mock.calls[1][0]).toMatch(/^⏳ Das dauert länger \(90 s\) — ich werte gerade das Bild aus …$/)
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(reply).toHaveBeenCalledTimes(2)
        expect(notice.sent).toBe(2)
    })

    it('an answer before 90 s cancels the second message', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        const notice = createProgressNotice({ channel: 'telegram', enabled: true, reply })
        await vi.advanceTimersByTimeAsync(PROGRESS_FIRST_AFTER_MS)
        notice.close()
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(reply).toHaveBeenCalledTimes(1)
    })

    it('collecting channels get no second message either', async () => {
        vi.useFakeTimers()
        const reply = vi.fn(async () => undefined)
        createProgressNotice({ channel: 'desktop', enabled: true, reply })
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(reply).not.toHaveBeenCalled()
    })
})
