import type { AgentBackend, AgentBackendInput, AgentBackendResult } from './agent-backend.js'

export class NovaNativeBackend implements AgentBackend {
    readonly name = 'nova'

    async run(input: AgentBackendInput): Promise<AgentBackendResult> {
        const { runNovaAgent } = await import('./nova-runner.js')
        const result = await runNovaAgent({
            userId: input.userId,
            authUserId: input.authUserId,
            channel: input.channel,
            content: input.content,
            systemPrompt: input.systemPrompt,
            tools: input.tools,
            abortSignal: input.abortSignal,
            contract: input.contract,
        })
        return {
            runId: input.contract.id,
            backend: this.name,
            status: input.abortSignal?.aborted ? 'cancelled'
                : result.validation?.awaitingApproval ? 'interrupted'
                    : !result.error && result.validation?.success === true ? 'completed' : 'failed',
            output: result.content,
            model: result.model,
            toolsUsed: result.toolsUsed || [],
            error: result.error || (!result.validation?.success && !result.validation?.awaitingApproval
                ? 'Execution Kernel did not validate task completion' : undefined),
        }
    }
}
