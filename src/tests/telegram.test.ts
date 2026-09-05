/**
 * Telegram Streaming Tests
 */

import { describe, it, expect, vi } from 'vitest'
import { DraftStream } from '../channels/telegram-stream.js'

describe('DraftStream', () => {
    it('should send initial thinking message', async () => {
        const stream = new DraftStream()
        const sendFn = vi.fn().mockResolvedValue(12345)
        const editFn = vi.fn().mockResolvedValue(undefined)

        const messageId = await stream.start(123, sendFn, editFn)

        expect(sendFn).toHaveBeenCalledWith(123, '⏳')
        expect(messageId).toBe(12345)
    })

    it('should buffer text before editing', async () => {
        const stream = new DraftStream({ minCharsBeforeEdit: 20, editIntervalMs: 0, maxEdits: 30, thinkingMessage: '⏳' })
        const sendFn = vi.fn().mockResolvedValue(1)
        const editFn = vi.fn().mockResolvedValue(undefined)

        await stream.start(1, sendFn, editFn)
        await stream.push('short') // < 20 chars

        // Should NOT have edited yet
        expect(editFn).not.toHaveBeenCalled()
    })

    it('should edit after enough content', async () => {
        const stream = new DraftStream({ minCharsBeforeEdit: 5, editIntervalMs: 0, maxEdits: 30, thinkingMessage: '⏳' })
        const sendFn = vi.fn().mockResolvedValue(1)
        const editFn = vi.fn().mockResolvedValue(undefined)

        await stream.start(1, sendFn, editFn)
        await stream.push('This is a long enough message to trigger an edit')

        expect(editFn).toHaveBeenCalledTimes(1)
    })

    it('should send final edit on complete', async () => {
        const stream = new DraftStream()
        const sendFn = vi.fn().mockResolvedValue(1)
        const editFn = vi.fn().mockResolvedValue(undefined)

        await stream.start(1, sendFn, editFn)
        await stream.complete('Final answer here')

        expect(editFn).toHaveBeenCalledWith(1, 1, 'Final answer here')
    })

    it('should not edit after abort', async () => {
        const stream = new DraftStream()
        const sendFn = vi.fn().mockResolvedValue(1)
        const editFn = vi.fn().mockResolvedValue(undefined)

        await stream.start(1, sendFn, editFn)
        await stream.abort('Error occurred')

        expect(editFn).toHaveBeenCalledWith(1, 1, '❌ Streaming abgebrochen')

        // Should not accept more pushes
        await stream.push('more text')
        expect(editFn).toHaveBeenCalledTimes(1) // Only the abort edit
    })

    it('should report stats', async () => {
        const stream = new DraftStream({ minCharsBeforeEdit: 5, editIntervalMs: 0, maxEdits: 30, thinkingMessage: '⏳' })
        const sendFn = vi.fn().mockResolvedValue(1)
        const editFn = vi.fn().mockResolvedValue(undefined)

        await stream.start(1, sendFn, editFn)
        await stream.push('Hello World 12345')

        const stats = stream.getStats()
        expect(stats.bufferLength).toBe(17)
        expect(stats.isCompleted).toBe(false)
    })
})
