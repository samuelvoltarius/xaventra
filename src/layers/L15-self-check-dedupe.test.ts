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

// 2.90.3 (VM 130, 2.90.2, 00:06): "desktop_screenshot hat 5x versagt / mesh_delegate 3x" every minute, each time with
// an LLM diagnosis: another issue that came and went changed the signature of the whole set. B4: each issue (by its
// signature) is reported at most once per hour, whatever else changes around it.
describe('L15 self-check reports each issue at most hourly (B4)', () => {
    afterEach(() => {
        const manager = getSelfCheckManager()
        manager.stopAutoCheck()
        manager.completeTask('b4_wechselnde_aufgabe')
        manager.reportToolSuccess('b4_probe_tool')
        vi.useRealTimers()
    })

    it('a tool failure issue is not repeated when another issue comes and goes', async () => {
        vi.useFakeTimers()
        const manager = getSelfCheckManager()
        for (let i = 0; i < 5; i++) manager.reportToolFailure('b4_probe_tool')
        const events: Array<{ issues: string[] }> = []
        const listener = (result: { issues: string[] }) => events.push(result)
        manager.on('shouldAct', listener)
        manager.startAutoCheck(1)
        await vi.advanceTimersByTimeAsync(1_100)
        manager.addPendingTask('b4_wechselnde_aufgabe')
        await vi.advanceTimersByTimeAsync(1_000)
        manager.completeTask('b4_wechselnde_aufgabe')
        manager.reportToolFailure('b4_probe_tool')
        await vi.advanceTimersByTimeAsync(3_000)
        manager.off('shouldAct', listener)
        const toolReports = events.flatMap(event => event.issues).filter(issue => issue.includes('b4_probe_tool'))
        expect(toolReports).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(0)
    })
})
