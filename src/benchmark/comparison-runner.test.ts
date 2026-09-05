import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBenchmarkComparison } from './comparison-runner.js'

describe('benchmark comparison runner', () => {
    it('uses the same contract and ranks evidence-backed completion', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'nova-comparison-'))
        const scenario = { id: 'same-1', category: 'tools' as const, title: 'same', prompt: 'same', requiredEvidence: ['tool result'], timeoutMs: 100, destructive: false as const }
        const report = await runBenchmarkComparison([
            { name: 'nova', execute: async () => ({ scenarioId: 'same-1', success: true, toolExecuted: true, durationMs: 10 }) },
            { name: 'other', execute: async () => ({ scenarioId: 'same-1', success: false, toolExecuted: false, durationMs: 5, falseCompletion: true }) },
        ], [scenario], outputDir)
        expect(report.scenarios).toBe(1)
        expect(report.ranking).toEqual(['nova', 'other'])
        expect(report.contractHash).toMatch(/^fnv1a-/)
        rmSync(outputDir, { recursive: true, force: true })
    })
})
