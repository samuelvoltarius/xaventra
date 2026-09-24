import { authorizeToolExecution, ToolAuthorizationError } from './tool-authorization.js'
import type { ExecutionKernel } from '../core/execution-kernel.js'
import { assertMissionFenceForContent, executionScopeForContent, makeIdempotencyKey,
    prepareToolCompensation, deriveToolCompensation, type IdempotencyStore } from '../core/execution-control.js'
import { withSpan } from '../infra/telemetry.js'

export interface GovernedToolExecutorOptions {
    kernel: ExecutionKernel
    store: IdempotencyStore
    userId: string
    authUserId: string
    channel: string
    content: string
    workspaceId?: string
    internal: boolean
    isBlocked: () => boolean
    block: (awaitingApproval: boolean) => void
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
    record: (callId: string, metadata: { idempotencyKey: string; executionInputHash: string }) => void
}

/** Extracted unchanged effect boundary. Planner/SDK output never grants authority. */
export function createGovernedToolExecutor(options: GovernedToolExecutorOptions) {
    const { kernel, store, userId, authUserId, channel, content, workspaceId } = options
    return async (name: string, args: Record<string, unknown>, callId?: string, attemptScope?: 'typed-transient-retry') => {
        if (options.isBlocked()) throw new ToolAuthorizationError('This run stopped at a policy gate; no alternative action is authorized')
        try {
            args = await authorizeToolExecution(name, args, {
                userId, authUserId, channel, requestText: content,
                governedReadOnly: (channel === 'benchmark' || options.internal)
                    && kernel.contract.allowedChanges.readOnly
                    && kernel.contract.allowedChanges.externalSideEffects === false,
            })
        } catch (error) {
            if (error instanceof ToolAuthorizationError) options.block(false)
            throw error
        }
        kernel.assertCanExecute(name)
        await assertMissionFenceForContent(content)
        const idempotencyRunId = executionScopeForContent(content, kernel.contract.id)
        const keyScope = attemptScope ? `${idempotencyRunId}:${attemptScope}` : idempotencyRunId
        const key = makeIdempotencyKey(keyScope, name, args)
        const executionInputHash = makeIdempotencyKey('native-input', name, args)
        const execution = await store.executeOnce({
            key, runId: idempotencyRunId, operation: name, inputHash: executionInputHash,
            compensate: prepareToolCompensation(name, args),
            deriveCompensation: result => deriveToolCompensation(name, args, result),
            execute: () => withSpan('nova.tool.execute', {
                'nova.tool.name': name, 'nova.channel': channel, 'nova.run.id': idempotencyRunId,
            }, async () => {
                const { withExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
                return withExecutionPolicyContext({ runId: idempotencyRunId, userId, channel,
                    nodeId: process.env.NOVA_NODE_ID, workspaceId }, () => options.execute(name, args))
            }),
        })
        const value = execution.result as any
        if (value && typeof value === 'object' && value.blocked === true) {
            options.block(value.awaitingApproval === true)
            throw new ToolAuthorizationError(String(value.error || 'Tool blocked by policy'))
        }
        if (callId) options.record(callId, { idempotencyKey: key, executionInputHash })
        return execution.result
    }
}
