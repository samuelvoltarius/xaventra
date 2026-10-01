import { getNovaLearningDir } from '../core/data-root.js'
import { createLearningEngine, type LearningEngine } from './engine.js'
import { getProcedureStore, migrateLegacyProcedures, type ProcedureStore } from './procedure-store.js'
import { sideEffectsDisabled } from '../core/side-effects.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { TaskValidationReport } from '../core/task-contract.js'

const MEMORY_ELIGIBLE_TOOLS = new Set([
    'health_status', 'service_status', 'mesh_scan', 'quick_scan', 'nova_introspect',
    'mesh_status', 'mesh_nodes', 'self_setup_status',
])

function summarizeVerifiedResult(toolName: string, result: unknown): string | null {
    if (!MEMORY_ELIGIBLE_TOOLS.has(toolName)) return null
    let body = ''
    if (typeof result === 'string') body = result
    else if (result && typeof result === 'object') {
        const safeEntries = Object.entries(result as Record<string, unknown>)
            .filter(([key]) => !/(?:token|secret|password|api.?key|credential|private)/i.test(key))
            .slice(0, 12)
            .map(([key, value]) => {
                const rendered = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                    ? String(value)
                    : Array.isArray(value) ? value.slice(0, 6).map(String).join(', ') : '[structured]'
                return `${key}=${rendered}`
            })
        body = safeEntries.join('; ')
    }
    body = redactSecrets(body).replace(/\s+/g, ' ').trim().slice(0, 500)
    if (body.length < 10 || body.includes('[REDACTED')) return null
    return `Verifiziertes Ergebnis von ${toolName}: ${body}`
}

export interface VerifiedToolOutcome {
    userId?: string
    runId?: string
    toolName: string
    request: string
    params: Record<string, unknown>
    result: unknown
    success: boolean
    verified: true
    timestamp?: number
}

export interface ValidatedRunOutcome {
    runId: string
    userId: string
    request: string
    taskType: string
    tools: Array<{ toolName: string; params?: Record<string, unknown>; success: boolean }>
    model?: string
    node?: string
    success: boolean
    validated: true
    durationMs: number
    costUsd: number
    channel?: string
    validation: TaskValidationReport
}

export interface InvalidatedRunOutcome {
    runId: string
    userId: string
    request: string
    taskType: string
    reason: string
}

export class LearningCoordinator {
    private engine: LearningEngine
    private started = false
    private readonly procedures: () => ProcedureStore

    constructor(engine?: LearningEngine, dataDir = getNovaLearningDir(), procedures?: ProcedureStore) {
        this.engine = engine || createLearningEngine({ dataDir })
        this.procedures = procedures ? () => procedures : getProcedureStore
    }

    async start(): Promise<void> {
        if (this.started) return
        await this.engine.start()
        // One procedure store (P9): take over the old L17/L8/coordinator files once.
        // Never in tests/CI: the L8 files live in the real home directory.
        if (!sideEffectsDisabled()) try { migrateLegacyProcedures({ store: this.procedures() }) } catch (error) {
            console.warn(`[Learning] Prozedur-Übernahme fehlgeschlagen: ${String(error).slice(0, 160)}`)
        }
        this.started = true
    }

    async stop(): Promise<void> {
        if (!this.started) return
        await this.engine.stop()
        this.started = false
    }

    processUserMessage(message: string, context?: { channel?: string; userId?: string }) {
        return this.engine.processUserMessage(message, context)
    }

    recordBotResponse(response: string, context?: { channel?: string; userId?: string }): void {
        this.engine.recordBotResponse(response, context)
    }

    /** The only production entry point for autonomous outcome learning. */
    async recordVerifiedToolOutcome(outcome: VerifiedToolOutcome): Promise<void> {
        if (outcome.verified !== true) return

        const { recordToolExecution } = await import('../layers/L7-tool-learning.js')
        await recordToolExecution(
            outcome.toolName,
            outcome.request,
            outcome.params,
            outcome.result,
            outcome.success,
            outcome.userId,
        )

        // A single non-throwing call is an observation, not a learned
        // procedure: the one procedure store remembers a solution only after
        // the same tool/parameter shape produced verified evidence twice.
        this.procedures().recordVerifiedOutcome(outcome)

        if (outcome.success) {
            const memoryStatement = summarizeVerifiedResult(outcome.toolName, outcome.result)
            if (memoryStatement) {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                await getMemoryGovernanceCoordinator().record({
                    content: memoryStatement,
                    kind: 'operational',
                    scope: 'global',
                    source: `tool:${outcome.toolName}`,
                    evidence: 'verified_tool_result',
                    confidence: 1,
                    timestamp: outcome.timestamp,
                    toolName: outcome.toolName,
                    verified: true,
                    ttlMs: 30 * 60_000,
                })
            }
        }
    }

