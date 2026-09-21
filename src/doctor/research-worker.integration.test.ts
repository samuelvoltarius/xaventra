import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FailureResearchCoordinator, getFailureResearchCoordinator, setFailureResearchCoordinator } from './failure-research-coordinator.js'
import { createResearchWorker } from './research-worker.js'
import { OutcomeLedger, withOutcomeLedger } from '../core/outcome-ledger.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import type { TaskContract } from '../core/task-contract.js'
import { getToolFailureEscalationStore, setToolFailureEscalationStore, ToolFailureEscalationStore } from '../core/tool-failure-escalation.js'
import { getSessionContinuityStore, setSessionContinuityStore, SessionContinuityStore } from '../memory/session-summarizer.js'

describe('Doctor investigation through the actual native execution pipeline', () => {
    it('retries one transient read-only failure through the native runner and validates the correlated retry', async () => {
        const registry = getToolRegistry()
        const original = registry.get('health_status')!
        const handler = vi.fn(async () => handler.mock.calls.length === 1
            ? { success: false, error: 'HTTP 503 service unavailable' }
            : { success: true, output: 'healthy after retry' })
        registry.register({ ...original, handler })
        const contract: TaskContract = {
            id: 'doctor-typed-transient-recovery', version: 1, goal: 'Collect current health evidence', createdAt: new Date().toISOString(),
            expectedArtifacts: [], requiredTests: [],
            successCriteria: [{ id: 'evidence', kind: 'verified_tool', required: true, description: 'Verified health evidence' }],
            allowedChanges: { readOnly: true, allowedPaths: [], allowedTools: ['health_status'], externalSideEffects: false },
            budget: { timeoutMs: 15_000, maxToolCalls: 2, maxOutputTokens: 500 }, approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
        }
        let turns = 0
        const llm = { modelId: 'scripted-fixture', complete: async () => ({
            ...(++turns === 1
                ? { content: '', toolCalls: [{ name: 'health_status', arguments: {} }] }
                : { content: 'The independently verified health retry succeeded.' }),
            usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
        }) }
        try {
            const ledger = new OutcomeLedger(join(process.cwd(), '.nova-data', 'typed-recovery-native-ledger'))
            await withOutcomeLedger(ledger, async () => {
                const worker = createResearchWorker(() => true, llm)
                const result = await worker.execute({ contract, content: contract.goal, caseId: 'typed-recovery', signal: new AbortController().signal, purpose: 'research' })
                const run = ledger.getRun(contract.id)!
                expect(handler).toHaveBeenCalledTimes(2)
                expect(result.output).toContain('verified health retry succeeded')
                expect(run.status).toBe('completed')
                expect(run.validation?.success).toBe(true)
                expect(run.tools.some(tool => tool.success && JSON.stringify(tool.result).includes('healthy after retry'))).toBe(true)
            })
        } finally { registry.register(original) }
    }, 30_000)

    it('persists unknown failure escalation without asking the model to select build_skill', async () => {
        const registry = getToolRegistry()
        const originalHealth = registry.get('health_status')!
        const originalBuildSkill = registry.get('build_skill')!
        const healthHandler = vi.fn(async () => ({ success: false, error: 'opaque fixture failure' }))
        const buildSkillHandler = vi.fn(async () => ({ success: true, output: 'must never execute' }))
        registry.register({ ...originalHealth, handler: healthHandler })
        registry.register({ ...originalBuildSkill, handler: buildSkillHandler })
        const root = join(process.cwd(), '.nova-data', 'typed-failure-escalation-native')
        const previousDoctor = getFailureResearchCoordinator()
        const previousStore = getToolFailureEscalationStore()
        const previousContinuity = getSessionContinuityStore()
        const doctor = new FailureResearchCoordinator(join(root, 'doctor.json'))
        const store = new ToolFailureEscalationStore(join(root, 'escalations.json'))
        const continuity = new SessionContinuityStore(join(root, 'continuity.json'))
        setFailureResearchCoordinator(doctor)
        setToolFailureEscalationStore(store)
        setSessionContinuityStore(continuity)
        const contract: TaskContract = {
            id: 'doctor-typed-unknown-escalation', version: 1, goal: 'Collect current health evidence', createdAt: new Date().toISOString(),
            expectedArtifacts: [], requiredTests: [],
            successCriteria: [{ id: 'evidence', kind: 'verified_tool', required: true, description: 'Verified health evidence' }],
            allowedChanges: { readOnly: true, allowedPaths: [], allowedTools: ['health_status'], externalSideEffects: false },
            budget: { timeoutMs: 15_000, maxToolCalls: 1, maxOutputTokens: 500 }, approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
        }
        const complete = vi.fn(async () => ({
            content: '', toolCalls: [{ name: 'health_status', arguments: {} }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        }))
        try {
            await withOutcomeLedger(new OutcomeLedger(join(root, 'ledger')), async () => {
                const result = await createResearchWorker(() => true, { modelId: 'scripted-fixture', complete })
                    .execute({ contract, content: contract.goal, caseId: 'unknown-escalation', signal: new AbortController().signal, purpose: 'research' })
                expect(result.output).toContain('Doctor-Diagnose')
                expect(complete).toHaveBeenCalledTimes(1)
                expect(healthHandler).toHaveBeenCalledTimes(1)
                expect(buildSkillHandler).not.toHaveBeenCalled()
                expect(store.list()).toHaveLength(1)
                expect(store.list()[0]).toMatchObject({ classification: 'unknown', state: 'doctor-queued' })
                expect(doctor.list()).toHaveLength(1)
                expect(new ToolFailureEscalationStore(join(root, 'escalations.json')).list()).toHaveLength(1)
            })
        } finally {
            registry.register(originalHealth)
            registry.register(originalBuildSkill)
            setFailureResearchCoordinator(previousDoctor)
            setToolFailureEscalationStore(previousStore)
            setSessionContinuityStore(previousContinuity)
        }
    }, 30_000)

    it('cannot read a file outside the exact candidate profile through the native tool executor', async () => {
        const registry = getToolRegistry(), original = registry.get('read_file')!
        const handler = vi.fn(async () => ({ success: true, output: 'must never be read' }))
        registry.register({ ...original, handler })
        const contract: TaskContract = {
            id: 'doctor-candidate-outside-path', version: 1, goal: 'Read the approved candidate source', createdAt: new Date().toISOString(),
            expectedArtifacts: [], requiredTests: [],
            successCriteria: [{ id: 'evidence', kind: 'verified_tool', required: true, description: 'Approved source only' }],
            allowedChanges: { readOnly: true, allowedPaths: [join(process.cwd(), 'src/approved.ts')], allowedTools: ['read_file'], externalSideEffects: false },
            budget: { timeoutMs: 15_000, maxToolCalls: 1, maxOutputTokens: 500 }, approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
        }
        let turns = 0
        const llm = { modelId: 'scripted-fixture', complete: async () => ++turns === 1
            ? { content: '', toolCalls: [{ name: 'read_file', arguments: { path: join(process.cwd(), 'src/unapproved.ts') } }] }
            : { content: '{"blocked":"read refused"}' } }
        try {
            await withOutcomeLedger(new OutcomeLedger(join(process.cwd(), '.nova-data', 'candidate-path-ledger')), async () => {
                const worker = createResearchWorker(() => true, llm)
                await worker.execute({ contract, content: contract.goal, caseId: 'path-check', signal: new AbortController().signal, purpose: 'candidate' })
                expect(turns).toBeGreaterThan(0) // Reach the policy gate, not an earlier budget rejection.
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
                    expect(turns).toBeGreaterThan(0)
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
        const llm = { modelId: 'scripted-fixture', complete: vi.fn(async () => ({
            ...( ++turns === 1
                ? { content: '', toolCalls: [{ name: 'health_status', arguments: {} }] }
                : { content: 'Die aktuelle Probe meldet degraded und ein fehlendes Antwortfeld. Keine Reparatur durchgeführt.' }),
            usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, // Explicit synthetic fixture usage.
        })) }
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
