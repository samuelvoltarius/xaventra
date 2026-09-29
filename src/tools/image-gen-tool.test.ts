import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tg = vi.hoisted(() => ({
    sendPhoto: vi.fn(async () => undefined),
    getLastActiveChat: vi.fn(() => '777'),
}))
vi.mock('../channels/telegram.js', () => ({ getTelegramAdapter: () => tg }))

import { deliverGeneratedImage } from './image-gen-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

afterEach(() => {
    tg.sendPhoto.mockClear()
    tg.getLastActiveChat.mockClear()
    delete (globalThis as any).__novaState
})

describe('generate_image delivery', () => {
    it('sends only to the authenticated Telegram requester', async () => {
        const note = await withExecutionPolicyContext({ channel: 'Telegram', authUserId: '123', runId: 'r' },
            () => deliverGeneratedImage('/tmp/img.png', 'dall-e-3'))
        expect(tg.sendPhoto).toHaveBeenCalledTimes(1)
        expect((tg.sendPhoto.mock.calls[0] as unknown[])[0]).toBe('123')
        expect(note).toMatch(/gesendet/)
        expect(tg.getLastActiveChat).not.toHaveBeenCalled()
    })

    it('never falls back to the last active chat; returns the file path instead', async () => {
        ;(globalThis as any).__novaState = { lastActiveChatId: '888' }
        for (const context of [{}, { channel: 'rest', authUserId: '123' }, { channel: 'telegram', authUserId: 'alice' }, { channel: 'telegram' }]) {
            const note = await withExecutionPolicyContext(context, () => deliverGeneratedImage('/tmp/img.png', 'dall-e-3'))
            expect(note).toContain('/tmp/img.png')
        }
        expect(tg.sendPhoto).not.toHaveBeenCalled()
        expect(tg.getLastActiveChat).not.toHaveBeenCalled()
    })

    it('executeImageGen has no process-global recipient path left', () => {
        const source = readFileSync(fileURLToPath(new URL('./image-gen-tool.ts', import.meta.url)), 'utf8')
        expect(source).not.toMatch(/getLastActiveChat|lastActiveChatId/)
    })
})
