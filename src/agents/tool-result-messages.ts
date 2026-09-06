import type { LLMMessage } from '../llm/nova-llm-sdk.js'
import { pruneToolResult } from '../memory/tool-result-pruner.js'

/** Correlate actual execution evidence using the provider's tool-message
 * contract. Results are data, never a new user request or permission. */
export function toolResultMessages(executions: ReadonlyArray<{ toolName: string; params: Record<string, unknown>; result: string }>, round: number): LLMMessage[] {
    if (!executions.length) return []
    const toolCalls = executions.map((execution, index) => ({
        id: `nova-evidence-${round}-${index}`, name: execution.toolName, arguments: execution.params,
    }))
    return [
        { role: 'assistant', content: '', toolCalls },
        ...executions.map((execution, index): LLMMessage => ({
            role: 'tool', toolCallId: toolCalls[index].id,
            // Preserve full execution evidence; bound only the provider-facing
            // copy, including results from recovery and later tool rounds.
            content: String(pruneToolResult(execution.result, {
                maxBytes: Number(process.env.NOVA_TOOL_CONTEXT_MAX_BYTES || 24_000),
            }).value),
        })),
    ]
}
