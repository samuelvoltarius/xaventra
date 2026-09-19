import type { ContextPolicy } from './context-policy.js'
import type { LLMResponse } from '../llm/nova-llm-sdk.js'

export type ModelReasoningEffort = 'none' | 'low' | 'medium' | 'high'

/** Keep ordinary chat cheap and make function calling deterministic. Complex
 * text-only work may still use bounded reasoning. Qwen's documented tool path
 * uses non-thinking mode; tool evidence and validation remain application-owned. */
export function reasoningEffortForTurn(
    policy: Pick<ContextPolicy, 'reasoningEffort'>,
    requiresTools: boolean,
): ModelReasoningEffort {
    if (requiresTools || policy.reasoningEffort === 'minimal') return 'none'
    return policy.reasoningEffort
}

/** A reasoning-only response is not a provider outage and is not a visible
 * answer. It may be retried once through the normal, budget-accounted caller
 * with reasoning disabled. Tool calls remain valid even when text is empty. */
export function isReasoningOnlyResponse(response: Pick<LLMResponse, 'content' | 'reasoning' | 'toolCalls'> | null | undefined): boolean {
    return Boolean(response
        && !response.content?.trim()
        && !response.toolCalls?.length
        && response.reasoning?.trim())
}

/** Retry exactly once only when a reasoning-enabled request produced no visible
 * result. The caller supplies its already budget-wrapped completion function. */
export async function recoverReasoningOnlyResponse<T extends LLMResponse>(
    response: T,
    requestedEffort: ModelReasoningEffort,
    retryWithoutReasoning: () => Promise<T>,
): Promise<{ response: T; recovered: boolean }> {
    if (requestedEffort === 'none' || !isReasoningOnlyResponse(response)) {
        return { response, recovered: false }
    }
    return { response: await retryWithoutReasoning(), recovered: true }
}
