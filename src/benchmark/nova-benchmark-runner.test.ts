import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentBackend } from '../agents/agent-backend.js'
import { OutcomeLedger, withOutcomeLedger } from '../core/outcome-ledger.js'
import { getBenchmarkScenarios } from './benchmark-lab.js'
import { ensureBenchmarkRuntimeReady, executeNovaBenchmarkScenario, hasGroundedEvidence } from './nova-benchmark-runner.js'

describe('benchmark runtime bootstrap', () => {
    it('never counts requested tags, model prose or unverified probe claims as evidence', () => {
        const run: any = { tools: [], contract: { goal: 'memory-evidence' }, finalOutcome: { output: 'memory-evidence' } }
        expect(hasGroundedEvidence(run, 'memory-evidence')).toBe(false)
        run.tools = [{ success: true, verified: false, source: 'isolated-benchmark-probe', evidenceTags: ['memory-evidence'] }]
        expect(hasGroundedEvidence(run, 'memory-evidence')).toBe(false)
        run.tools[0].verified = true
        expect(hasGroundedEvidence(run, 'memory-evidence')).toBe(true)
    })
    it('discovers the LLM inventory for the standalone CLI', async () => {
        const discover = vi.fn(async () => undefined)

        await ensureBenchmarkRuntimeReady(false, [], discover)

        expect(discover).toHaveBeenCalledOnce()
    })

    it('preserves an initialized daemon inventory and injected test backends', async () => {
        const discover = vi.fn(async () => undefined)

        await ensureBenchmarkRuntimeReady(false, [{ model: 'qwen' }], discover)
        await ensureBenchmarkRuntimeReady(true, [], discover)

        expect(discover).not.toHaveBeenCalled()
    })

    it('post-validates a real isolated subsystem probe without trusting model prose', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-benchmark-runner-'))
        const ledger = new OutcomeLedger(join(root, 'ledger'), false)
        let receivedTools: unknown
        let receivedSystemPrompt = ''
        const backend: AgentBackend = {
            name: 'fixture-planner',
            run: async input => {
                receivedTools = input.tools
                receivedSystemPrompt = input.systemPrompt || ''
                return {
                    runId: input.contract.id,
                    backend: 'fixture-planner',
                    status: 'completed',
                    output: 'Diagnose geplant und an den isolierten Executor übergeben.\nBENCHMARK_RESULT: READY',
                    toolsUsed: [],
                }
            },
        }
        const scenario = getBenchmarkScenarios().find(item => item.id === 'tools-6')!
        const observation = await withOutcomeLedger(ledger,
            () => executeNovaBenchmarkScenario(backend, scenario, join(root, 'workspace')))
        expect(observation.success).toBe(true)
        expect(observation.evaluationKind).toBe('subsystem-probes')
        expect(observation.toolExecuted).toBe(true)
        expect(observation.falseCompletion).toBe(false)
        expect(observation.unnecessaryQuestions).toBe(0)
        expect(receivedTools).toEqual([])
        expect(receivedSystemPrompt).toContain('Do not use a question mark')
        expect(ledger.listRuns()[0].tools[0]).toMatchObject({
            toolName: 'benchmark_execution_control_probe',
            verified: true,
        })
    })

    it('counts only an explicit user-input pause, not hidden planner punctuation', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-benchmark-question-'))
        const ledger = new OutcomeLedger(join(root, 'ledger'), false)
        const backend: AgentBackend = {
            name: 'fixture-planner',
            run: async input => ({
                runId: input.contract.id,
                backend: 'fixture-planner',
                status: 'completed',
                output: 'Soll ich fortfahren?',
                toolsUsed: [],
                requestedUserInput: false,
            }),
        }
        const scenario = getBenchmarkScenarios().find(item => item.id === 'tools-6')!
        const observation = await withOutcomeLedger(ledger,
            () => executeNovaBenchmarkScenario(backend, scenario, join(root, 'workspace')))

        expect(observation.unnecessaryQuestions).toBe(0)
    })

    it('cannot pass on probe evidence when the agent backend failed', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-benchmark-backend-failure-'))
        const ledger = new OutcomeLedger(join(root, 'ledger'), false)
        const backend: AgentBackend = {
            name: 'failed-planner',
            run: async input => ({
                runId: input.contract.id,
                backend: 'failed-planner',
                status: 'failed',
                output: '',
                toolsUsed: [],
                error: 'no model endpoint',
            }),
        }
        const scenario = getBenchmarkScenarios().find(item => item.id === 'tools-6')!
        const observation = await withOutcomeLedger(ledger,
            () => executeNovaBenchmarkScenario(backend, scenario, join(root, 'workspace')))

        expect(observation.success).toBe(false)
        expect(ledger.listRuns()[0].status).not.toBe('completed')
    })
})
