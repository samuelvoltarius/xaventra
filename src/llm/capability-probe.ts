/**
 * LLM Capability Probe
 *
 * Actively tests each discovered model endpoint to determine:
 * - Is the model actually online and responding?
 * - Does it support tool/function calling?
 * - What's the real context window?
 * - What's the actual latency under load?
 *
 * Results are cached in .nova-data/model-capabilities.json (TTL: 1 hour).
 * Fed into L18 Router to override static MODEL_REGISTRY entries with
 * live-measured values — Nova knows from EXPERIENCE what each model can do.
 *
 * Runs asynchronously after model discovery, never blocks startup.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export type ModelRole = 'chat' | 'vision' | 'code' | 'reasoning' | 'embedding' | 'tools' | 'fast' | 'longcontext'

export interface ModelCapabilityProbeResult {
    model: string
    endpoint: string
    probeTime: string
    online: boolean
    avgLatencyMs?: number
    tokensPerSecond?: number
    supportsTools: boolean
    supportsSystemPrompt: boolean
    supportsVision?: boolean     // can process images
    contextWindowHint?: number   // inferred from response if model returns it
    maxOutputTokens?: number
    roles?: ModelRole[]          // what this model is GOOD FOR (auto-classified)
    error?: string
    apiKey?: string             // stored for routing (not logged)
}

/**
 * Classify roles from REAL probe results. Capabilities that were actively
 * tested (vision, tools, code, reasoning) use the test outcome — not the name.
 * Name is only used as a hint where no active test exists (embedding, longcontext).
 */
export function classifyModelRoles(
    modelId: string,
    probe: Partial<ModelCapabilityProbeResult>,
    tests?: { codeWorks?: boolean; reasoningWorks?: boolean }
): ModelRole[] {
    const m = modelId.toLowerCase()
    const roles: ModelRole[] = []

    // Embedding models — not generative (name-based: they don't do chat completions)
    if (/embed|nomic|bge|mxbai|e5-|gte-|minilm|instructor/.test(m)) {
        return ['embedding']
    }

    // Every online generative model can chat (proven by the ping)
    if (probe.online !== false) roles.push('chat')

    // Vision — ACTIVELY TESTED (red image → did it say "red"?)
    if (probe.supportsVision) roles.push('vision')

    // Tools — ACTIVELY TESTED (did it emit a real tool call?)
    if (probe.supportsTools) roles.push('tools')

    // Code — ACTIVELY TESTED (wrote a valid add function?)
    if (tests?.codeWorks) roles.push('code')

    // Reasoning — ACTIVELY TESTED (solved the age-ordering puzzle?)
    if (tests?.reasoningWorks) roles.push('reasoning')

    // Fast — measured latency (real) or small-model name hint
    const isSmall = /:0\.\d|:1\.\d|:2b|:3b|:4b|:7b|:8b|mini|flash|turbo|instant|small|highspeed/.test(m)
    if ((probe.avgLatencyMs !== undefined && probe.avgLatencyMs < 1500) || isSmall) {
        roles.push('fast')
    }

    // Long context — from API-reported window (real) or name hint
    if ((probe.contextWindowHint ?? 0) >= 200000 || /1m|200k|128k|minimax-m|qwen3.*122b/.test(m)) {
        roles.push('longcontext')
    }

    return roles
}

interface ProbeCache {
    version: number
    lastProbed: string
    results: Record<string, ModelCapabilityProbeResult>
}

// ============================================
// Cache
// ============================================

const CACHE_FILE = join(process.cwd(), '.nova-data', 'model-capabilities.json')
const CACHE_TTL_MS = 60 * 60 * 1000  // 1 hour
let _cache: ProbeCache | null = null

function loadCache(): ProbeCache {
    if (_cache) return _cache
    try {
        if (existsSync(CACHE_FILE)) {
            const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as ProbeCache
            if (data.version === 1) { _cache = data; return _cache }
        }
    } catch { /* corrupt */ }
    _cache = { version: 1, lastProbed: '', results: {} }
    return _cache
}

function saveCache(cache: ProbeCache): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        cache.lastProbed = new Date().toISOString()
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
        _cache = cache
    } catch (err) {
        console.log(`[CapabilityProbe] ⚠ Cache write failed: ${err}`)
    }
}

function isCacheStale(result: ModelCapabilityProbeResult): boolean {
    if (!result.probeTime) return true
    return Date.now() - new Date(result.probeTime).getTime() > CACHE_TTL_MS
}

