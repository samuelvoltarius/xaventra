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
    private readonly worker: FocusedWorker
    private readonly verifiedTools = new Set<string>()
    private readonly artifacts = new Set<string>()

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
        this.worker = new FocusedWorker(plan)
        this.contract = contractOrOverrides && 'version' in contractOrOverrides
            ? contractOrOverrides
            : createTaskContract(taskContext, plan.intent, plan.allowedTools, {
                ...contractOrOverrides,
                budget: {
                    ...this.cognition.executionBudget,
                    ...(contractOrOverrides?.budget || {}),
                },
            })
        recordExecutionStage({ stage: 'contract.created', success: true, intent: this.intent.kind })
    }

    selectWorkerTools() {
        return this.worker.getTools()
    }

    verify(toolName: string, result: unknown): ValidationResult {
        const validation = validateToolOutcome(toolName, result, this.intent)
        this.lifecycle.record(toolName, validation.success)
        if (validation.success) {
            this.verifiedTools.add(toolName)
            for (const artifact of validation.evidence) this.artifacts.add(artifact)
        }
        recordExecutionStage({ stage: 'tool.validated', success: validation.success, intent: this.intent.kind })
        recordToolEvidence({ tool: toolName, verified: validation.success, source: 'execution-kernel' })
        return validation
    }

    validateCompletion(response: string, evidence: Omit<CompletionEvidence, 'response' | 'verifiedTools' | 'artifacts'> = {}): TaskValidationReport {
        const report = validateTaskCompletion(this.contract, {
            ...evidence,
            response,
            verifiedTools: [...this.verifiedTools],
            artifacts: [...this.artifacts],
            awaitingApproval: evidence.awaitingApproval ?? this.lifecycle.isAwaitingApproval(),
        })
        recordExecutionStage({ stage: 'completion.validated', success: report.success, intent: this.intent.kind })
        return report
    }
}
