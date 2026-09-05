import { describe, expect, it, vi } from 'vitest'
import { mayRetryTelegramPolling, telegramConflictRetryDelay } from './telegram-polling-guard.js'

describe('Telegram polling authority guard', () => {
    it('allows a retry only for the live Telegram lease holder', async () => {
        const verify = vi.fn().mockResolvedValue(true)
        await expect(mayRetryTelegramPolling(verify)).resolves.toBe(true)
        expect(verify).toHaveBeenCalledWith('telegram')
    })

    it('fences a stale poller and fails closed when verification errors', async () => {
        await expect(mayRetryTelegramPolling(vi.fn().mockResolvedValue(false))).resolves.toBe(false)
        await expect(mayRetryTelegramPolling(vi.fn().mockRejectedValue(new Error('coordinator offline')))).resolves.toBe(false)
    })

    it('uses a bounded retry jitter', () => {
        expect(telegramConflictRetryDelay(() => 0)).toBe(30_000)
        expect(telegramConflictRetryDelay(() => 1)).toBe(35_000)
        expect(telegramConflictRetryDelay(() => 5)).toBe(35_000)
    })
})
