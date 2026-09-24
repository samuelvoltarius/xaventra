import { Agent, RunState, tool, type FunctionTool, type ModelProvider } from '@openai/agents'
import type { NovaTool } from '../tools/complete-registry.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import { checkTool } from '../tools/tool-policy.js'
import { ExecutionKernel } from '../core/execution-kernel.js'
import { getOutcomeLedger, type OutcomeLedger } from '../core/outcome-ledger.js'
import {
    assertMissionFenceForContent,
    deriveToolCompensation,
    executionScopeForContent,
    getIdempotencyStore,
    getPendingExecutionRegistry,
    makeIdempotencyKey,
    missionFenceForContent,
    prepareToolCompensation,
    type IdempotencyStore,
} from '../core/execution-control.js'
import { NativeToolReceiptStore } from '../core/native-tool-receipts.js'
import {
    hydrateNativeToolCheckpoint,
    publishNativeToolCheckpoint,
    type NativeCheckpointTransport,
    type NativeTakeoverAuthority,
} from '../core/native-tool-takeover.js'
import { evidenceHash } from '../core/tool-evidence-binding.js'
import { getOutcomeRouter } from '../routing/outcome-router.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { NovaModelProvider } from './nova-model-provider.js'
import { selectContractTools } from './tool-contract-selection.js'
import { createSdkRunner } from './sdk-runtime.js'
import { estimateUsageCost } from '../core/model-pricing.js'
import type { AgentBackend, AgentBackendInput, AgentBackendResult } from './agent-backend.js'

const HIGH_RISK_TOOLS = /^(?:self_|create_skill|build_skill|write_|delete_|run_command|system_executor|ssh_|deploy|docker_|send_|mesh_delegate)/i

export interface OpenAIAgentsBackendOptions {
    modelProvider?: ModelProvider
    maxTurns?: number
    ledger?: OutcomeLedger
    idempotencyStore?: IdempotencyStore
    receiptStore?: NativeToolReceiptStore
    checkpointAuthority?: NativeTakeoverAuthority
    checkpointTransport?: NativeCheckpointTransport
}

function toolSchema(novaTool: NovaTool): Record<string, unknown> {
    const properties: Record<string, Record<string, unknown>> = {}
    const required: string[] = []
    for (const parameter of novaTool.parameters) {
        properties[parameter.name] = { type: parameter.type, description: parameter.description }
        if (parameter.required) required.push(parameter.name)
    }
    return { type: 'object', properties, required, additionalProperties: false }
}

export class OpenAIAgentsBackend implements AgentBackend {
    readonly name = 'openai-agents'
    private readonly modelProvider?: ModelProvider
    private readonly maxTurns: number
    private readonly ledger: OutcomeLedger
    private readonly idempotency: IdempotencyStore
    private readonly receipts: NativeToolReceiptStore
    private readonly checkpointAuthority?: NativeTakeoverAuthority
    private readonly checkpointTransport?: NativeCheckpointTransport

    constructor(options: OpenAIAgentsBackendOptions = {}) {
        this.modelProvider = options.modelProvider
        this.maxTurns = options.maxTurns || 12
        this.ledger = options.ledger || getOutcomeLedger()
        this.idempotency = options.idempotencyStore || getIdempotencyStore()
        this.receipts = options.receiptStore || new NativeToolReceiptStore(this.idempotency)
        this.checkpointAuthority = options.checkpointAuthority
        this.checkpointTransport = options.checkpointTransport
    }

    async run(input: AgentBackendInput): Promise<AgentBackendResult> {
        return this.execute(input)
    }

    async resume(input: AgentBackendInput, checkpoint: string): Promise<AgentBackendResult> {
        return this.execute(input, checkpoint)
    }

    async resumeWithDecision(input: AgentBackendInput, checkpoint: string, decision: 'approve' | 'reject' | 'resume', reason?: string): Promise<AgentBackendResult> {
        return this.execute(input, checkpoint, decision, reason)
    }

