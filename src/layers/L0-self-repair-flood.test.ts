import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelfRepairEngine, getSelfRepairEngine, handleUncaughtError, rejectionLogGate, resetSelfRepairGate } from './L0-self-repair.js'

// B4 (28.10.2026, VM 130): every one of the 13.256 B2 rejections went to
// "[L0 Self-Repair] Issue erkannt: logic in node:events" → NovaDoctorClient
// "Diagnosis failed validation; using unverified rule-based fallback" → PATCH_GATE proposal.
const liveRejection = () => Object.assign(new Error(
    "Unhandled error. ({ server: 'home-assistant', error: \"MCP home-assistant connection failed: Unhandled error. ({ server: 'home-assistant', error: 'fetch failed' })\" })",
), { code: 'ERR_UNHANDLED_ERROR' })

describe('L0 self-repair is not flooded (B4)', () => {
    afterEach(() => { vi.restoreAllMocks(); resetSelfRepairGate() })

    it('a reachability failure never reaches the Doctor or a repair', () => {
        const diagnose = vi.spyOn(SelfRepairEngine.prototype, 'diagnoseIssue').mockResolvedValue({ diagnosis: 'x', fix: 'y' } as any)
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        for (let i = 0; i < 50; i++) handleUncaughtError(liveRejection())
        expect(diagnose).not.toHaveBeenCalled()
    })

    it('the same rejection is logged once per hour with the number of silent repeats', () => {
        const t0 = 1_000_000
        expect(rejectionLogGate(liveRejection(), t0)).toBe(0)
        for (let i = 1; i <= 1000; i++) expect(rejectionLogGate(liveRejection(), t0 + i * 3_500)).toBeNull()
        expect(rejectionLogGate(liveRejection(), t0 + 61 * 60_000)).toBe(1000)
    })

    it('the same code error is diagnosed at most once per hour', () => {
        vi.useFakeTimers()
        try {
            const diagnose = vi.spyOn(SelfRepairEngine.prototype, 'diagnoseIssue').mockResolvedValue({ diagnosis: 'x', fix: 'y' } as any)
            vi.spyOn(console, 'log').mockImplementation(() => undefined)
            const bug = () => { const e = new TypeError("Cannot read properties of undefined (reading 'name')"); e.stack = `TypeError: ${e.message}\n    at foo (/app/dist/core/thing.js:12:3)`; return e }
            for (let i = 0; i < 30; i++) handleUncaughtError(bug())
            expect(diagnose).toHaveBeenCalledTimes(1)
            vi.advanceTimersByTime(61 * 60_000)
            handleUncaughtError(bug())
            expect(diagnose).toHaveBeenCalledTimes(2)
            // A different error is its own signature.
            handleUncaughtError(new RangeError('Invalid array length'))
            expect(diagnose).toHaveBeenCalledTimes(3)
            expect(getSelfRepairEngine()).toBeInstanceOf(SelfRepairEngine)
        } finally { vi.useRealTimers() }
    })
})
