import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalesceEntityMessage, COALESCED_MESSAGE_MARKER, setEntityWindowForTests } from './multi-user-middleware.js'
afterEach(() => { vi.useRealTimers(); setEntityWindowForTests(20_000) })
describe('entity corrections settle before memory', () => {
    it('rejects an oversized burst without processing overflow before the deadline', async () => {
        vi.useFakeTimers()
        const first = coalesceEntityMessage('telegram:overflow', 'owner', 'Er ist grau.')
        const overflow = coalesceEntityMessage('telegram:overflow', 'owner', 'x'.repeat(16_001))
        expect(await overflow).toEqual({ content: COALESCED_MESSAGE_MARKER })
        await vi.advanceTimersByTimeAsync(20_000)
        expect((await first).content).toBe('/__entity_overflow__')
    })
    it('merges corrections arriving within 20 seconds and retains the image', async () => {
        vi.useFakeTimers()
        const image = { data: 'fixture-image', mimeType: 'image/png' }
        const first = coalesceEntityMessage('telegram:chat', 'owner', 'Nicht ganz, er ist grau.', image)
        await vi.advanceTimersByTimeAsync(19_000)
        const second = coalesceEntityMessage('telegram:chat', 'owner', 'Und das ist nicht Alpha.')
        await vi.advanceTimersByTimeAsync(1000)
        expect(await first).toEqual({ content: COALESCED_MESSAGE_MARKER })
        expect(await second).toMatchObject({ content: 'Nicht ganz, er ist grau.\nUnd das ist nicht Alpha.', image, turns: [{ content: 'Nicht ganz, er ist grau.', image }, { content: 'Und das ist nicht Alpha.' }] })
    })
    it('never merges different chats or users', async () => {
        vi.useFakeTimers()
        const a = coalesceEntityMessage('telegram:one', 'owner', 'Alpha')
        const b = coalesceEntityMessage('telegram:two', 'owner', 'Beta')
        const c = coalesceEntityMessage('telegram:one', 'other', 'Gamma')
        await vi.advanceTimersByTimeAsync(20_000)
        expect((await a).content).toBe('Alpha'); expect((await b).content).toBe('Beta'); expect((await c).content).toBe('Gamma')
    })
})
