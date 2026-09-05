import { describe, expect, it } from 'vitest'
import { evaluateProactivity } from './proactive-policy.js'

describe('proactivity policy', () => {
    it('suppresses unverified guesses', () => {
        expect(evaluateProactivity({ impact: 1, confidence: 1, dedupeKey: 'test', evidence: [] }).allow).toBe(false)
    })

    it('allows high-impact events with recent verified evidence but keeps actions gated', () => {
        const decision = evaluateProactivity({
            impact: 0.9, confidence: 0.9, dedupeKey: 'verified-test', actionAvailable: true,
            evidence: [{ source: 'vllm-health', verifiedAt: new Date().toISOString(), summary: 'connection refused', verified: true }, { source: 'mesh', verifiedAt: new Date().toISOString(), summary: 'fallback ready', verified: true }],
        })
        expect(decision.allow).toBe(true)
        expect(decision.requiresApproval).toBe(true)
    })
})