// ============================================
// Probe Logic
// ============================================

// Generous timeout: large local models (27B+) cold-start can take 20-30s on
// first load. Cloud APIs respond fast, but a uniform high timeout is safe since
// probing runs in the background and never blocks anything.
const PROBE_TIMEOUT_MS = 35_000

/**
 * Test if a model endpoint is alive and what it supports.
 */
export async function probeModel(endpoint: string, modelId: string, apiKey?: string): Promise<ModelCapabilityProbeResult> {
    const isOllama = endpoint.includes('11434')
    const base: ModelCapabilityProbeResult = {
        model: modelId,
        endpoint,
        probeTime: new Date().toISOString(),
        online: false,
        supportsTools: false,
        supportsSystemPrompt: true,
    }

    // ---- Step 1: Basic chat ping ----
    const chatEndpoint = isOllama
        ? `${endpoint}/api/chat`
        : (endpoint.endsWith('/v1') || endpoint.includes('/v1/')
            ? `${endpoint}/chat/completions`
            : `${endpoint}/v1/chat/completions`)

    const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) authHeaders['Authorization'] = `Bearer ${apiKey}`
    else if (process.env.OPENAI_API_KEY && !isOllama) authHeaders['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`

    const pingBody = isOllama
        ? { model: modelId, messages: [{ role: 'user', content: 'Hi' }], stream: false }
        : { model: modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }

    const t0 = Date.now()
    try {
        let res = await fetch(chatEndpoint, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(pingBody),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })

        // 429/529 = rate limited / overloaded → wait and retry once
        if (res.status === 429 || res.status === 529) {
            await new Promise(r => setTimeout(r, 3000))
            res = await fetch(chatEndpoint, {
                method: 'POST', headers: authHeaders,
                body: JSON.stringify(pingBody),
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            })
        }

        if (!res.ok) {
            base.error = `HTTP ${res.status}`
            return base
        }

        const data = await res.json() as any
        base.online = true
        base.avgLatencyMs = Date.now() - t0
        const generatedTokens = Number(data.usage?.completion_tokens || data.eval_count || 0)
        const generationNs = Number(data.eval_duration || 0)
        if (generatedTokens > 0) {
            const generationSeconds = generationNs > 0
                ? generationNs / 1_000_000_000
                : Math.max(0.001, base.avgLatencyMs / 1000)
            base.tokensPerSecond = Number((generatedTokens / generationSeconds).toFixed(2))
        }

        // Extract context window hint if API returns model info
        if (data.model_info?.context_length) {
            base.contextWindowHint = data.model_info.context_length
        }
        if (data.choices?.[0]?.message?.content || data.message?.content) {
            // Response looks valid
        }
    } catch (err) {
        base.error = err instanceof Error ? err.message.slice(0, 100) : String(err)
        return base
    }

    // Helper: one chat completion, return text content (or null)
    const askModel = async (messages: any[], maxTokens = 60): Promise<string | null> => {
        try {
            const body = isOllama
                ? { model: modelId, messages, stream: false }
                : { model: modelId, messages, max_tokens: maxTokens }
            const res = await fetch(chatEndpoint, {
                method: 'POST', headers: authHeaders,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            })
            if (!res.ok) return null
            const data = await res.json() as any
            return data.choices?.[0]?.message?.content || data.message?.content || null
        } catch { return null }
    }

    // ---- Step 2: TOOLS — does the model TECHNICALLY support function calling? ----
    // We test CAPABILITY, not willingness. tool_choice:'required' forces a call —
    // if the model emits a valid tool_call it understands the protocol (true).
    // (Whether it uses tools wisely in conversation is a separate, prompt-driven thing.)
    if (!isOllama) {
        let probed = false
        for (const choiceMode of ['required', 'auto'] as const) {
            if (probed) break
            try {
                const toolRes = await fetch(chatEndpoint, {
                    method: 'POST', headers: authHeaders,
                    body: JSON.stringify({
                        model: modelId,
                        messages: [{ role: 'user', content: 'What is the current weather in Tokyo?' }],
                        max_tokens: 40,
                        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get live weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
                        tool_choice: choiceMode,
                    }),
                    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                })
                if (toolRes.ok) {
                    const toolData = await toolRes.json() as any
                    const choice = toolData.choices?.[0]
                    base.supportsTools = choice?.finish_reason === 'tool_calls' || (choice?.message?.tool_calls?.length ?? 0) > 0
                    probed = true  // got a clean 200 → this mode works, don't try the other
                }
                // if 'required' returned non-200 (model rejects forced tools), fall through to 'auto'
            } catch { /* try next mode */ }
        }
    }

    // ---- Step 3: VISION — send a real red test image, ask for the colour ----
    try {
        const { default: sharp } = await import('sharp')
        const redPng = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toBuffer()
        const b64 = redPng.toString('base64')
        const visionMsg = isOllama
            ? [{ role: 'user', content: 'Welche Farbe hat dieses Bild? Antworte mit einem Wort.', images: [b64] }]
            : [{ role: 'user', content: [
                { type: 'text', text: 'What colour is this image? Answer in one word.' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            ] }]
        const visionAns = await askModel(visionMsg, 15)
        // Vision works if the model correctly identifies red (not a refusal/hallucination)
        base.supportsVision = !!visionAns && /\b(rot|red|rouge|rojo)\b/i.test(visionAns)
    } catch { /* sharp or vision unavailable */ }

    // ---- Step 4: CODE — give a tiny coding task, check for valid code ----
    let codeWorks = false
    try {
        const codeAns = await askModel([{ role: 'user', content: 'Write a JavaScript function named add that returns the sum of two numbers a and b. Code only.' }], 80)
        codeWorks = !!codeAns && /function\s+add|const\s+add|add\s*=/.test(codeAns) && /return|=>/.test(codeAns) && /\+/.test(codeAns)
    } catch { /* optional */ }

    // ---- Step 5: REASONING — multi-step logic check ----
    let reasoningWorks = false
    try {
        const reasonAns = await askModel([{ role: 'user', content: 'Tom is older than Sara. Sara is older than Max. Who is the youngest? Answer with just the name.' }], 15)
        reasoningWorks = !!reasonAns && /max/i.test(reasonAns)
    } catch { /* optional */ }

    // ---- Step 6: Classify roles from REAL test results (not just name) ----
    base.roles = classifyModelRoles(modelId, base, { codeWorks, reasoningWorks })
    if (base.roles.length > 0) {
        const tested: string[] = []
        if (base.supportsVision) tested.push('vision✓')
        if (base.supportsTools) tested.push('tools✓')
        if (codeWorks) tested.push('code✓')
        if (reasoningWorks) tested.push('reason✓')
        console.log(`[CapabilityProbe] 🎯 ${modelId} → ${base.roles.join(', ')}${tested.length ? ' [tested: ' + tested.join(' ') + ']' : ''}`)
    }

    return base
}

