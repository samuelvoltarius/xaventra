import { describe, expect, it } from 'vitest'
import { judgeAcceptance } from './agent-acceptance.js'
import { benchmarkExitCode } from './benchmark-lab.js'

describe('agent acceptance cannot be satisfied by a fixture executor', () => {
    it('rejects a correct guessed answer without genuine tool evidence', () => {
        expect(judgeAcceptance({ output: '43', status: 'completed', validation: { success: true }, tools: [] }, { contains: ['43'], minReads: 2 }).realToolEvidence).toBe(false)
    })
    it('rejects correct tool execution with a wrong or stale final answer', () => {
        const checks = judgeAcceptance({ output: 'OLD', status: 'completed', validation: { success: true } }, { contains: ['NEW'], excludes: ['OLD'] })
        expect(checks.expectedAnswer).toBe(false)
        expect(checks.noStaleAnswer).toBe(false)
    })
    it('fails the CLI gate on an empty suite, rejected case or false completion', () => {
        expect(benchmarkExitCode([])).toBe(1)
        expect(benchmarkExitCode([{ scenarioId: 'x', success: false, toolExecuted: false, durationMs: 1 }])).toBe(1)
        expect(benchmarkExitCode([{ scenarioId: 'x', success: true, toolExecuted: true, durationMs: 1, falseCompletion: true }])).toBe(1)
    })
})
