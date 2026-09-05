import { getNovaLearningDir } from '../core/data-root.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { createLearningEngine, type LearningEngine } from './engine.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    private verifiedProcedureRuns = new Map<string, number>()
    private readonly procedurePath: string

    constructor(engine?: LearningEngine, dataDir = getNovaLearningDir()) {
        this.engine = engine || createLearningEngine({ dataDir })
        this.procedurePath = join(dataDir, 'verified-procedures.json')
        this.loadVerifiedProcedures()
    }

    private loadVerifiedProcedures(): void {
        try {
            if (!existsSync(this.procedurePath)) return
            const parsed = JSON.parse(readFileSync(this.procedurePath, 'utf8')) as {
                procedures?: Array<[string, number]>
            }
            this.verifiedProcedureRuns = new Map(
                (parsed.procedures || []).filter(([key, runs]) =>
                    typeof key === 'string' && Number.isFinite(runs) && runs >= 0),
            )
        } catch {
            this.verifiedProcedureRuns.clear()
        }
    }

    private persistVerifiedProcedures(): void {
        atomicWriteJsonSync(this.procedurePath, {
            version: 1,
            updatedAt: Date.now(),
            procedures: [...this.verifiedProcedureRuns.entries()].slice(-2_000),
        })
    }

    async start(): Promise<void> {
        if (this.started) return
        await this.engine.start()
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
        )

        // A single non-throwing call is an observation, not a learned skill.
        // Promote a procedure only after the same tool/parameter shape has
        // produced verified task evidence twice. A failure resets confidence.
        const signature = `${outcome.toolName}:${Object.keys(outcome.params).sort().join(',')}`
        const runs = outcome.success ? (this.verifiedProcedureRuns.get(signature) || 0) + 1 : 0
        this.verifiedProcedureRuns.set(signature, runs)
        this.persistVerifiedProcedures()

        if (outcome.success && runs >= 2) {
            const { getLearner } = await import('../layers/L17-autonomous-learning.js')
            getLearner().recordVerifiedOutcome(outcome)
        }

        if (outcome.success && runs >= 2) {
            const { getMetaLearningSystem } = await import('../layers/L8-meta-learning.js')
            getMetaLearningSystem().recordVerifiedOutcome(outcome.toolName, true)
        }

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
        const { getWorkflowEpisodeStore } = await import('../memory/workflow-episode-store.js')
        const episode = getWorkflowEpisodeStore().record({
            runId: outcome.runId, userId: outcome.userId, requestSummary: outcome.request,
            taskType: outcome.taskType,
            steps: outcome.tools.map(tool => ({ toolName: tool.toolName, parameterKeys: Object.keys(tool.params || {}).sort() })),
            model: outcome.model, node: outcome.node, success: outcome.success,
            durationMs: outcome.durationMs, costUsd: outcome.costUsd,
        })
        if (!episode) return
        const { getPersonalSkillCompiler } = await import('./personal-skill-compiler.js')
        const skillCompiler = getPersonalSkillCompiler()
        const skill = skillCompiler.observe(episode)
        // Runtime quality is authoritative after activation. A single failed,
        // independently validated production outcome removes the trusted skill
        // from automatic execution until it matures through the gates again.
        if (skill.status === 'active') {
            skillCompiler.recordRuntimeOutcome(skill.id, outcome.success, outcome.runId)
        }

        const [{ getBeliefStore }, { getCausalMemory }] = await Promise.all([
            import('../core/belief-store.js'),
            import('../core/causal-memory.js'),
        ])
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
        getCausalMemory().recordChain({
            userId: outcome.userId,
            runId: outcome.runId,
            events: [
                { kind: 'request', summary: `Task type ${outcome.taskType} accepted` },
                ...outcome.tools.map(tool => ({ kind: 'tool', summary: `${tool.toolName}: ${tool.success ? 'verified' : 'failed'}` })),
                { kind: 'validation', summary: outcome.success ? 'independent validator accepted outcome' : 'independent validator rejected outcome' },
            ],
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
        const [{ getWorkflowEpisodeStore }, { getPersonalSkillCompiler }, { getBeliefStore }, { getCausalMemory }, { getSessionContinuityStore }] = await Promise.all([
            import('../memory/workflow-episode-store.js'),
            import('./personal-skill-compiler.js'),
            import('../core/belief-store.js'),
            import('../core/causal-memory.js'),
            import('../memory/session-summarizer.js'),
        ])
        getWorkflowEpisodeStore().retractRun(outcome.runId, outcome.userId, outcome.reason)
        getPersonalSkillCompiler().retractRun(outcome.runId)
        getBeliefStore().retractSource(`outcome:${outcome.runId}`)
        getCausalMemory().retractRun(outcome.runId)
        getSessionContinuityStore().retractVerifiedOutcome(outcome.userId, outcome.runId, outcome.request)
    }

    getStats() {
        return {
            ...this.engine.getStats(),
            verifiedProcedures: this.verifiedProcedureRuns.size,
            reusableProcedures: [...this.verifiedProcedureRuns.values()].filter(runs => runs >= 2).length,
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
