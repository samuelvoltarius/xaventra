import { describe, expect, it } from 'vitest'
import { PRODUCTION_TRACE_CONTRACT, verifyTraceSpanNames } from './trace-verifier.js'

describe('production trace contract', () => {
    it('requires the complete channel to verified outcome chain', () => {
        const result = verifyTraceSpanNames('nova-1', [...PRODUCTION_TRACE_CONTRACT])
        expect(result.complete).toBe(true)
        expect(result.missing).toEqual([])
    })

    it('reports the exact missing evidence stages', () => {
        const result = verifyTraceSpanNames('nova-2', [
            'nova.channel.message',
            'nova.llm.complete',
            'nova.tool.execute',
        ])
        expect(result.complete).toBe(false)
        expect(result.missing).toEqual(['nova.tool.evidence', 'nova.outcome.event'])
    })
})
