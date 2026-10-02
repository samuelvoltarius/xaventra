/**
 * Endpoint resolution for the autonomous learning/repair runtimes.
 *
 * The autonomous runtimes (learning, repair, internal LLM) process private
 * data: journal, memory, self-checks. They therefore only ever run on a local
 * or Tailnet model (`isLocalEndpoint`) and never fall back into the cloud.
 *
 * Search order:
 *   1. `config.nodes[].services.vllm` (explicit mesh declaration)
 *   2. the configured local OpenAI-compatible provider (`providers.local`,
 *      `providers.vllm`, or the main provider's section when its baseUrl is
 *      local) — live 2.82.0 the Spark ran vLLM only through this path, and the
 *      runtimes wrongly reported "offline"
 *   3. Ollama on localhost (only with an explicitly configured model)
 *
 * Each candidate must answer `/v1/models` (or `/api/tags`) before it is used.
 * The caller creates its own client from the result; it never shares the main
 * agent's client or failover chain.
 */
import { isLocalEndpoint } from '../llm/endpoint-trust.js'

export interface AutonomousEndpoint {
    baseUrl: string
    model: string
    provider: 'vllm' | 'local' | 'ollama'
    apiKey?: string
    source: string
}

export interface LocalOpenAICandidate {
    baseUrl: string
    provider: 'vllm' | 'local'
    apiKey?: string
    source: string
}

const OLLAMA_BASE = 'http://localhost:11434'

function normalizeBase(raw: unknown): string {
    const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
    return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

const normalizeModel = (name: string) => name.replace(/:latest$/i, '').toLowerCase()

/** Local/Tailnet OpenAI-compatible endpoints from the config, in priority order. */
export function localOpenAICandidates(config: any): LocalOpenAICandidate[] {
    const out: LocalOpenAICandidate[] = []
    const seen = new Set<string>()
    const push = (candidate: LocalOpenAICandidate) => {
        if (!candidate.baseUrl || seen.has(candidate.baseUrl)) return
        if (!isLocalEndpoint(candidate.baseUrl)) return
        seen.add(candidate.baseUrl)
        out.push(candidate)
    }
    for (const node of (config?.nodes || [])) {
        const base = normalizeBase(node?.services?.vllm)
        if (base) push({ baseUrl: base, provider: 'vllm', source: `nodes.${node?.name || '?'}.services.vllm` })
    }
    const providers = config?.providers || {}
    const sections: string[] = ['local', 'vllm']
    const main = String(config?.provider || '')
    if (main && !sections.includes(main)) sections.push(main)
    for (const key of sections) {
        const section = providers[key]
        if (!section || section.enabled === false) continue
        const base = normalizeBase(section.baseUrl)
        if (!base) continue
        const apiKey = typeof section.apiKey === 'string' && section.apiKey ? section.apiKey : undefined
        push({ baseUrl: base, provider: key === 'vllm' ? 'vllm' : 'local', apiKey, source: `providers.${key}` })
    }
    return out
}

export interface ResolveDeps {
    fetchImpl?: typeof fetch
    timeoutMs?: number
}

export async function resolveAutonomousEndpoint(
    config: any,
    requested: string | null | undefined,
    deps: ResolveDeps = {},
): Promise<AutonomousEndpoint | null> {
    const doFetch = deps.fetchImpl ?? fetch
    const want = String(requested || 'auto')
    for (const candidate of localOpenAICandidates(config)) {
        const response: any = await doFetch(`${candidate.baseUrl}/v1/models`, {
            headers: candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {},
            signal: AbortSignal.timeout(deps.timeoutMs ?? 3_000),
        } as any).catch(() => null)
        if (!response?.ok) continue
        const payload: any = await response.json().catch(() => ({ data: [] }))
        const models: string[] = (payload?.data || []).map((entry: any) => String(entry?.id || '')).filter(Boolean)
        const selected = want !== 'auto'
            ? models.find(name => normalizeModel(name) === normalizeModel(want))
            : models.find(name => /qwen/i.test(name)) || models[0]
        if (selected) {
            return { baseUrl: candidate.baseUrl, model: selected, provider: candidate.provider, apiKey: candidate.apiKey, source: candidate.source }
        }
    }

    const response: any = await doFetch(`${OLLAMA_BASE}/api/tags`, {
        signal: AbortSignal.timeout(deps.timeoutMs ?? 2_000),
    } as any).catch(() => null)
    if (!response?.ok) return null
    const payload: any = await response.json().catch(() => ({ models: [] }))
    const installed: string[] = (payload?.models || [])
        .map((entry: any) => String(entry?.name || entry?.model || ''))
        .filter(Boolean)
    const internal = String(config?.internalModel || '')
    const preferred = want !== 'auto' ? want : (internal && internal !== 'auto' ? internal : '')
    // Never replace an explicitly configured autonomous model with an
    // arbitrary installed model: presence in /api/tags does not prove that it
    // can serve Nova's real prompt within the role deadline.
    const selected = preferred ? installed.find(name => normalizeModel(name) === normalizeModel(preferred)) : null
    if (!selected) return null
    return { baseUrl: OLLAMA_BASE, model: selected, provider: 'ollama', source: 'ollama.localhost' }
}

export type InternalLlmPlan =
    | { kind: 'local-runtime'; label: string }
    | { kind: 'ollama'; model: string }
    | { kind: 'none' }

/**
 * The legacy `state.internalLlm`. Before 2.82.x `internalModel: "auto"` meant
 * "the main client" and was logged as "Internal LLM: Cloud (auto)". Private
 * autonomous work must never take that path: with a local runtime the
 * internal LLM is that runtime, otherwise there is none.
 */
export function resolveInternalLlmPlan(
    internalModel: string | null | undefined,
    localRuntime: { model: string; provider: string } | null,
): InternalLlmPlan {
    const configured = String(internalModel || 'auto')
    if (configured !== 'auto') return { kind: 'ollama', model: configured }
    if (localRuntime) return { kind: 'local-runtime', label: `${localRuntime.model} via ${localRuntime.provider} (lokal)` }
    return { kind: 'none' }
}
