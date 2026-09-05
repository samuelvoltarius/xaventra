import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shared = vi.hoisted(() => ({
    entry: null as any,
    probeSharedMemory: vi.fn(async () => true),
    pushSharedMemory: vi.fn(async (entry: any) => {
        shared.entry = entry
        return true
    }),
    pullSharedMemory: vi.fn(async () => shared.entry ? [shared.entry] : []),
}))

vi.mock('../memory/shared-memory.js', () => shared)

describe('HA state', () => {
    const previousKey = process.env.NOVA_HA_STATE_KEY

    beforeEach(() => {
        shared.entry = null
        shared.pushSharedMemory.mockClear()
        shared.pullSharedMemory.mockClear()
        process.env.NOVA_HA_STATE_KEY = 'test-only-ha-key-that-is-longer-than-32-characters'
    })

    afterEach(() => {
        if (previousKey === undefined) delete process.env.NOVA_HA_STATE_KEY
        else process.env.NOVA_HA_STATE_KEY = previousKey
    })

    it('encrypts channel state and restores it on a promoted node', async () => {
        const { publishChannelState, hydrateChannelState } = await import('./ha-state.js')
        await expect(publishChannelState('Telegram', {
            lastActiveChatId: '4711',
            adminChatId: '4711',
            lastActiveUserId: 'sample',
        })).resolves.toBe(true)

        expect(shared.entry.content).not.toContain('4711')
        expect(shared.entry.metadata.encrypted).toBe(true)

        const state: Record<string, unknown> = {}
        await expect(hydrateChannelState('Telegram', state)).resolves.toMatchObject({
            lastActiveChatId: '4711',
            adminChatId: '4711',
        })
        expect(state.lastActiveUserId).toBe('sample')
    })
})
