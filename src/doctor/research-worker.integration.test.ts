import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FailureResearchCoordinator } from './failure-research-coordinator.js'
import { createResearchWorker } from './research-worker.js'
import { OutcomeLedger, withOutcomeLedger } from '../core/outcome-ledger.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import type { TaskContract } from '../core/task-contract.js'

describe('Doctor investigation through the actual native execution pipeline', () => {
    it('cannot read a file outside the exact candidate profile through the native tool executor', async () => {
        const registry = getToolRegistry(), original = registry.get('read_file')!
        const handler = vi.fn(async () => ({ success: true, output: 'must never be read' }))
        registry.register({ ...original, handler })
        const contract: TaskContract = {
            id: 'doctor-candidate-outside-path', version: 1, goal: 'Read the approved candidate source', createdAt: new Date().toISOString(),
            expectedArtifacts: [], requiredTests: [],
            successCriteria: [{ id: 'evidence', kind: 'verified_tool', required: true, description: 'Approved source only' }],
            allowedChanges: { readOnly: true, allowedPaths: [join(process.cwd(), 'src/approved.ts')], allowedTools: ['read_file'], externalSideEffects: false },
            budget: { timeoutMs: 15_000, maxToolCalls: 1, maxTokens: 500 }, approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
        }
        let turns = 0
        const llm = { modelId: 'scripted-fixture', complete: async () => ++turns === 1
            ? { content: '', toolCalls: [{ name: 'read_file', arguments: { path: join(process.cwd(), 'src/unapproved.ts') } }] }
            : { content: '{"blocked":"read refused"}' } }
        try {
            await withOutcomeLedger(new OutcomeLedger(join(process.cwd(), '.nova-data', 'candidate-path-ledger')), async () => {
                const worker = createResearchWorker(() => true, llm)
                await worker.execute({ contract, content: contract.goal, caseId: 'path-check', signal: new AbortController().signal, purpose: 'candidate' })
                expect(handler).not.toHaveBeenCalled()
                expect(worker.getRun(contract.id)?.validation?.success).not.toBe(true)
            })
        } finally { registry.register(original) }
    }, 30_000)
    it.each(['memory-scope', 'authority-loss'])(
        'rejects %s at the real pre-tool boundary', async scenario => {
            const coordinator = new FailureResearchCoordinator(join(process.cwd(), '.nova-data', `${scenario}.json`))
            coordinator.ingest({ id: scenario, title: 'System health probe failed', detail: 'Inspect system state',
                category: 'health', severity: 'critical', source: 'fixture', recommendation: 'Investigate', evidence: {}, status: 'open', createdAt: '', updatedAt: '' })
            const registry = getToolRegistry()
            const toolName = scenario === 'memory-scope' ? 'nova_introspect' : 'health_status'
            const original = registry.get(toolName)!
            const handler = vi.fn(async () => ({ success: true, output: 'must not execute' }))
            registry.register({ ...original, handler })
            let authority = true
            let turns = 0
            const llm = { modelId: 'scripted-fixture', complete: async () => {
                if (++turns > 1) return { content: 'Stopped at policy boundary.' }
                if (scenario === 'authority-loss') authority = false
                return { content: '', toolCalls: [{ name: toolName, arguments: scenario === 'memory-scope' ? { type: 'memories' } : {} }] }
            } }
            try {
                await withOutcomeLedger(new OutcomeLedger(join(process.cwd(), '.nova-data', `${scenario}-ledger`)), async () => {
                    const result = await coordinator.investigateNext(createResearchWorker(() => authority, llm))
                    expect(result?.investigation?.status).toBe('failed')
                    expect(handler).not.toHaveBeenCalled()
                })
            } finally { registry.register(original) }
        }, 30_000,
    )

    it('retains observed tool evidence in the real ledger; scripted model is not a repair-quality benchmark', async () => {
        const path = join(process.cwd(), '.nova-data', 'research-integration.json')
        const observationPath = join(process.cwd(), '.nova-data', 'probe-fixture.json')
        writeFileSync(observationPath, JSON.stringify({ state: 'degraded', observed: 'fixture probe has missing response field' }))
        const coordinator = new FailureResearchCoordinator(path)
        coordinator.ingest({ id: 'fixture-probe', title: 'System health probe failed', detail: 'Inspect current health_status evidence',
            category: 'health', severity: 'critical', source: 'fixture', recommendation: 'Investigate observed state', evidence: {}, status: 'open', createdAt: '', updatedAt: '' })
        const registry = getToolRegistry()
        const original = registry.get('health_status')!
        const handler = vi.fn(async () => ({ success: true, output: readFileSync(observationPath, 'utf8') }))
        registry.register({ ...original, handler })
        let turns = 0
        const llm = { modelId: 'scripted-fixture', complete: vi.fn(async () => ++turns === 1
            ? { content: '', toolCalls: [{ name: 'health_status', arguments: {} }] }
            : { content: 'Die aktuelle Probe meldet degraded und ein fehlendes Antwortfeld. Keine Reparatur durchgeführt.' }) }
        try {
            const ledger = new OutcomeLedger(`${path}.ledger`)
            await withOutcomeLedger(ledger, async () => {
                const result = await coordinator.investigateNext(createResearchWorker(() => true, llm))
                expect(result?.investigation?.status).toBe('verified')
                const run = ledger.getRun(result!.investigation!.runId)!
                expect(run.status).toBe('completed')
                expect(run.validation?.success).toBe(true)
                expect(run.tools.some(tool => JSON.stringify(tool.result).includes('missing response field'))).toBe(true)
                expect(handler).toHaveBeenCalledTimes(1)
                expect(result?.stage).toBe('researching')
                expect(await new FailureResearchCoordinator(path).investigateNext(createResearchWorker(() => true, llm))).toBeNull()
            })
        } finally { registry.register(original) }
    }, 30_000)
})
