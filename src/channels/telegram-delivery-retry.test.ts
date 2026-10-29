import { describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from './telegram.js'
import { isTransientTransportFailure } from '../core/infrastructure-failure.js'

// Abnahme 2.90.0 (29.10.2026, 17:11:10): "ReplyDeliveryError: Reply delivery failed
// (Ursache: FatalError: EFATAL: fetch failed)" — the finished inventory answer never
// reached the owner. A network failure now gets two bounded retries (~2 s, ~6 s);
// a Telegram API answer (4xx) never does. A reply lost after that is announced once
// with the next successful message to the same chat (rather twice than never).

class FatalError extends Error {
    code = 'EFATAL'
    constructor(message: string) { super(`EFATAL: ${message}`); this.name = 'FatalError' }
}
class TelegramError extends Error {
    code = 'ETELEGRAM'
    response: { statusCode: number }
    constructor(statusCode: number, description: string) {
        super(`ETELEGRAM: ${statusCode} ${description}`)
        this.name = 'TelegramError'
        this.response = { statusCode }
    }
}

function adapterWith(sendMessage: ReturnType<typeof vi.fn>) {
    const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true })
    ;(adapter as any).bot = (adapter as any).guardBotEffects({ sendMessage, sendChatAction: vi.fn(async () => undefined) })
    ;(adapter as any).deliveryRetryDelaysMs = [0, 0]
    return adapter
}

const fetchFailed = () => new FatalError('fetch failed')

describe('Telegram reply delivery survives a network failure', () => {
    it('retries the exact live failure "FatalError: EFATAL: fetch failed" and delivers the answer', async () => {
        expect(String(fetchFailed())).toBe('FatalError: EFATAL: fetch failed')
        const sendMessage = vi.fn().mockRejectedValueOnce(fetchFailed()).mockResolvedValue({ message_id: 1 })
        const adapter = adapterWith(sendMessage)
        await adapter.send({ channel: 'telegram', to: '111', content: 'Inventur fertig' })
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[1][1]).toContain('Inventur fertig')
    })

    it('waits about 2 s and 6 s between the attempts by default', () => {
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'] })
        expect((adapter as any).deliveryRetryDelaysMs).toEqual([2000, 6000])
    })

    it('gives up after two retries and announces the lost reply once with the next message to that chat', async () => {
        const sendMessage = vi.fn()
            .mockRejectedValueOnce(fetchFailed()).mockRejectedValueOnce(fetchFailed()).mockRejectedValueOnce(fetchFailed())
            .mockResolvedValue({ message_id: 2 })
        const adapter = adapterWith(sendMessage)
        await expect(adapter.send({ channel: 'telegram', to: '111', content: 'verlorene Antwort' })).rejects.toThrow('EFATAL: fetch failed')
        expect(sendMessage).toHaveBeenCalledTimes(3)

        await adapter.send({ channel: 'telegram', to: '111', content: 'nächste Antwort' })
        const afterLoss = sendMessage.mock.calls.slice(3).map(call => String(call[1]))
        expect(afterLoss.some(text => text.includes('nächste Antwort'))).toBe(true)
        const notices = afterLoss.filter(text => /Eine Antwort von \d{2}:\d{2} konnte nicht zugestellt werden — bitte Frage wiederholen/.test(text))
        expect(notices).toHaveLength(1)

        const before = sendMessage.mock.calls.length
        await adapter.send({ channel: 'telegram', to: '111', content: 'dritte Antwort' })
        expect(sendMessage.mock.calls.slice(before).map(call => String(call[1])).some(text => text.includes('nicht zugestellt'))).toBe(false)
    })

    it('retries an approval card (sendWithButtons) on a network failure as well', async () => {
        const sendMessage = vi.fn().mockRejectedValueOnce(fetchFailed()).mockResolvedValue({ message_id: 3 })
        const adapter = adapterWith(sendMessage)
        await adapter.sendWithButtons('111', 'Freigabe?', [[{ text: 'Ja', callback_data: 'c:1' }]])
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[1][2]?.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe('Ja')
    })

    it('never retries a Telegram 400 "can\'t parse entities": only the plain-text fallback is sent', async () => {
        const sendMessage = vi.fn().mockRejectedValueOnce(new TelegramError(400, "Bad Request: can't parse entities")).mockResolvedValue({ message_id: 4 })
        const adapter = adapterWith(sendMessage)
        await adapter.send({ channel: 'telegram', to: '111', content: 'a_b' })
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[0][2]?.parse_mode).toBe('Markdown')
        expect(sendMessage.mock.calls[1][2]?.parse_mode).toBeUndefined()
    })

    it('never retries a Telegram 403 and records no lost-reply notice for it', async () => {
        const sendMessage = vi.fn().mockRejectedValueOnce(new TelegramError(403, 'Forbidden: bot was blocked by the user')).mockResolvedValue({ message_id: 5 })
        const adapter = adapterWith(sendMessage)
        await expect(adapter.send({ channel: 'telegram', to: '111', content: 'x' })).rejects.toThrow('403')
        expect(sendMessage).toHaveBeenCalledTimes(1)
        await adapter.send({ channel: 'telegram', to: '111', content: 'y' })
        expect(sendMessage.mock.calls.slice(1).map(call => String(call[1])).some(text => text.includes('nicht zugestellt'))).toBe(false)
    })
})

describe('isTransientTransportFailure (network only, never an API answer)', () => {
    it('accepts the network failures', () => {
        for (const message of ['EFATAL: fetch failed', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'getaddrinfo EAI_AGAIN api.telegram.org', 'socket hang up', 'connect ECONNREFUSED'])
            expect(isTransientTransportFailure(new Error(message)), message).toBe(true)
        expect(isTransientTransportFailure(fetchFailed())).toBe(true)
    })
    it('rejects Telegram API answers and unrelated errors', () => {
        expect(isTransientTransportFailure(new TelegramError(400, "Bad Request: can't parse entities"))).toBe(false)
        expect(isTransientTransportFailure(new TelegramError(403, 'Forbidden: bot was blocked by the user'))).toBe(false)
        expect(isTransientTransportFailure(new TelegramError(400, 'Bad Request: chat not found'))).toBe(false)
        expect(isTransientTransportFailure(new TelegramError(429, 'Too Many Requests: retry after 5'))).toBe(false)
        expect(isTransientTransportFailure(new Error('Telegram not connected'))).toBe(false)
        expect(isTransientTransportFailure(undefined)).toBe(false)
    })
})