    private buildTools(input: AgentBackendInput, kernel: ExecutionKernel, execution: {
        scopeId: string
        principalId: string
        publishCheckpoint: () => Promise<boolean>
        persistProgress: (idempotencyKey: string) => void
        assertFence: () => Promise<void>
    }): FunctionTool[] {
        const registry = getToolRegistry()
        const selected = selectContractTools(input.contract.allowedChanges.allowedTools, input.tools ?? registry.getAll())
        const ledger = this.ledger

        return selected.map(novaTool => tool({
            name: novaTool.name,
            description: novaTool.description,
            parameters: toolSchema(novaTool) as any,
            strict: false,
            isEnabled: () => checkTool(novaTool.name, { channel: input.channel, userId: input.authUserId || input.userId }).allowed,
            needsApproval: () => {
                const policy = checkTool(novaTool.name, { channel: input.channel, userId: input.authUserId || input.userId })
                return policy.needsConfirmation
                    || input.contract.approvalPolicy.mode === 'all_changes'
                    || (input.contract.approvalPolicy.mode === 'risky_tools' && HIGH_RISK_TOOLS.test(novaTool.name))
            },
            timeoutMs: Math.min(input.contract.budget.timeoutMs, 120_000),
            timeoutBehavior: 'error_as_result',
            execute: async (params: Record<string, unknown>) => {
                const startedAt = Date.now()
                const idempotencyKey = makeIdempotencyKey(execution.scopeId, novaTool.name, params)
                const executionInputHash = evidenceHash(params)
                const policy = checkTool(novaTool.name, { channel: input.channel, userId: input.authUserId || input.userId })
                if (!policy.allowed) throw new Error(policy.reason || `Tool ${novaTool.name} is denied by Nova policy`)
                let result: unknown
                try {
                    kernel.assertCanExecute(novaTool.name)
                    await execution.assertFence()
                    const toolExecution = await this.idempotency.executeOnce({
                        key: idempotencyKey,
                        runId: execution.scopeId,
                        operation: novaTool.name,
                        inputHash: executionInputHash,
                        compensate: prepareToolCompensation(novaTool.name, params),
                        deriveCompensation: result => deriveToolCompensation(novaTool.name, params, result),
                        execute: async () => registry.get(novaTool.name)
                            ? registry.execute(novaTool.name, params)
                            : novaTool.handler(params),
                    })
                    result = toolExecution.result
                    const validation = kernel.verify(novaTool.name, result, { callId: idempotencyKey, arguments: params })
                    let checkpointPublished = true
                    if (validation.success) {
                        const evidence = kernel.getVerifiedToolCallEvidence(idempotencyKey)
                        if (!evidence) throw new Error(`Verified tool ${novaTool.name} has no correlated kernel evidence`)
                        this.receipts.save({
                            scopeId: execution.scopeId,
                            principalId: execution.principalId,
                            channel: input.channel,
                            contract: kernel.contract,
                            idempotencyKey,
                            executionInputHash,
                            evidence,
                        })
                        execution.persistProgress(idempotencyKey)
                        checkpointPublished = await execution.publishCheckpoint()
                    }
                    ledger.recordTool(input.contract.id, {
                        toolName: novaTool.name,
                        params,
                        result,
                        validation,
                        success: validation.success,
                        idempotencyKey,
                        replayed: toolExecution.replayed,
                        checkpointPublished,
                        durationMs: Date.now() - startedAt,
                    })
                    if (!checkpointPublished) throw new Error(`Verified tool ${novaTool.name} could not publish its fenced checkpoint`)
                    return result
                } catch (error) {
                    ledger.recordTool(input.contract.id, {
                        toolName: novaTool.name,
                        params,
                        idempotencyKey,
                        success: false,
                        durationMs: Date.now() - startedAt,
                        error: redactSecrets(String(error)),
                    })
                    throw error
                }
            },
        } as any))
    }