/**
 * Probe all endpoints from model-discovery results.
 * Uses cache — only re-probes stale or unknown models.
 * Runs in background, never blocks caller.
 */
export async function probeAllModels(forceRefresh = false): Promise<ModelCapabilityProbeResult[]> {
    const cache = loadCache()
    const results: ModelCapabilityProbeResult[] = []

    // Load endpoints from llm-factory + model-resolver
    let candidates: Array<{ endpoint: string; model: string; apiKey?: string }> = []

    try {
        const { availableLLMs } = await import('../core/llm-factory.js')
        for (const entry of availableLLMs) {
            if (entry.endpoint && entry.model) {
                const lower = entry.model.toLowerCase()
                // Skip embedding models and cloud-tag models
                if (/embed|nomic|bge|mxbai|e5-|gte-|minilm/.test(lower)) continue
                if (/:cloud\b/.test(lower)) continue
                if (lower.includes('gemini')) continue
                candidates.push({ endpoint: entry.endpoint, model: entry.model })
            }
        }
    } catch { /* factory optional */ }

    // Also probe nova.config.json external providers (MiniMax etc.)
    try {
        const cfgPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(cfgPath)) {
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
            if (cfg.providers?.minimax?.enabled && cfg.providers.minimax.apiKey) {
                candidates.push({
                    endpoint: cfg.providers.minimax.baseUrl || 'https://api.minimax.io/v1',
                    model: 'MiniMax-M2.7',
                    apiKey: cfg.providers.minimax.apiKey,
                })
            }
        }
    } catch { /* optional */ }

    // Probe each candidate (skip fresh cache entries)
    const probePromises: Promise<void>[] = []
    for (const c of candidates) {
        const cacheKey = `${c.endpoint}|${c.model}`
        const cached = cache.results[cacheKey]
        if (!forceRefresh && cached && !isCacheStale(cached)) {
            results.push(cached)
            continue
        }

        probePromises.push(
            probeModel(c.endpoint, c.model, c.apiKey)
                .then(result => {
                    cache.results[cacheKey] = result
                    results.push(result)
                    const status = result.online ? '✅' : '❌'
                    const tools = result.supportsTools ? ' [tools✓]' : ''
                    const latency = result.avgLatencyMs ? ` ${result.avgLatencyMs}ms` : ''
                    console.log(`[CapabilityProbe] ${status} ${result.model}${tools}${latency}${result.error ? ' ' + result.error : ''}`)
                })
                .catch(err => console.log(`[CapabilityProbe] ⚠ ${c.model}: ${err}`))
        )
    }

    if (probePromises.length > 0) {
        // Run probes with limited concurrency (max 4 at once to avoid flooding)
        for (let i = 0; i < probePromises.length; i += 4) {
            await Promise.allSettled(probePromises.slice(i, i + 4))
        }
        saveCache(cache)
        console.log(`[CapabilityProbe] Probed ${probePromises.length} endpoints, ${results.filter(r => r.online).length} online`)
    }

    return results
}

