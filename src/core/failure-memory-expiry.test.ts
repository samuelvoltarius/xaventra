import { describe, expect, it } from 'vitest'
import { failureStillBlocks, isInfrastructureFailure, type FailedApproach } from './correction-detector.js'

// 2.85.11 (live 06.10.2026): one scan_now timeout at the old 30 s limit (05.10.)
// blocked the device scan forever — across the 2.85.10 update — and with it every
// "which devices do you see?" answer. Infrastructure failures are no evidence that
// an approach is wrong, and a remembered failure must not outlive its version or a day.

const NOW = Date.parse('2026-10-06T13:00:00Z')
const entry = (over: Partial<FailedApproach> = {}): FailedApproach => ({
    toolName: 'scan_now', params: { was: 'geraete' }, error: 'Error: something specific went wrong',
    timestamp: NOW - 60_000, userRequest: 'Welche Geräte siehst du?', version: '2.85.11', ...over,
})

describe('failure memory: only real, recent failures of this version block a retry', () => {
    it('timeouts, exhausted budgets and contract refusals are infrastructure, not a wrong approach', () => {
        expect(isInfrastructureFailure('Error: [Timeout] Tool: scan_now exceeded 30000ms')).toBe(true)
        expect(isInfrastructureFailure('Error: Task tool-call budget exhausted')).toBe(true)
        expect(isInfrastructureFailure('Error: Tool outside task contract: run_command')).toBe(true)
        expect(isInfrastructureFailure('AbortError: The operation was aborted due to timeout')).toBe(true)
        expect(isInfrastructureFailure('TypeError: fetch failed')).toBe(true)
        // Gegenprobe: a real tool error still counts.
        expect(isInfrastructureFailure("Error: ENOENT: no such file or directory, open '/tmp/x.png'")).toBe(false)
        expect(isInfrastructureFailure('Error: Ungültiger Parameter: was')).toBe(false)
    })

    it('a recent real failure of the same version blocks the identical retry (Gegenprobe)', () => {
        expect(failureStillBlocks(entry(), { now: NOW, version: '2.85.11' })).toBe(true)
    })

    it('an entry from an older version or without version never blocks after an update', () => {
        expect(failureStillBlocks(entry({ version: '2.85.9' }), { now: NOW, version: '2.85.11' })).toBe(false)
        expect(failureStillBlocks(entry({ version: undefined }), { now: NOW, version: '2.85.11' })).toBe(false)
    })

    it('a remembered failure expires after 24 hours', () => {
        expect(failureStillBlocks(entry({ timestamp: NOW - 25 * 3_600_000 }), { now: NOW, version: '2.85.11' })).toBe(false)
        expect(failureStillBlocks(entry({ timestamp: NOW - 23 * 3_600_000 }), { now: NOW, version: '2.85.11' })).toBe(true)
    })

    it('an infrastructure failure stored by an older build never blocks', () => {
        expect(failureStillBlocks(entry({ error: 'Error: [Timeout] Tool: scan_now exceeded 30000ms' }), { now: NOW, version: '2.85.11' })).toBe(false)
    })
})
