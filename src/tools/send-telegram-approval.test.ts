import { beforeEach, describe, expect, it, vi } from 'vitest'

// Sending to someone other than the owner is "nach außen senden": the model
// may only do it with the owner's approval. Messages to the owner stay free.
const refusal = vi.fn()
const sendMessage = vi.fn(async () => ({ message_id: 7 }))
vi.mock('./owner-approval.js', () => ({ ownerApprovalRefusal: (...args: unknown[]) => refusal(...args) }))
vi.mock('../channels/telegram.js', () => ({ getTelegramAdapter: () => ({ bot: { sendMessage } }) }))
vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getConfigAllowFrom: () => ['1000001'],
}))

const tool = async () => (await import('./complete-registry.js')).ALL_TOOLS.find(item => item.name === 'send_telegram_message')!

describe('send_telegram_message: fremde Empfänger nur mit Owner-Freigabe', () => {
    beforeEach(() => { refusal.mockReset(); sendMessage.mockClear() })

    it('an fremde Chat-ID ohne Freigabe: nichts gesendet', async () => {
        refusal.mockResolvedValue('❌ braucht Freigabe')
        const result: any = await (await tool()).handler({ to: '2000002', message: 'Hallo' })
        expect(sendMessage).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).toContain('Freigabe')
        expect(refusal).toHaveBeenCalledWith(expect.any(Object), 'send_telegram_message', '2000002')
    })

    it('an fremde Chat-ID mit Freigabe: gesendet', async () => {
        refusal.mockResolvedValue(null)
        await (await tool()).handler({ to: '2000002', message: 'Hallo' })
        expect(sendMessage).toHaveBeenCalledWith('2000002', 'Hallo')
    })

    it('an den Owner selbst: ohne Freigabe gesendet', async () => {
        await (await tool()).handler({ to: '1000001', message: 'Status' })
        expect(refusal).not.toHaveBeenCalled()
        expect(sendMessage).toHaveBeenCalledWith('1000001', 'Status')
    })
})