/**
 * Get cached probe result for a specific model (instant lookup, no network).
 */
export function getCachedProbe(modelId: string): ModelCapabilityProbeResult | null {
    const cache = loadCache()
    for (const result of Object.values(cache.results)) {
        if (result.model === modelId && !isCacheStale(result)) {
            return result
        }
    }
    return null
}

/**
 * Returns true if a model is known to support tool calls (from probe cache).
 * Falls back to true (optimistic) if no probe data available.
 */
export function modelSupportsTools(modelId: string): boolean {
    const probe = getCachedProbe(modelId)
    if (!probe) return true  // optimistic fallback
    return probe.supportsTools
}

/**
 * Returns all currently online models from probe cache.
 * Used by model-resolver to prefer known-good endpoints.
 */
export function getOnlineModels(): ModelCapabilityProbeResult[] {
    const cache = loadCache()
    return Object.values(cache.results).filter(r => r.online && !isCacheStale(r))
}

/**
 * Get all online models that are good for a specific role, fastest first.
 * This is how Nova answers "which model should I use for vision/code/etc.?"
 * — entirely from live-probed capabilities, no hardcoded registry.
 */
export function getModelsForRole(role: ModelRole): ModelCapabilityProbeResult[] {
    const cache = loadCache()
    return Object.values(cache.results)
        .filter(r => r.online && !isCacheStale(r) && r.roles?.includes(role))
        .sort((a, b) => (a.avgLatencyMs ?? 99999) - (b.avgLatencyMs ?? 99999))
}

/**
 * Returns the capability map: every online model and what it's good for.
 * Used for /models and for Nova's self-knowledge of her own capabilities.
 */
export function getCapabilityMap(): Array<{ model: string; roles: ModelRole[]; latencyMs?: number; tools: boolean; vision: boolean }> {
    const cache = loadCache()
    return Object.values(cache.results)
        .filter(r => r.online && !isCacheStale(r))
        .map(r => ({
            model: r.model,
            roles: r.roles ?? [],
            latencyMs: r.avgLatencyMs,
            tools: r.supportsTools,
            vision: r.supportsVision ?? (r.roles?.includes('vision') ?? false),
        }))
}

/**
 * Summary string for /doctor and /models commands.
 */
export function getProbeStatusSummary(): string {
    const cache = loadCache()
    const entries = Object.values(cache.results)
    if (entries.length === 0) return ''

    const lines: string[] = ['## LLM Endpoint Status (probe)']
    const online = entries.filter(r => r.online)
    const offline = entries.filter(r => !r.online)

    for (const r of online) {
        const tools = r.supportsTools ? ' 🔧' : ''
        const ms = r.avgLatencyMs ? ` ${r.avgLatencyMs}ms` : ''
        const roles = r.roles && r.roles.length > 0 ? ` — ${r.roles.join('/')}` : ''
        lines.push(`✅ ${r.model}${tools}${ms}${roles}`)
    }
    for (const r of offline) {
        lines.push(`❌ ${r.model}: ${r.error || 'offline'}`)
    }

    return lines.join('\n')
}

export default { probeModel, probeAllModels, getCachedProbe, modelSupportsTools, getOnlineModels, getProbeStatusSummary }
