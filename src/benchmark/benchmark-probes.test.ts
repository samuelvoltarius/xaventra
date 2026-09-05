import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBenchmarkScenarios } from './benchmark-lab.js'
import { runBenchmarkProbe } from './benchmark-probes.js'

describe('isolated benchmark prerequisite probes', () => {
    it.each([
        ['resume-1', ['checkpoint']],
        ['memory-1', ['retrieved fact']],
        ['mesh-1', ['lease', 'fencing token']],
    ])('produces verified evidence for %s without production state', async (scenarioId, requiredTags) => {
        const scenario = getBenchmarkScenarios().find(item => item.id === scenarioId)
        expect(scenario).toBeDefined()
        const workspace = mkdtempSync(join(tmpdir(), `nova-benchmark-${scenarioId}-`))
        const result = await runBenchmarkProbe(scenario!, workspace)
        expect(result?.success).toBe(true)
        expect(result?.evidenceTags).toEqual(expect.arrayContaining(requiredTags))
    })

    it.each([
        'discovery', 'routing', 'tools', 'resume', 'memory',
        'mesh', 'doctor', 'channels', 'governance', 'proactivity',
    ])('covers every declared %s evidence contract with typed subsystem evidence', async category => {
        const scenarios = getBenchmarkScenarios().filter(item => item.category === category)
        const scenario = scenarios[0]
        const workspace = mkdtempSync(join(tmpdir(), `nova-benchmark-${category}-`))
        const result = await runBenchmarkProbe(scenario, workspace)
        const required = [...new Set(scenarios.flatMap(item => item.requiredEvidence))]
        expect(result?.success).toBe(true)
        expect(result?.evidenceTags).toEqual(expect.arrayContaining(required))
    })
})
