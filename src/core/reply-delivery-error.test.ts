import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { deliveryFailureText, protectReplyDelivery, ReplyDeliveryError } from './reply-delivery-error.js'

describe('reply delivery is not an inference failure', () => {
    it('retains the transport cause and does not resend an ambiguous delivery', async () => {
        const cause = new Error('EFATAL: fetch failed')
        const send = vi.fn().mockRejectedValue(cause)
        await expect(protectReplyDelivery(send)('verified results')).rejects.toMatchObject({ name: 'ReplyDeliveryError', cause })
        expect(send).toHaveBeenCalledTimes(1)
    })
    it('propagates the delivery failure before any pipeline model fallback', () => {
        const source = readFileSync(new URL('./message-pipeline.ts', import.meta.url), 'utf8')
        expect(source).toContain('replyFn = protectReplyDelivery(replyFn)')
        const handler = source.slice(source.indexOf('console.error(`[Nova] [${channel}] Fehler:'))
        expect(handler.indexOf('if (err instanceof ReplyDeliveryError) throw err')).toBeLessThan(handler.indexOf('state.llm.complete'))
        expect(new ReplyDeliveryError('failure').message).not.toContain('failure')
    })
})

// 2.89.13 (Abnahme 2.89.12, 01:25:38): the journal only said "ReplyDeliveryError: Reply delivery failed";
// the transport cause (EFATAL …) was lost, so the failure could not be explained afterwards.
describe('a delivery failure is logged with its cause', () => {
    it('names the transport cause, redacted and bounded', () => {
        const text = deliveryFailureText(new ReplyDeliveryError(new Error('EFATAL: fetch failed https://api.telegram.org/bot123456789:AAHfakeFAKEfake_test-value-1234567/sendMessage')))
        expect(text).toContain('EFATAL: fetch failed')
        expect(text).not.toContain('AAHfakeFAKEfake_test-value-1234567')
        expect(deliveryFailureText(new Error('boom'))).toBe('Error: boom')
    })
})

// 2.89.14 (Abnahme 2.89.13, 03:13:29): the first /freigabe failed with "Reply delivery failed" on the
// slash path, which telegram.ts logged without its cause.
describe('the Telegram handler logs keep the delivery cause', () => {
    it('every "messageHandler threw" line goes through deliveryFailureText', () => {
        const source = readFileSync(new URL('../channels/telegram.ts', import.meta.url), 'utf8')
        const lines = source.split('\n').filter(line => line.includes('] messageHandler threw:'))
        expect(lines.length).toBeGreaterThanOrEqual(2)
        for (const line of lines) expect(line).toContain('deliveryFailureText(')
    })
})
