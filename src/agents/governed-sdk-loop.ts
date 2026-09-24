import { Agent, tool } from '@openai/agents'
import { randomUUID } from 'node:crypto'
import type { LLMMessage, LLMResponse, ToolDefinition } from '../llm/nova-llm-sdk.js'
import { NovaModelProvider, type NovaAgentsModelOptions } from './nova-model-provider.js'
import { createSdkRunner, sdkInput } from './sdk-runtime.js'

export interface GovernedSdkLoopInput {
    messages: LLMMessage[]
    tools: ToolDefinition[]
    initialResponse: LLMResponse
    modelOptions: NovaAgentsModelOptions
    maxTurns: number
    signal?: AbortSignal
    execute: (call: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<string>
}

/** SDK owns continuation; the application callback owns every effect and receipt. */
export async function runGovernedSdkLoop(input: GovernedSdkLoopInput): Promise<string> {
    let queue: Promise<unknown> = Promise.resolve()
    let stopped: unknown
    const tools = input.tools.map(definition => tool({
        name: definition.name, description: definition.description,
        parameters: definition.parameters as any, strict: false,
        // Never convert a policy/fencing failure into model-directed recovery.
        errorFunction: null,
        execute: (args: Record<string, unknown>, _context, details) => {
            const next = queue.then(async () => {
                if (stopped) throw stopped
                if (input.signal?.aborted) throw new Error('AbortError: tool dispatch cancelled')
                return input.execute({ id: details?.toolCall?.callId || randomUUID(), name: definition.name, arguments: args })
            })
            queue = next.catch(error => { stopped = error })
            return next
        },
    }))
    const runner = createSdkRunner(new NovaModelProvider({ ...input.modelOptions, initialResponse: input.initialResponse }))
    const agent = new Agent({ name: 'Xaventra', tools, model: 'nova-router', modelSettings: { parallelToolCalls: false } })
    const result = await runner.run(agent, sdkInput(input.messages), { maxTurns: input.maxTurns, signal: input.signal })
    return typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput ?? '')
}
