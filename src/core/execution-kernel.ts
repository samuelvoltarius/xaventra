import type { ActionIntent } from './action-intent.js'
import { ActionLifecycle } from './action-lifecycle.js'
import { validateToolOutcome, type ValidationResult } from './result-validator.js'
import { IntentDispatcher } from './intent-dispatcher.js'
import { FocusedWorker } from './focused-worker.js'
import { recordExecutionStage, recordToolEvidence } from '../infra/telemetry.js'
import {
    createTaskContract,
    validateTaskCompletion,
    type CompletionEvidence,
    type TaskContract,
    type TaskContractOverrides,
    type TaskValidationReport,
} from './task-contract.js'
import { assessExecutionPreflight, type ExecutionPreflightAssessment } from './execution-preflight.js'
import { deliberateExecution, type DeliberationResult } from './deliberative-planner.js'
import { resolveAutonomyLevel, type AutonomyDecision } from './autonomy-ladder.js'
import { selectContextPolicy, type ContextPolicy } from './context-policy.js'
import { InferenceBudget } from './inference-budget.js'
import { evidenceHash, matchedToolTargets, type VerifiedToolCallEvidence } from './tool-evidence-binding.js'

/** Single runtime contract between dispatcher, worker, validator and learning.
 * Legacy layers may observe it, but they no longer decide task completion. */
export class ExecutionKernel {
    readonly intent: ActionIntent
    readonly contract: TaskContract
    readonly lifecycle = new ActionLifecycle()
    readonly preflight: ExecutionPreflightAssessment
    readonly deliberation: DeliberationResult
    readonly autonomy: AutonomyDecision
    readonly cognition: ContextPolicy
    readonly inference: InferenceBudget
    private readonly worker: FocusedWorker
    private readonly verifiedTools = new Set<string>()
    private readonly verifiedToolCalls = new Map<string, VerifiedToolCallEvidence>()
    private readonly artifacts = new Set<string>()
    private readonly startedAt = Date.now()
    private toolAttempts = 0

    constructor(
        readonly taskContext: string,
        contractOrOverrides?: TaskContract | TaskContractOverrides,
        routingContext = taskContext,
    ) {
        const plan = new IntentDispatcher().dispatch(taskContext, routingContext)
        this.cognition = selectContextPolicy(taskContext)
        this.intent = plan.intent
        this.preflight = assessExecutionPreflight(taskContext, plan.intent, plan.allowedTools)
        this.deliberation = deliberateExecution(this.preflight)
        this.autonomy = resolveAutonomyLevel({ preflight: this.preflight })
        this.contract = contractOrOverrides && 'version' in contractOrOverrides
            ? contractOrOverrides
            : createTaskContract(taskContext, plan.intent, plan.allowedTools, {
                ...contractOrOverrides,
                budget: {
                    ...this.cognition.executionBudget,
                    ...(contractOrOverrides?.budget || {}),
                },
            })
        this.inference = new InferenceBudget(this.contract.budget)
        // A complete contract is the outer orchestrator's binding tool plan.
        // Reapplying keyword selection here can silently erase its required
        // diagnostic tools during a JSON/code-only follow-up. This is not an
        // authorization grant: registry roles, lifecycle gates and budgets still
        // govern every call. Partial overrides continue to narrow the dispatcher.
        this.worker = new FocusedWorker(contractOrOverrides && 'version' in contractOrOverrides
            ? { ...plan, allowedTools: Object.freeze([...this.contract.allowedChanges.allowedTools]) }
            : plan)
        recordExecutionStage({ stage: 'contract.created', success: true, intent: this.intent.kind })
    }

    selectWorkerTools() {
        const allowed = new Set(this.contract.allowedChanges.allowedTools)
        return this.worker.getTools().filter(tool => allowed.has(tool.name))
    }

    /** Gate every execution path before effects, including recovery and retries.
     * Post-validation alone cannot undo work performed beyond its budget. */
    assertCanExecute(toolName: string): void {
        this.inference.assertCanExecute()
        if (!this.contract.allowedChanges.allowedTools.includes(toolName)) throw new Error(`Tool outside task contract: ${toolName}`)
        if (Date.now() - this.startedAt >= this.contract.budget.timeoutMs) throw new Error('Task execution deadline exceeded')
        if (this.toolAttempts >= this.contract.budget.maxToolCalls) throw new Error('Task tool-call budget exhausted')
        this.toolAttempts++
    }

    verify(toolName: string, result: unknown, invocation?: { callId: string; arguments: Record<string, unknown> }): ValidationResult {
        const validation = validateToolOutcome(toolName, result, this.intent)
        if (validation.success && (!invocation?.callId || this.verifiedToolCalls.has(invocation.callId))) {
            return { success: false, evidence: [], reason: invocation?.callId ? 'duplicate tool call evidence id' : 'tool result lacks execution correlation' }
        }
        this.lifecycle.record(toolName, validation.success)
        if (validation.success) {
            this.verifiedTools.add(toolName)
            this.verifiedToolCalls.set(invocation!.callId, {
                callId: invocation!.callId,
                toolName,
                argumentsHash: evidenceHash(invocation!.arguments),
                resultHash: evidenceHash(result),
                matchedTargets: matchedToolTargets(this.contract.requiredToolTargets || [], invocation!.arguments),
            })
            for (const artifact of validation.evidence) this.artifacts.add(artifact)
        }
        recordExecutionStage({ stage: 'tool.validated', success: validation.success, intent: this.intent.kind })
        recordToolEvidence({ tool: toolName, verified: validation.success, source: 'execution-kernel' })
        return validation
    }

    validateCompletion(response: string, evidence: Omit<CompletionEvidence, 'response' | 'verifiedTools' | 'verifiedToolCalls' | 'artifacts'> = {}): TaskValidationReport {
        const report = validateTaskCompletion(this.contract, {
            ...evidence,
            ...(this.inference.snapshot().calls ? this.inference.evidence() : {}),
            response,
            verifiedTools: [...this.verifiedTools],
            verifiedToolCalls: [...this.verifiedToolCalls.values()],
            artifacts: [...this.artifacts],
            awaitingApproval: evidence.awaitingApproval ?? this.lifecycle.isAwaitingApproval(),
        })
        recordExecutionStage({ stage: 'completion.validated', success: report.success, intent: this.intent.kind })
        return report
    }
}