    /** Converts a validator-approved Outcome Ledger run into durable episodic
     * memory. Parameter values and tool outputs are never copied. */
    async recordValidatedRun(outcome: ValidatedRunOutcome): Promise<void> {
        if (outcome.validated !== true || outcome.tools.length === 0) return
        const evidenceRefs = outcome.validation.criteria.flatMap(criterion => criterion.success
            ? criterion.evidence
            : [`validator-rejection:${criterion.criterionId}`])
        try {
            const { getOutcomeRouter } = await import('../routing/outcome-router.js')
            getOutcomeRouter().recordValidatedSample({
                runId: outcome.runId,
                userId: outcome.userId,
                channel: outcome.channel,
                taskType: outcome.taskType,
                model: outcome.model,
                node: outcome.node,
                success: outcome.success,
                durationMs: outcome.durationMs,
                costUsd: outcome.costUsd,
                validatedAt: outcome.validation.validatedAt,
                validationSource: outcome.validation.validator,
                evidenceRefs,
            })
        } catch { /* routing samples are derived, non-critical projections */ }
        const { getWorkflowEpisodeStore } = await import('../memory/workflow-episode-store.js')
        const episode = getWorkflowEpisodeStore().record({
            runId: outcome.runId, userId: outcome.userId, requestSummary: outcome.request,
            taskType: outcome.taskType,
            steps: outcome.tools.map(tool => ({ toolName: tool.toolName, parameterKeys: Object.keys(tool.params || {}).sort() })),
            model: outcome.model, node: outcome.node, success: outcome.success,
            durationMs: outcome.durationMs, costUsd: outcome.costUsd,
        })
        if (!episode) return
        // Workflow skills are learned in one place only: learning/routine-skills.ts
        // (observed by the message pipeline). The episode stays episodic memory.

        const { getBeliefStore } = await import('../core/belief-store.js')
        const route = `${outcome.model || 'unknown'}@${outcome.node || 'unknown'}`
        getBeliefStore().observe({
            userId: outcome.userId,
            subject: `workflow:${outcome.taskType}`,
            predicate: 'route-success',
            value: route,
            source: `outcome:${outcome.runId}`,
            summary: `${outcome.taskType} via ${route} ${outcome.success ? 'validated' : 'failed validation'}`,
            confidence: 1,
            supports: outcome.success,
            ttlMs: 30 * 24 * 60 * 60_000,
        })
        if (!outcome.success) {
            const { getRegressionCaseStore } = await import('./regression-case-store.js')
            getRegressionCaseStore().record({
                userId: outcome.userId, taskType: outcome.taskType, request: outcome.request,
                runId: outcome.runId, failureClass: `validator-rejected:${outcome.taskType}`,
            })
        }
    }

    /** Retract every derived learning projection when a user rejects a run.
     * The immutable Outcome Ledger remains the authority and records why. */
    async invalidateValidatedRun(outcome: InvalidatedRunOutcome): Promise<void> {
        const [{ getWorkflowEpisodeStore }, { getRoutineSkillStore }, { getBeliefStore }, { getSessionContinuityStore }] = await Promise.all([
            import('../memory/workflow-episode-store.js'),
            import('./routine-skills.js'),
            import('../core/belief-store.js'),
            import('../memory/session-summarizer.js'),
        ])
        getWorkflowEpisodeStore().retractRun(outcome.runId, outcome.userId, outcome.reason)
        getRoutineSkillStore()?.retractRun(outcome.runId)
        getBeliefStore().retractSource(`outcome:${outcome.runId}`)
        getSessionContinuityStore().retractVerifiedOutcome(outcome.userId, outcome.runId, outcome.request)
        try {
            const { getOutcomeRouter } = await import('../routing/outcome-router.js')
            getOutcomeRouter().invalidateValidatedSample(outcome.runId, outcome.userId, outcome.reason)
        } catch { /* derived routing projection is reconciled on the next run */ }
    }

    getStats() {
        const procedures = this.procedures().getStats()
        return {
            ...this.engine.getStats(),
            procedures: procedures.procedures,
            verifiedProcedures: procedures.verifiedProcedures,
            reusableProcedures: procedures.reusableProcedures,
        }
    }
}

let coordinator: LearningCoordinator | null = null

export function getLearningCoordinator(): LearningCoordinator {
    if (!coordinator) coordinator = new LearningCoordinator()
    return coordinator
}

export function setLearningCoordinator(next: LearningCoordinator): void {
    coordinator = next
}
