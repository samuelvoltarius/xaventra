/**
 * 2.89.12: an owner-approved cloud model for the background runtimes (learning, repair, internal LLM).
 *
 * The autonomous runtimes handle private data (journal, memory, self-checks) and stay local by default
 * (autonomous-endpoint.ts). Live 28.10.2026 the Main (VM 130) had no local model any more (the owner
 * switched ns1-Qwen off) and all three were "offline". The owner explicitly allowed MiniMax for this
 * data. That approval is a config switch, never a silent fallback:
 *
 *   "autonomy": { "cloudServiceModel": { "enabled": true, "provider": "minimax", "model": "MiniMax-M3.1-Flash" } }
 *
 * Only used when no local endpoint answers. Only MiniMax (the provider the owner approved). Without the
 * switch, or without a key, nothing changes: the runtimes stay offline instead of going to the cloud.
 */
export interface CloudServicePlan {
    provider: 'minimax'
    model: string
    baseUrl: string
    apiKey: string
}

const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3.1-Flash'
const DEFAULT_MINIMAX_BASE = 'https://api.minimax.io/v1'

/** The approved cloud plan, or null. `keyOf` resolves the provider key (llm-factory cloudProviderKey). */
export function resolveCloudServicePlan(config: any, keyOf: (name: string, section?: any) => string): CloudServicePlan | null {
    const switchSection = config?.autonomy?.cloudServiceModel
    if (!switchSection || switchSection.enabled !== true) return null
    const provider = String(switchSection.provider || 'minimax').toLowerCase()
    if (provider !== 'minimax') return null
    const section = config?.providers?.minimax
    if (section?.enabled === false) return null
    const apiKey = String(keyOf('minimax', section) || '')
    if (!apiKey) return null
    const model = String(switchSection.model || section?.model || (String(config?.provider) === 'minimax' ? config?.model : '') || DEFAULT_MINIMAX_MODEL)
    return { provider: 'minimax', model, baseUrl: String(section?.baseUrl || DEFAULT_MINIMAX_BASE), apiKey }
}

interface MiniMaxLike {
    complete(messages: any[], options?: { maxTokens?: number; tools?: any[]; signal?: AbortSignal }): Promise<{
        content: string; model: string; tokensUsed?: number; stopReason?: string
        toolCalls?: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>
    }>
}

/** The service-runtime contract (`complete(messages, tools, options)`, like LocalLLM) over the MiniMax adapter. */
export function miniMaxServiceClient(llm: MiniMaxLike, timeoutMs: number) {
    return {
        async complete(messages: any[], tools: any[] = [], options: { maxTokens?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {
            const limit = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0 ? Math.min(timeoutMs, Number(options.timeoutMs)) : timeoutMs
            const deadline = AbortSignal.timeout(limit)
            const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
            // LocalLLM-style tool rounds (tool_calls / tool_call_id) to the adapter's fields (toolCalls / toolCallId).
            const input = (Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages ?? '') }]).map((message: any) => {
                const out: any = { ...message, content: typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '') }
                if (message?.tool_call_id && !message.toolCallId) out.toolCallId = message.tool_call_id
                if (Array.isArray(message?.tool_calls) && !message.toolCalls) {
                    out.toolCalls = message.tool_calls.map((call: any) => ({
                        id: call.id, name: call.function?.name ?? call.name,
                        arguments: typeof call.function?.arguments === 'string' ? (() => { try { return JSON.parse(call.function.arguments) } catch { return {} } })() : (call.function?.arguments ?? call.arguments ?? {}),
                    }))
                }
                return out
            })
            const result = await llm.complete(input, { maxTokens: options.maxTokens, tools, signal })
            const toolCalls = (result.toolCalls || []).map((call, index) => ({ id: call.id || `minimax_${Date.now()}_${index}`, name: call.name, arguments: call.arguments || {} }))
            return {
                content: result.content || '',
                model: result.model,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                tokensUsed: result.tokensUsed,
                finishReason: result.stopReason,
            }
        },
    }
}
