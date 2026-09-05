import { describe, expect, it } from 'vitest'
import { classifyNovaDataUsage } from './L0-health-monitor.js'

describe('L0 Nova data classification', () => {
    it('does not flag bounded signed releases and benchmark artifacts as an operational leak', () => {
        expect(classifyNovaDataUsage(900, 700)).toEqual({
            sizeMB: 900,
            managedMB: 700,
            operationalMB: 200,
            warning: false,
        })
    })

    it('flags excessive operational data and an excessive hard total', () => {
        expect(classifyNovaDataUsage(900, 100).warning).toBe(true)
        expect(classifyNovaDataUsage(4_500, 4_000).warning).toBe(true)
    })
})
