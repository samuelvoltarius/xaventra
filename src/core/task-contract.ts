import { randomUUID } from 'node:crypto'
import type { ActionIntent } from './action-intent.js'

export type TaskArtifactKind = 'file' | 'image' | 'message' | 'service' | 'report' | 'other'
export type SuccessCriterionKind = 'response_present' | 'verified_tool' | 'artifact_present' | 'test_passed' | 'approval_granted'

export interface ArtifactRequirement {
    id: string
    kind: TaskArtifactKind
    description: string
    required: boolean
}

export interface SuccessCriterion {
    id: string
    kind: SuccessCriterionKind
    description: string
    required: boolean
    testId?: string
}

export interface TestRequirement {
    id: string
    command?: string
    description: string
    required: boolean
}

export interface ChangeScope {
    readOnly: boolean
    allowedPaths: string[]
    allowedTools: string[]
    externalSideEffects: boolean
}

export interface TaskBudget {
    timeoutMs: number
    maxToolCalls: number
    maxTokens?: number
    maxCostUsd?: number
}

export interface ApprovalPolicy {
    mode: 'none' | 'risky_tools' | 'all_changes'
    patchGateRequired: boolean
}

export interface TaskContract {
    id: string
    version: 1
    goal: string
    expectedArtifacts: ArtifactRequirement[]
    successCriteria: SuccessCriterion[]
    allowedChanges: ChangeScope
    budget: TaskBudget
    requiredTests: TestRequirement[]
    approvalPolicy: ApprovalPolicy
    createdAt: string
}

export interface TaskContractOverrides {
    id?: string
    expectedArtifacts?: ArtifactRequirement[]
    successCriteria?: SuccessCriterion[]
    allowedChanges?: Partial<ChangeScope>
    budget?: Partial<TaskBudget>
    requiredTests?: TestRequirement[]
    approvalPolicy?: Partial<ApprovalPolicy>
}

export interface CriterionResult {
    criterionId: string
    success: boolean
    evidence: string[]
    reason?: string
}

export interface TaskValidationReport {
    validator: 'nova-execution-kernel'
    validatedAt: string
    success: boolean
    awaitingApproval: boolean
    criteria: CriterionResult[]
    violations: string[]
}

export interface CompletionEvidence {
    response?: string
    verifiedTools?: string[]
    artifacts?: string[]
    passedTests?: string[]
    approvalGranted?: boolean
    durationMs?: number
    toolCalls?: number
    tokens?: number
    costUsd?: number
    changedPaths?: string[]
    awaitingApproval?: boolean
    policyBlocked?: boolean
}

const DEFAULT_BUDGET: TaskBudget = {
    timeoutMs: 180_000,
    maxToolCalls: 24,
}

/** Builds the binding contract before execution. Caller overrides can only
 * narrow or explicitly extend the generated contract. */
export function createTaskContract(
    goal: string,
    intent: ActionIntent,
    allowedTools: readonly string[] = [],
    overrides: TaskContractOverrides = {},
): TaskContract {
    const expectedArtifacts: ArtifactRequirement[] = []
    if (intent.kind === 'image-generation' || intent.kind === 'screenshot') {
        expectedArtifacts.push({
            id: 'primary-artifact',
            kind: 'image',
            description: 'A transferable image file or URL produced by an executed tool',
            required: true,
        })
    }

    const successCriteria: SuccessCriterion[] = intent.requiresTool
        ? [{
            id: 'verified-action',
            kind: 'verified_tool',
            description: 'At least one executing tool returned independently validated evidence',
            required: true,
        }]
        : [{
            id: 'response-present',
            kind: 'response_present',
            description: 'A non-empty response was produced',
            required: true,
        }]

    if (expectedArtifacts.length > 0) {
        successCriteria.push({
            id: 'required-artifact',
            kind: 'artifact_present',
            description: 'The required artifact is present in verified tool evidence',
            required: true,
        })
    }

    return {
        id: overrides.id || randomUUID(),
        version: 1,
        goal: goal.trim(),
        expectedArtifacts: overrides.expectedArtifacts || expectedArtifacts,
        successCriteria: overrides.successCriteria || successCriteria,
        allowedChanges: {
            readOnly: !intent.requiresTool,
            allowedPaths: [],
            allowedTools: [...allowedTools],
            externalSideEffects: intent.requiresTool,
            ...overrides.allowedChanges,
        },
        budget: { ...DEFAULT_BUDGET, ...overrides.budget },
        requiredTests: overrides.requiredTests || [],
        approvalPolicy: {
            mode: intent.requiresTool ? 'risky_tools' : 'none',
            patchGateRequired: true,
            ...overrides.approvalPolicy,
        },
        createdAt: new Date().toISOString(),
    }
}

