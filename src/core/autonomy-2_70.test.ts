import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GoalManager } from './goal-manager.js'
import { BeliefStore } from './belief-store.js'
import { CausalMemory } from './causal-memory.js'
import { deliberateExecution } from './deliberative-planner.js'
import { resolveAutonomyLevel } from './autonomy-ladder.js'
import { OperationalEventBus } from './operational-event-bus.js'
import { PersonalSkillCompiler } from '../learning/personal-skill-compiler.js'
import { RegressionCaseStore } from '../learning/regression-case-store.js'
import { FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { findVerifiedSolutionContradictions, hasVerifiedCriticalDream } from '../layers/subconscious-reflector.js'
import type { WorkflowEpisode } from '../memory/workflow-episode-store.js'

function root(name: string) { return mkdtempSync(join(tmpdir(), `${name}-`)) }
const safePreflight = {
    version: 1 as const, profile: 'safe_auto' as const, riskScore: 20, impact: 'local' as const,
    reversible: true, reasons: [], prerequisites: [], requiredEvidence: ['verified tool receipt'],
}

describe('Nova 2.70 closed-loop autonomy', () => {
    it('persists a dependency-aware goal graph and selects only ready work', () => {
        const manager = new GoalManager(join(root('nova-goals'), 'goals.json'))
        const plan = manager.createMissionPlan({
            missionId: 'mission-1', userId: 'sample', goal: 'Rollout abschließen',
            steps: [{ title: 'Build', nextAction: 'build' }, { title: 'Deploy', nextAction: 'deploy' }],
        })
        expect(manager.next('sample')?.title).toBe('Build')
        manager.update(plan.steps[0].id, { status: 'completed' }, { runId: 'run-1', ref: 'outcome:run-1' })
        expect(manager.next('sample')?.title).toBe('Deploy')
        manager.update(plan.steps[1].id, { status: 'completed' }, { runId: 'run-2', ref: 'outcome:run-2' })
        expect(manager.list('sample').find(goal => goal.id === plan.root.id)?.status).toBe('completed')
    })

    it('keeps supporting and counter evidence and marks disputed beliefs', () => {
        const store = new BeliefStore(join(root('nova-beliefs'), 'beliefs.json'))
        const supported = store.observe({ userId: 'sample', subject: 'spark', predicate: 'main', value: 'yes', source: 'outcome:1', summary: 'lease verified', confidence: 1 })
        const disputed = store.observe({ userId: 'sample', subject: 'spark', predicate: 'main', value: 'no', source: 'outcome:2', summary: 'counter evidence', confidence: 1, supports: false })
        expect(disputed.id).toBe(supported.id)
        expect(disputed.status).toBe('disputed')
        expect(store.unresolved('sample')).toHaveLength(1)
    })

    it('stores a verified temporal chain with navigable causes and effects', () => {
        const memory = new CausalMemory(join(root('nova-causal'), 'causal.json'))
        const events = memory.recordChain({ userId: 'sample', runId: 'run-1', events: [
            { kind: 'failure', summary: 'vLLM stopped' }, { kind: 'fallback', summary: 'fallback selected' }, { kind: 'latency', summary: 'reply slower' },
        ] })
        expect(memory.trace(events[1].id).causes[0].summary).toBe('vLLM stopped')
        expect(memory.trace(events[1].id).effects[0].summary).toBe('reply slower')
    })

    it('selects direct, sandbox or approval plans from risk and reversibility', () => {
        expect(deliberateExecution(safePreflight).selected.id).toBe('direct')
        expect(deliberateExecution({ ...safePreflight, riskScore: 50, reversible: false }).selected.id).toBe('sandbox')
        expect(deliberateExecution({ ...safePreflight, profile: 'approval_required', impact: 'critical', riskScore: 90 }).selected.id).toBe('approval')
    })

    it('allows trusted workflows only after activation and validated samples', () => {
        expect(resolveAutonomyLevel({ preflight: safePreflight, skillStatus: 'active', validatedSamples: 3 }).level).toBe('trusted-workflow')
        expect(resolveAutonomyLevel({ preflight: { ...safePreflight, profile: 'approval_required', impact: 'critical' }, skillStatus: 'active', validatedSamples: 99 }).mayExecute).toBe(false)
    })

    it('matures skills through every evidence gate and degrades on failure', () => {
        const compiler = new PersonalSkillCompiler(join(root('nova-skills'), 'skills.json'))
        const episode = (runId: string): WorkflowEpisode => ({
            id: runId, runId, userId: 'sample', requestSummary: 'Status prüfen', taskType: 'system-state',
            steps: [{ toolName: 'health_status', parameterKeys: [] }], success: true, durationMs: 10, costUsd: 0,
            evidenceRef: `outcome:${runId}`, createdAt: new Date().toISOString(),
        })
        compiler.observe(episode('1')); compiler.observe(episode('2')); const proposed = compiler.observe(episode('3'))
        expect(proposed.status).toBe('proposed')
        expect(compiler.advance(proposed.id, 'sandbox-tested', 'test:sandbox')?.status).toBe('sandbox-tested')
        expect(compiler.advance(proposed.id, 'benchmark-passed', 'benchmark:100')?.status).toBe('benchmark-passed')
        expect(compiler.advance(proposed.id, 'canary-tested', 'canary:spark')?.status).toBe('canary-tested')
        expect(compiler.advance(proposed.id, 'approved', 'user:owner', { operatorApproved: true })?.status).toBe('approved')
        expect(compiler.advance(proposed.id, 'active', 'user:owner', { operatorApproved: true })?.status).toBe('active')
        expect(compiler.recordRuntimeOutcome(proposed.id, false, 'failed-run')?.status).toBe('degraded')
    })

    it('suppresses unverified generic initiative and accepts trusted operational evidence', () => {
        const bus = new OperationalEventBus(join(root('nova-events'), 'events.json'))
        expect(bus.ingest({ source: 'dream-reflector', summary: 'maybe something', severity: 'warning', confidence: 0.9 }).actionable).toBe(false)
        expect(bus.ingest({ source: 'health-monitor', summary: 'disk critical', severity: 'critical', confidence: 0.99 }).actionable).toBe(true)
    })

    it('quarantines failures before turning them into permanent tests', () => {
        const store = new RegressionCaseStore(join(root('nova-regression'), 'cases.json'))
        const item = store.record({ userId: 'sample', taskType: 'tool', request: 'do it', runId: 'r1', failureClass: 'validator-rejected' })
        expect(item.status).toBe('quarantined')
        expect(store.promote(item.id, 'conversation:not-a-test')).toBeNull()
        expect(store.promote(item.id, 'test:isolated')?.status).toBe('promoted')
        expect(store.resolve(item.id, 'benchmark:passed')?.status).toBe('resolved')
    })

    it('forces Doctor research through sandbox, regression, rollback and PATCH_GATE', () => {
        const coordinator = new FailureResearchCoordinator(join(root('nova-research'), 'research.json'))
        const item = coordinator.ingest({
            id: 'doctor-1', title: 'Runtime broken', detail: 'binding failed', category: 'health', severity: 'critical', source: 'doctor', recommendation: 'repair binding', evidence: {}, status: 'open', createdAt: '', updatedAt: '',
        })
        for (const [stage, evidence] of [
            ['researching', 'source:docs'], ['repair-proposed', 'patch:1'], ['sandbox-passed', 'test:sandbox'],
            ['regression-passed', 'test:regression'], ['rollback-passed', 'test:rollback'], ['awaiting-patch-gate', 'patch:queued'],
        ] as const) expect(coordinator.advance(item.id, stage, evidence)?.stage).toBe(stage)
        expect(coordinator.advance(item.id, 'approved', 'user:owner')).toBeNull()
        expect(coordinator.advance(item.id, 'approved', 'user:owner', { patchGateApproved: true })?.stage).toBe('approved')
    })

    it('does not call similar wording a contradiction or send generic dreams', () => {
        expect(findVerifiedSolutionContradictions([
            { problem: 'mach einen self check', solution: 'x' }, { problem: 'mach mal einen self check', solution: 'y' },
        ])).toEqual([])
        expect(hasVerifiedCriticalDream({ insights: [], contradictions: [], toolPatterns: [] })).toBe(false)
    })
})
