import { Agent, RunState, Runner, tool, type FunctionTool, type ModelProvider } from '@openai/agents'
import type { NovaTool } from '../tools/complete-registry.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import { checkTool } from '../tools/tool-policy.js'
import { ExecutionKernel } from '../core/execution-kernel.js'
import { getOutcomeLedger, type OutcomeLedger } from '../core/outcome-ledger.js'
import { deriveToolCompensation, getIdempotencyStore, getPendingExecutionRegistry, makeIdempotencyKey, prepareToolCompensation } from '../core/execution-control.js'
import { getOutcomeRouter } from '../routing/outcome-router.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { NovaModelProvider } from './nova-model-provider.js'
import { estimateUsageCost } from '../core/model-pricing.js'
import type { AgentBackend, AgentBackendInput, AgentBackendResult } from './agent-backend.js'

const HIGH_RISK_TOOLS = /^(?:self_|create_skill|build_skill|write_|delete_|run_command|system_executor|ssh_|deploy|docker_|send_|mesh_delegate)/i

export interface OpenAIAgentsBackendOptions {
    modelProvider?: ModelProvider
    maxTurns?: number
    ledger?: OutcomeLedger
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
    private readonly modelProvider: ModelProvider
    private readonly maxTurns: number
    private readonly ledger: OutcomeLedger

    constructor(options: OpenAIAgentsBackendOptions = {}) {
        this.modelProvider = options.modelProvider || new NovaModelProvider()
        this.maxTurns = options.maxTurns || 12
        this.ledger = options.ledger || getOutcomeLedger()
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

    private buildTools(input: AgentBackendInput, kernel: ExecutionKernel): FunctionTool[] {
        const registry = getToolRegistry()
        const selected = input.tools || registry.getAll().filter(candidate =>
            input.contract.allowedChanges.allowedTools.length === 0
            || input.contract.allowedChanges.allowedTools.includes(candidate.name)
        )
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
                const idempotencyKey = makeIdempotencyKey(input.contract.id, novaTool.name, params)
                const policy = checkTool(novaTool.name, { channel: input.channel, userId: input.authUserId || input.userId })
                if (!policy.allowed) throw new Error(policy.reason || `Tool ${novaTool.name} is denied by Nova policy`)
                let result: unknown
                try {
                    const execution = await getIdempotencyStore().executeOnce({
                        key: idempotencyKey,
                        runId: input.contract.id,
                        operation: novaTool.name,
                        compensate: prepareToolCompensation(novaTool.name, params),
                        deriveCompensation: result => deriveToolCompensation(novaTool.name, params, result),
                        execute: async () => registry.get(novaTool.name)
                            ? registry.execute(novaTool.name, params)
                            : novaTool.handler(params),
                    })
                    result = execution.result
                    const validation = kernel.verify(novaTool.name, result)
                    ledger.recordTool(input.contract.id, {
                        toolName: novaTool.name,
                        params,
                        result,
                        validation,
                        success: validation.success,
                        idempotencyKey,
                        replayed: execution.replayed,
                        durationMs: Date.now() - startedAt,
                    })
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
        const shadow = getOutcomeRouter().decide(kernel.intent.kind || 'agent', baseline, graphCandidates)
        ledger.recordRoute(input.contract.id, {
            backend: this.name, model: baseline.model, node: baseline.node,
            taskType: kernel.intent.kind || 'agent',
            reason: 'configured Nova agent backend', shadowRecommendation: shadow.recommended,
            shadowConfidence: shadow.confidence, routerMode: shadow.mode,
        } as any)

        const agent = new Agent({
            name: 'Nova',
            instructions: input.systemPrompt || 'Du bist Nova. Führe den verbindlichen TaskContract aus. Behaupte niemals eine Tool-Ausführung ohne verifiziertes Tool-Ergebnis.',
            model: input.model || 'auto',
            tools: this.buildTools(input, kernel),
        })
        const runner = new Runner({
            modelProvider: this.modelProvider,
            tracingDisabled: true,
            traceIncludeSensitiveData: false,
            workflowName: 'Nova governed agent run',
        })

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
                    completedIdempotencyKeys: [],
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

            ledger.complete(input.contract.id, { success: true, durationMs: Date.now() - startedAt, output })
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
