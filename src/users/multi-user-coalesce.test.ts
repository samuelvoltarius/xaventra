import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COALESCED_MESSAGE_MARKER, coalesceMessage, isCoalescedMarker, shouldCoalesce } from './multi-user-middleware.js'
import { handleCommand } from '../core/slash-commands.js'

// K4 regression: a third message inside the coalescing window overwrote the
// resolver of the second one, whose promise (and request-gate slot) then
// stayed pending forever.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('message coalescing settles every promise (K4)', () => {
    it('settles all three promises in one window; only the last carries the merged text', async () => {
        const settled: string[] = []
        const track = (p: Promise<string>, i: number) => p.then(v => { settled[i] = v; return v })
        const first = track(coalesceMessage('chat-k4', 'user-k4', 'a'), 0)
        await vi.advanceTimersByTimeAsync(500)
        const second = track(coalesceMessage('chat-k4', 'user-k4', 'b'), 1)
        await vi.advanceTimersByTimeAsync(500)
        const third = track(coalesceMessage('chat-k4', 'user-k4', 'c'), 2)
        expect(shouldCoalesce('chat-k4', 'user-k4')).toBe(true)

        await vi.advanceTimersByTimeAsync(3000)
        const results = await Promise.all([first, second, third])
        expect(results[2]).toBe('a\nb\nc')
        expect(isCoalescedMarker(results[0])).toBe(true)
        expect(isCoalescedMarker(results[1])).toBe(true)
        expect(isCoalescedMarker(results[2])).toBe(false)
        expect(shouldCoalesce('chat-k4', 'user-k4')).toBe(false)
    })

    it('a single buffered message resolves with its own content', async () => {
        const only = coalesceMessage('chat-k4b', 'user-k4b', 'solo')
        await vi.advanceTimersByTimeAsync(3000)
        expect(await only).toBe('solo')
    })

    it('keeps separate windows per chat and user', async () => {
        const a = coalesceMessage('chat-1', 'u', 'x')
        const b = coalesceMessage('chat-2', 'u', 'y')
        await vi.advanceTimersByTimeAsync(3000)
        expect(await a).toBe('x')
        expect(await b).toBe('y')
    })
})

describe('coalesced marker is handled silently by the command layer (K4)', () => {
    it('is a slash command the pipeline treats as already handled, for any role', async () => {
        expect(COALESCED_MESSAGE_MARKER.startsWith('/')).toBe(true)
        const cmd = COALESCED_MESSAGE_MARKER.slice(1).split(' ')[0].toLowerCase()
        const state: any = { running: true, channels: {}, startTime: Date.now(), config: {} }
        for (const permission of ['guest', 'user', 'owner'] as const) {
            expect(await handleCommand(cmd, '', 'u', state, [], { channel: 'telegram', rawUserId: 'u', principalId: 'u', permission })).toBe('__HANDLED__')
        }
        expect(await handleCommand(cmd, '', 'u', state, [])).toBe('__HANDLED__')
    })
})