export function validateTaskCompletion(contract: TaskContract, evidence: CompletionEvidence): TaskValidationReport {
    const verifiedTools = evidence.verifiedTools || []
    const artifacts = evidence.artifacts || []
    const passedTests = new Set(evidence.passedTests || [])
    const criteria = contract.successCriteria.map<CriterionResult>(criterion => {
        switch (criterion.kind) {
            case 'response_present': {
                const success = Boolean(evidence.response?.trim())
                return { criterionId: criterion.id, success, evidence: success ? ['response'] : [], reason: success ? undefined : 'response is empty' }
            }
            case 'verified_tool': {
                const success = verifiedTools.length > 0
                return { criterionId: criterion.id, success, evidence: verifiedTools, reason: success ? undefined : 'no executing tool result was verified' }
            }
            case 'artifact_present': {
                const success = artifacts.length > 0
                return { criterionId: criterion.id, success, evidence: artifacts, reason: success ? undefined : 'required artifact is missing' }
            }
            case 'test_passed': {
                const success = Boolean(criterion.testId && passedTests.has(criterion.testId))
                return { criterionId: criterion.id, success, evidence: success && criterion.testId ? [criterion.testId] : [], reason: success ? undefined : 'required test did not pass' }
            }
            case 'approval_granted': {
                const success = evidence.approvalGranted === true
                return { criterionId: criterion.id, success, evidence: success ? ['operator-approval'] : [], reason: success ? undefined : 'required approval is pending' }
            }
        }
    })

    for (const test of contract.requiredTests) {
        if (!contract.successCriteria.some(criterion => criterion.kind === 'test_passed' && criterion.testId === test.id)) {
            const success = passedTests.has(test.id)
            criteria.push({
                criterionId: `test:${test.id}`,
                success,
                evidence: success ? [test.id] : [],
                reason: success ? undefined : `required test "${test.description}" did not pass`,
            })
        }
    }

    const violations: string[] = []
    if (evidence.policyBlocked) violations.push('execution stopped by policy')
    if (typeof evidence.durationMs === 'number' && evidence.durationMs > contract.budget.timeoutMs) violations.push('timeout budget exceeded')
    if (typeof evidence.toolCalls === 'number' && evidence.toolCalls > contract.budget.maxToolCalls) violations.push('tool-call budget exceeded')
    if (contract.budget.maxTokens !== undefined && (evidence.tokens || 0) > contract.budget.maxTokens) violations.push('token budget exceeded')
    if (contract.budget.maxCostUsd !== undefined && (evidence.costUsd || 0) > contract.budget.maxCostUsd) violations.push('cost budget exceeded')

    const changedPaths = evidence.changedPaths || []
    if (contract.allowedChanges.readOnly && changedPaths.length > 0) violations.push('read-only task changed files')
    if (contract.allowedChanges.allowedPaths.length > 0) {
        const outsideScope = changedPaths.filter(path => !contract.allowedChanges.allowedPaths.some(prefix => path.startsWith(prefix)))
        if (outsideScope.length > 0) violations.push(`changes outside allowed scope: ${outsideScope.join(', ')}`)
    }

    const requiredIds = new Set(contract.successCriteria.filter(item => item.required).map(item => item.id))
    const success = violations.length === 0
        && criteria.filter(item => requiredIds.has(item.criterionId) || item.criterionId.startsWith('test:')).every(item => item.success)
        && !evidence.awaitingApproval

    return {
        validator: 'nova-execution-kernel',
        validatedAt: new Date().toISOString(),
        success,
        awaitingApproval: evidence.awaitingApproval === true,
        criteria,
        violations,
    }
}
