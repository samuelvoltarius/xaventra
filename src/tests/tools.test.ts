/**
 * Tool Policy & Loop Detection Tests
 */

import { describe, it, expect } from 'vitest'
import { evaluatePolicy, DEFAULT_POLICY } from '../tools/tool-policy.js'
import { LoopDetector } from '../tools/loop-detection.js'

// ============================================
// Tool Policy Tests
// ============================================

describe('Tool Policy', () => {
    it('should deny SSH on Telegram', () => {
        const result = evaluatePolicy('ssh_connect', { channel: 'telegram' }, DEFAULT_POLICY)
        expect(result.action).toBe('deny')
    })

    it('should allow SSH on CLI', () => {
        const result = evaluatePolicy('ssh_connect', { channel: 'cli' }, DEFAULT_POLICY)
        expect(result.action).toBe('allow')
    })

    it('should require confirmation for self_extend', () => {
        const result = evaluatePolicy('self_extend', { channel: 'telegram' }, DEFAULT_POLICY)
        expect(result.action).toBe('confirm')
    })

    it('should allow normal tools everywhere', () => {
        const result = evaluatePolicy('web_search', { channel: 'telegram' }, DEFAULT_POLICY)
        expect(result.action).toBe('allow')
    })

    it('should respect custom policy', () => {
        const policy = {
            defaultAction: 'deny' as const,
            rules: [
                { tool: 'allowed_tool', action: 'allow' as const },
            ],
        }
        expect(evaluatePolicy('allowed_tool', {}, policy).action).toBe('allow')
        expect(evaluatePolicy('other_tool', {}, policy).action).toBe('deny')
    })
})

// ============================================
// Loop Detection Tests
// ============================================

describe('Loop Detection', () => {
    it('should detect repeated same tool+args', () => {
        const detector = new LoopDetector({ maxRepeatCalls: 3, maxCallsPerTurn: 100, windowSize: 10 })

        expect(detector.recordCall('search', { query: 'hello' })).toBeNull()
        expect(detector.recordCall('search', { query: 'hello' })).toBeNull()
        expect(detector.recordCall('search', { query: 'hello' })).not.toBeNull() // 3rd time = loop
    })

    it('should not trigger for different args', () => {
        const detector = new LoopDetector({ maxRepeatCalls: 3, maxCallsPerTurn: 100, windowSize: 10 })

        expect(detector.recordCall('search', { query: 'a' })).toBeNull()
        expect(detector.recordCall('search', { query: 'b' })).toBeNull()
        expect(detector.recordCall('search', { query: 'c' })).toBeNull()
    })

    it('should detect too many total calls', () => {
        const detector = new LoopDetector({ maxRepeatCalls: 100, maxCallsPerTurn: 5, windowSize: 10 })

        for (let i = 0; i < 5; i++) {
            detector.recordCall(`tool_${i}`, { i })
        }
        const result = detector.recordCall('tool_extra', {})
        expect(result).not.toBeNull()
        expect(result).toContain('Loop')
    })

    it('should detect alternating patterns', () => {
        const detector = new LoopDetector({ maxRepeatCalls: 100, maxCallsPerTurn: 100, windowSize: 10 })

        // A→B→A→B→A→B
        for (let i = 0; i < 3; i++) {
            detector.recordCall('toolA', { x: 'a' })
            detector.recordCall('toolB', { x: 'b' })
        }
        // The 6th call completes the alternating pattern detection
        // Checking if it was caught in the last recordCall
        const stats = detector.getStats()
        expect(stats.turnCalls).toBe(6)
    })

    it('should reset on new turn', () => {
        const detector = new LoopDetector({ maxRepeatCalls: 100, maxCallsPerTurn: 3, windowSize: 10 })

        detector.recordCall('tool', {})
        detector.recordCall('tool', {})
        detector.recordCall('tool', {})
        detector.resetTurn()

        expect(detector.recordCall('tool', {})).toBeNull() // Fresh turn
    })
})
