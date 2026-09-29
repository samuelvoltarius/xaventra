import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSelfCheckManager } from './L15-self-check.js'

describe('L15 self-check shouldAct dedupe (R2 L4)', () => {
    afterEach(() => {
        getSelfCheckManager().stopAutoCheck()
        vi.useRealTimers()
    })

    it('emits shouldAct once for an unchanged issue set instead of every interval', async () => {
        vi.useFakeTimers()
        const manager = getSelfCheckManager()
        for (let i = 0; i < 3; i++) manager.reportToolFailure('r2_l4_probe_tool')
        const events: unknown[] = []
        const listener = (result: unknown) => events.push(result)
        manager.on('shouldAct', listener)
        manager.startAutoCheck(1)
        await vi.advanceTimersByTimeAsync(5_500)
        expect(events.length).toBe(1)
        manager.off('shouldAct', listener)
        manager.reportToolSuccess('r2_l4_probe_tool')
    })
})
