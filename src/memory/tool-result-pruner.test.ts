import { describe, expect, it } from 'vitest'
import { pruneToolResult } from './tool-result-pruner.js'

describe('tool result pruner', () => {
    it('preserves small results and hashes bounded large results', () => {
        expect(pruneToolResult('ok', { maxBytes: 1024 }).value).toBe('ok')
        const report = pruneToolResult('a'.repeat(20_000), { maxBytes: 2_000 })
        expect(report.pruned).toBe(true)
        expect(String(report.value)).toContain('tool result pruned')
        expect(report.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(report.retainedBytes).toBeLessThan(report.originalBytes)
    })
})
