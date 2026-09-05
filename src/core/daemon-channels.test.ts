import { describe, expect, it, vi } from 'vitest'
import { verifyTelegramAuthority } from './daemon-channels.js'

describe('Telegram fencing authority', () => {
    it('requires both Main and Telegram live leases', async () => {
        const verify = vi.fn(async (service: string) => service === 'nova-main')
        await expect(verifyTelegramAuthority(verify)).resolves.toBe(false)
        expect(verify).toHaveBeenCalledWith('nova-main')
        expect(verify).toHaveBeenCalledWith('telegram')
    })

    it('fails closed before checking Telegram when Main is invalid', async () => {
        const verify = vi.fn(async () => false)
        await expect(verifyTelegramAuthority(verify)).resolves.toBe(false)
        expect(verify).toHaveBeenCalledTimes(1)
    })
})
