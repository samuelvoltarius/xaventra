import type { ModelProvider } from '@openai/agents'
import type { NovaTool } from '../tools/complete-registry.js'
import type { TaskContract } from '../core/task-contract.js'

export type AgentBackendStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled'

export interface AgentBackendInput {
    contract: TaskContract
    userId: string
    authUserId?: string
    channel: string
    content: string
    systemPrompt?: string
    model?: string
    tools?: NovaTool[]
    abortSignal?: AbortSignal
}

export interface AgentBackendResult {
    runId: string
    backend: string
    status: AgentBackendStatus
    output: string
    model?: string
    node?: string
    toolsUsed: string[]
    interruptionCount?: number
    checkpoint?: string
    error?: string
    /** True only when the backend intentionally paused for user input. */
    requestedUserInput?: boolean
}

export interface AgentBackend {
    readonly name: string
    run(input: AgentBackendInput): Promise<AgentBackendResult>
    resume?(input: AgentBackendInput, checkpoint: string): Promise<AgentBackendResult>
    cancel?(runId: string): Promise<void> | void
}

export interface AgentBackendFactoryOptions {
    backend?: 'nova' | 'openai-agents'
    modelProvider?: ModelProvider
}

export async function createAgentBackend(options: AgentBackendFactoryOptions = {}): Promise<AgentBackend> {
    const requested = options.backend || (process.env.NOVA_AGENT_BACKEND === 'openai-agents' ? 'openai-agents' : 'nova')
    if (requested === 'openai-agents') {
        const { OpenAIAgentsBackend } = await import('./openai-agents-backend.js')
        return new OpenAIAgentsBackend({ modelProvider: options.modelProvider })
    }
    const { NovaNativeBackend } = await import('./nova-native-backend.js')
    return new NovaNativeBackend()
}
