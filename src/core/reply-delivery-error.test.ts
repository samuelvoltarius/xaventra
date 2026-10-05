import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { protectReplyDelivery, ReplyDeliveryError } from './reply-delivery-error.js'

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