    private async execute(input: AgentBackendInput, serializedState?: string, resumeDecision?: 'approve' | 'reject' | 'resume', rejectionReason?: string): Promise<AgentBackendResult> {
        const ledger = this.ledger
        const kernel = new ExecutionKernel(input.content, input.contract)
        const startedAt = Date.now()
        const scopeId = executionScopeForContent(input.content, input.contract.id)
        const principalId = input.userId
        const missionFence = missionFenceForContent(input.content)
        try {
            const takeover = missionFence
                ? await hydrateNativeToolCheckpoint({
                    fence: missionFence, scopeId, principalId, channel: input.channel,
                    kernel, idempotency: this.idempotency, receipts: this.receipts,
                    authority: this.checkpointAuthority, transport: this.checkpointTransport,
                })
                : null
            const rehydration = takeover?.checkpointFound
                ? takeover
                : this.receipts.rehydrate({ scopeId, principalId, channel: input.channel, kernel })
            if (rehydration.rejected.length) {
                throw new Error(`Durable tool receipt rehydration rejected: ${rehydration.rejected.map(item => item.reason).join(', ')}`)
            }
            const durableCheckpoint = ledger.loadCheckpoint(input.contract.id)
            if (serializedState && (!durableCheckpoint || durableCheckpoint.backend !== this.name
                || !durableCheckpoint.backendState || durableCheckpoint.phase === 'completed')) {
                throw new Error('SDK resume requires one unfinished durable backend checkpoint')
            }
            if (serializedState && durableCheckpoint!.completedIdempotencyKeys.length) {
                const restoredKeys = new Set(this.receipts.exportScope(scopeId).map(receipt => receipt.idempotencyKey))
                const missing = durableCheckpoint!.completedIdempotencyKeys.filter(key => !restoredKeys.has(key)
                    || this.idempotency.get(key)?.status !== 'completed')
                if (missing.length) throw new Error(`Resume checkpoint is missing ${missing.length} verified tool receipt(s)`)
            }
        } catch (error) {
            const message = redactSecrets(String(error))
            if (ledger.getRun(input.contract.id)) ledger.fail(input.contract.id, { reason: message, phase: 'receipt-rehydration' })
            return {
                runId: input.contract.id, backend: this.name, status: 'failed', output: '',
                model: input.model || 'auto', toolsUsed: [], error: message,
            }
        }
        if (!serializedState) {
            ledger.start(input.contract, { channel: input.channel, userId: input.userId, backend: this.name })
            ledger.recordPlan(input.contract.id, {
                goal: input.contract.goal,
                successCriteria: input.contract.successCriteria,
                expectedArtifacts: input.contract.expectedArtifacts,
                preflight: kernel.preflight,
                deliberation: kernel.deliberation,
                autonomy: kernel.autonomy,
            })
        }
        const baseline = { model: input.model || 'auto', node: 'local' }
        const graphCandidates = getCapabilityGraph().getSnapshot().nodes.flatMap(node => node.runtimes.flatMap(runtime =>
            runtime.models.map(model => ({ model, node: node.id }))))
        const shadow = getOutcomeRouter().decide(kernel.intent.kind || 'agent', baseline, graphCandidates, { userId: input.userId, channel: input.channel })
        ledger.recordRoute(input.contract.id, {
            backend: this.name, model: baseline.model, node: baseline.node,
            taskType: kernel.intent.kind || 'agent',
            reason: 'configured Nova agent backend', shadowRecommendation: shadow.recommended,
            shadowConfidence: shadow.confidence, routerMode: shadow.mode,
        } as any)

        const persistProgress = (idempotencyKey: string) => {
            const previous = ledger.loadCheckpoint(input.contract.id)
            ledger.saveCheckpoint({
                runId: input.contract.id,
                backend: this.name,
                backendState: previous?.backendState,
                phase: previous?.phase === 'awaiting_approval' ? previous.phase : 'tool-verified',
                pendingActions: previous?.pendingActions || [],
                completedIdempotencyKeys: [...new Set([...(previous?.completedIdempotencyKeys || []), idempotencyKey])],
                ownerNode: previous?.ownerNode,
                leaseEpoch: missionFence?.epoch || previous?.leaseEpoch,
                resumeInput: previous?.resumeInput || {
                    userId: input.userId, authUserId: input.authUserId, channel: input.channel,
                    content: input.content, systemPrompt: input.systemPrompt, model: input.model,
                    contract: input.contract,
                },
            })
        }
        const publishCheckpoint = async () => missionFence
            ? publishNativeToolCheckpoint({
                fence: missionFence, scopeId, principalId, channel: input.channel,
                kernel, idempotency: this.idempotency, receipts: this.receipts,
                authority: this.checkpointAuthority, transport: this.checkpointTransport,
            })
            : true
        const assertFence = async () => {
            if (missionFence && this.checkpointAuthority) await this.checkpointAuthority.assertCurrent(missionFence)
            else await assertMissionFenceForContent(input.content)
        }

        const agent = new Agent({
            name: 'Nova',
            instructions: input.systemPrompt || 'Du bist Nova. Führe den verbindlichen TaskContract aus. Behaupte niemals eine Tool-Ausführung ohne verifiziertes Tool-Ergebnis.',
            model: input.model || 'auto',
            tools: this.buildTools(input, kernel, { scopeId, principalId, publishCheckpoint, persistProgress, assertFence }),
        })
        const runner = createSdkRunner(this.modelProvider || new NovaModelProvider())

        try {
            const state = serializedState
                ? await RunState.fromString(agent, serializedState)
                : input.content
            if (state instanceof RunState && resumeDecision && resumeDecision !== 'resume') {
                for (const item of state.getInterruptions()) {
                    if (resumeDecision === 'approve') state.approve(item)
                    else state.reject(item, { message: rejectionReason || 'Rejected by Nova operator' })
                }
            }
            const result = await runner.run(agent, state, { maxTurns: this.maxTurns, signal: input.abortSignal })
            const interruptions = result.interruptions || []
            if (interruptions.length > 0) {
                const checkpoint = result.state.toString()
                ledger.saveCheckpoint({
                    runId: input.contract.id,
                    backend: this.name,
                    backendState: checkpoint,
                    phase: 'awaiting_approval',
                    pendingActions: interruptions.map((item: any) => item.rawItem?.name || item.tool?.name || 'tool-approval'),
                    completedIdempotencyKeys: this.receipts.exportScope(scopeId).map(receipt => receipt.idempotencyKey),
                    leaseEpoch: missionFence?.epoch,
                    resumeInput: {
                        userId: input.userId, authUserId: input.authUserId, channel: input.channel,
                        content: input.content, systemPrompt: input.systemPrompt, model: input.model,
                        contract: input.contract,
                    },
                })
                const validation = kernel.validateCompletion('', { awaitingApproval: true, durationMs: Date.now() - startedAt })
                ledger.recordValidation(input.contract.id, validation)
                const resumeWith = async (decision?: 'approve' | 'reject', reason?: string) => {
                    for (const item of result.state.getInterruptions()) {
                        if (decision === 'approve') result.state.approve(item)
                        else if (decision === 'reject') result.state.reject(item, { message: reason || 'Rejected by Nova operator' })
                    }
                    return this.execute(input, result.state.toString())
                }
                getPendingExecutionRegistry().register({
                    runId: input.contract.id,
                    actions: interruptions.map((item: any) => item.rawItem?.name || item.tool?.name || 'tool-approval'),
                    registeredAt: new Date().toISOString(),
                    approve: () => resumeWith('approve'),
                    reject: reason => resumeWith('reject', reason),
                    resume: () => resumeWith(),
                })
                return {
                    runId: input.contract.id,
                    backend: this.name,
                    status: 'interrupted',
                    output: 'Die Ausführung wartet auf eine Nova-Freigabe.',
                    model: input.model || 'auto',
                    toolsUsed: [],
                    interruptionCount: interruptions.length,
                    checkpoint,
                }
            }

            const output = typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput || '')
            const usage = (result.rawResponses || []).reduce((total: { inputTokens: number; outputTokens: number }, response: any) => ({
                inputTokens: total.inputTokens + Number(response?.usage?.inputTokens || response?.usage?.input_tokens || 0),
                outputTokens: total.outputTokens + Number(response?.usage?.outputTokens || response?.usage?.output_tokens || 0),
            }), { inputTokens: 0, outputTokens: 0 })
            const responseMetadata = [...(result.rawResponses || [])].reverse()
                .map((response: any) => response?.providerData || response?.response?.providerData)
                .find((value: unknown) => value && typeof value === 'object') as Record<string, unknown> | undefined
            const provider = String(responseMetadata?.provider || (this.modelProvider instanceof NovaModelProvider ? 'nova-router' : 'openai'))
            const resolvedModel = String(responseMetadata?.model || input.model || 'auto')
            const resolvedNode = String(responseMetadata?.node || 'local')
            const usageCost = estimateUsageCost({
                ...usage, provider, model: resolvedModel, durationMs: Date.now() - startedAt,
                local: responseMetadata?.local === true,
            })
            ledger.recordCost(input.contract.id, {
                ...usage, provider, model: resolvedModel, durationMs: Date.now() - startedAt,
                usd: usageCost.totalUsd, energyUsd: usageCost.energyUsd, hardwareUsd: usageCost.hardwareUsd,
                estimated: usageCost.estimated, source: usageCost.source,
            })
            const toolsUsed = result.newItems
                .map((item: any) => item.rawItem?.name || item.rawItem?.tool_name)
                .filter((name: unknown): name is string => typeof name === 'string')
            const validation = kernel.validateCompletion(output, {
                durationMs: Date.now() - startedAt,
                toolCalls: toolsUsed.length,
            })
            ledger.recordValidation(input.contract.id, validation)
            if (!validation.success) {
                const reasons = validation.criteria.filter(item => !item.success).map(item => item.reason).filter(Boolean)
                ledger.fail(input.contract.id, { reason: 'validator-rejected', reasons, durationMs: Date.now() - startedAt })
                if (input.channel !== 'benchmark' && process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
                    try {
                        const run = ledger.getRun(input.contract.id)
                        const { getLearningCoordinator } = await import('../learning/learning-coordinator.js')
                        await getLearningCoordinator().recordValidatedRun({
                            runId: input.contract.id, userId: input.userId, request: input.content,
                            taskType: kernel.intent.kind,
                            tools: (run?.tools || []).map(tool => ({
                                toolName: String(tool.toolName || tool.tool || ''),
                                params: tool.params && typeof tool.params === 'object' ? tool.params as Record<string, unknown> : {},
                                success: tool.success === true,
                            })).filter(tool => tool.toolName),
                            model: input.model || 'auto', node: 'local', success: false, validated: true,
                            durationMs: Date.now() - startedAt, costUsd: run?.totalCostUsd || 0,
                            channel: input.channel, validation,
                        })
                    } catch { /* episodic failure learning is non-critical */ }
                }
                return {
                    runId: input.contract.id,
                    backend: this.name,
                    status: 'failed',
                    output: `Nicht als abgeschlossen freigegeben: ${reasons.join('; ') || validation.violations.join('; ')}`,
                    model: input.model || 'auto',
                    toolsUsed,
                    error: 'TaskContract validation failed',
                }
            }

            if (!ledger.completeValidated(input.contract.id, { success: true, durationMs: Date.now() - startedAt, output })) {
                throw new Error('validated completion commit was rejected')
            }
            ledger.saveCheckpoint({
                runId: input.contract.id,
                backend: this.name,
                phase: 'completed',
                pendingActions: [],
                completedIdempotencyKeys: this.receipts.exportScope(scopeId).map(receipt => receipt.idempotencyKey),
                leaseEpoch: missionFence?.epoch,
                resumeInput: { userId: input.userId, channel: input.channel, contract: input.contract },
            })
            if (input.channel !== 'benchmark' && process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
                try {
                    const run = ledger.getRun(input.contract.id)
                    const { getLearningCoordinator } = await import('../learning/learning-coordinator.js')
                    await getLearningCoordinator().recordValidatedRun({
                        runId: input.contract.id, userId: input.userId, request: input.content,
                        taskType: kernel.intent.kind,
                        tools: (run?.tools || []).map(tool => ({
                            toolName: String(tool.toolName || tool.tool || ''),
                            params: tool.params && typeof tool.params === 'object' ? tool.params as Record<string, unknown> : {},
                            success: tool.success === true,
                        })).filter(tool => tool.toolName),
                        model: resolvedModel, node: resolvedNode, success: true, validated: true,
                        durationMs: Date.now() - startedAt, costUsd: usageCost.totalUsd,
                        channel: input.channel, validation,
                    })
                } catch { /* episodic learning is non-critical */ }
            }
            return {
                runId: input.contract.id,
                backend: this.name,
                status: 'completed',
                output,
                model: resolvedModel,
                node: resolvedNode,
                toolsUsed,
            }
        } catch (error) {
            const message = redactSecrets(String(error))
            ledger.fail(input.contract.id, { reason: message, durationMs: Date.now() - startedAt })
            return {
                runId: input.contract.id,
                backend: this.name,
                status: input.abortSignal?.aborted ? 'cancelled' : 'failed',
                output: '',
                model: input.model || 'auto',
                toolsUsed: [],
                error: message,
            }
        }
    }
}
