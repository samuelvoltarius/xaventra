import { Runner, setTracingDisabled, type ModelProvider, type AgentInputItem } from '@openai/agents'
import type { LLMMessage } from '../llm/nova-llm-sdk.js'

// Xaventra configures no export for SDK traces; its own telemetry is OTel
// (infra/telemetry.ts) and does not use the SDK trace provider. `tracingDisabled`
// on the Runner only skips spans per run: the SDK still opens a trace on the
// global provider, and the OpenAI exporter registered on import of
// '@openai/agents' then logs "No API key provided for OpenAI tracing exporter"
// (or, with OPENAI_API_KEY set, ships trace data to OpenAI). Switch the global
// provider off once, on load, before any run can start.
setTracingDisabled(true)

/** Shared application-owned SDK runtime. Traces never leave the host implicitly. */
export function createSdkRunner(modelProvider: ModelProvider): Runner {
    return new Runner({ modelProvider, tracingDisabled: true, traceIncludeSensitiveData: false,
        workflowName: 'Xaventra governed agent run' })
}

export function sdkInput(messages: readonly LLMMessage[]): AgentInputItem[] {
    return messages.flatMap((message): AgentInputItem[] => {
        if (message.role === 'tool') return [{ type: 'function_call_result', name: 'tool',
            callId: message.toolCallId!, output: message.content } as any]
        const result: AgentInputItem[] = []
        if (message.content || message.image) result.push({
            role: message.role,
            content: message.image ? [
                { type: 'input_text', text: message.content },
                { type: 'input_image', image: `data:${message.image.mimeType};base64,${message.image.data}` },
            ] : message.content,
        } as AgentInputItem)
        for (const call of message.toolCalls || []) result.push({ type: 'function_call',
            callId: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' } as any)
        return result
    })
}
