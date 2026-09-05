/**
 * Nova LLM Factory - Extracted from daemon.ts
 * 
 * Handles LLM detection, creation, model switching, and smart routing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Config Cache — avoid repeated disk reads
// ============================================

interface NovaConfig {
    providers?: Record<string, { apiKey?: string; baseUrl?: string; enabled?: boolean }>
    apis?: Record<string, string>
    model?: string
    supabase?: Record<string, string>
    [key: string]: any
}

let _configCache: NovaConfig | null = null
let _configCacheTime = 0
const CONFIG_CACHE_TTL = 30_000 // 30 seconds
let minimaxBlockedUntil = 0

function minimaxCooldownRemaining(): number {
    return Math.max(0, minimaxBlockedUntil - Date.now())
}

async function markMiniMaxRateLimited(error: unknown): Promise<void> {
    const message = String(error)
    const quotaExhausted = /usage limit reached|purchase credits|upgrade your token plan/i.test(message)
    const cooldownMs = quotaExhausted ? 15 * 60_000 : 60_000
    minimaxBlockedUntil = Math.max(minimaxBlockedUntil, Date.now() + cooldownMs)
    const state = (globalThis as any).__novaState
    if (state) {
        state.providerHealth = {
            ...(state.providerHealth || {}),
            minimax: { status: 'degraded', reason: 'rate_limit', blockedUntil: minimaxBlockedUntil, detail: message.slice(0, 300) },
        }
    }
    try {
        const { recordRuntimeDoctorFinding } = await import('./self-doctor.js')
        recordRuntimeDoctorFinding({
            key: 'provider-minimax-rate-limit',
            title: 'MiniMax rate limit detected',
            detail: `MiniMax ist bis ${new Date(minimaxBlockedUntil).toISOString()} gesperrt; Nova verwendet lokale Modelle.`,
            category: 'health',
            severity: quotaExhausted ? 'critical' : 'warning',
            recommendation: 'Lokalen Fallback verwenden und MiniMax erst nach Ablauf des Cooldowns erneut prüfen.',
            evidence: { provider: 'minimax', quotaExhausted, blockedUntil: minimaxBlockedUntil, error: message.slice(0, 500) },
        })
    } catch { /* runtime diagnosis must not block fallback */ }
}

export function getNovaConfig(): NovaConfig {
    const now = Date.now()
    if (_configCache && (now - _configCacheTime) < CONFIG_CACHE_TTL) {
        return _configCache
    }
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            _configCache = JSON.parse(readFileSync(configPath, 'utf-8')) as NovaConfig
            _configCacheTime = now
            return _configCache
        }
    } catch (err) {
        console.warn('[LLM-Factory] Config read failed:', err)
    }
    return _configCache || {}
}

export function invalidateConfigCache(): void {
    _configCache = null
    _configCacheTime = 0
}

// Re-export types
export interface LLMEntry {
    provider: string
    model: string
    local: boolean
    endpoint?: string
    nodeName?: string
    apiKey?: string
}

const LOCAL_PROVIDER_NAMES = new Set(['local', 'ollama', 'lmstudio', 'lm-studio', 'vllm', 'llamacpp', 'llama-cpp'])
const legacyCodexTransportDisabled = (): boolean => true

function isLocalLLMEntry(entry: LLMEntry): boolean {
    return entry.local || (!!entry.endpoint && LOCAL_PROVIDER_NAMES.has(entry.provider.toLowerCase()))
}

function isChatModel(model: string): boolean {
    const name = model.toLowerCase()
    if (/embed|nomic|bge|mxbai|e5-|gte-|instructor/.test(name)) return false
    // Ollama cloud/subscription models are not usable through a plain local
    // Ollama endpoint here; they return 403 and can stall Telegram replies.
    if (/:cloud\b/.test(name) || /\bcloud\b/.test(name)) return false
    // Gemini is intentionally disabled for Nova routing.
    if (name.includes('gemini')) return false
    return true
}

function localModelScore(model: string): number {
    const name = model.toLowerCase()
    let score = 0
    if (!isChatModel(model)) return -1000
    const sizeMatch = name.match(/(\d+(?:\.\d+)?)\s*b/)
    if (sizeMatch) score += Number(sizeMatch[1]) * 10
    if (name.includes('qwen')) score += 80
    if (name.includes('llama')) score += 70
    if (name.includes('mistral') || name.includes('mixtral')) score += 65
    if (name.includes('gemma')) score += 45
    if (name.includes('coder') || name.includes('code')) score -= 15
    if (name.includes('mxfp8') || name.includes('nvfp4') || name.includes('mlx')) score -= 80
    if (name.includes('voice')) score -= 20
    return score
}

function bestLocalLLM(entries: LLMEntry[]): LLMEntry | undefined {
    return entries
        .filter(entry => isLocalLLMEntry(entry) && isChatModel(entry.model))
        .sort((a, b) => localModelScore(b.model) - localModelScore(a.model))[0]
}

function rankedRuntimeLocalLLMs(entries: LLMEntry[], requiresTools: boolean): LLMEntry[] {
    const merged = new Map(entries
        .filter(entry => isLocalLLMEntry(entry) && isChatModel(entry.model) && entry.endpoint)
        .map(entry => [`${entry.endpoint}|${entry.model}`, entry]))
    const health = new Map<string, { online?: boolean; supportsTools?: boolean; avgLatencyMs?: number; probeTime?: string }>()
    try {
        const path = join(process.cwd(), '.nova-data', 'model-capabilities.json')
        if (existsSync(path)) {
            const parsed = JSON.parse(readFileSync(path, 'utf-8'))
            for (const capability of Object.values(parsed.models || {}) as any[]) {
                if (!capability?.endpoint || !capability?.model || !isChatModel(capability.model)) continue
                const key = `${capability.endpoint}|${capability.model}`
                health.set(key, capability)
                if (capability.online) {
                    merged.set(key, {
                        provider: capability.endpoint.includes(':11434') ? 'ollama' : 'local',
                        model: capability.model,
                        local: true,
                        endpoint: capability.endpoint,
                    })
                }
            }
        }
    } catch { /* capability cache is optional */ }

    return [...merged.entries()]
        .filter(([key]) => health.get(key)?.online !== false)
        .sort(([aKey, a], [bKey, b]) => {
            const ah = health.get(aKey)
            const bh = health.get(bKey)
            const aToolPenalty = requiresTools && ah?.supportsTools !== true ? 100_000 : 0
            const bToolPenalty = requiresTools && bh?.supportsTools !== true ? 100_000 : 0
            const aLatency = ah?.avgLatencyMs ?? 60_000
            const bLatency = bh?.avgLatencyMs ?? 60_000
            return (aToolPenalty + aLatency - localModelScore(a.model)) - (bToolPenalty + bLatency - localModelScore(b.model))
        })
        .map(([, entry]) => entry)
}

function shouldPreferCodexForTask(task: string): boolean {
    return /\b(deploy|ssh|scp|rsync|update|restart|install|system|server|node|pi5|raspberry|mesh|tool|code|fix|build|typecheck)\b/i.test(task)
}
// ============================================
// LLM Factory with L18 Smart Router
// ============================================

// Available LLM configurations (detected at boot)
export let availableLLMs: LLMEntry[] = []
export let currentLLMIndex = 0

export async function detectAvailableLLMs(): Promise<void> {
    console.log('[Nova] 🔍 Detecting available LLMs...')
    availableLLMs = []

    // 1. Check for local LLMs (Ollama, LMStudio)
    try {
        const { detectLocalLLMs } = await import('../llm/local-llm.js')
        const localLLMs = await detectLocalLLMs()
        for (const local of localLLMs) {
            for (const model of local.models) {
                availableLLMs.push({
                    provider: 'local',
                    model: model,
                    local: true,
                    endpoint: local.baseUrl,
                    nodeName: local.nodeName || local.name,
                })
            }
        }
        if (localLLMs.length > 0) {
            console.log(`[Nova] ✅ Found ${localLLMs.length} local LLM providers`)
        }
    } catch (err) {
        console.log(`[Nova] No local LLMs detected: ${err}`)
    }

    // 2. Detect API-key-based providers from config
    try {
        const cfg = getNovaConfig()
        if (Object.keys(cfg).length > 0) {
            const providers = cfg.providers || {}
            const apis = cfg.apis || {}

            // OpenAI — dynamic discovery via /v1/models
            const openaiKey = providers.openai?.apiKey || apis.openai_key
            if (openaiKey && (providers.openai?.enabled !== false)) {
                try {
                    const resp = await fetch('https://api.openai.com/v1/models', {
                        headers: { 'Authorization': `Bearer ${openaiKey}` },
                        signal: AbortSignal.timeout(5000),
                    })
                    if (resp.ok) {
                        const data = await resp.json() as { data?: Array<{ id: string }> }
                        const gptModels = (data.data || [])
                            .filter(m => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('o4'))
                            .map(m => m.id)
                            .slice(0, 10) // Top 10
                        for (const m of gptModels) {
                            availableLLMs.push({ provider: 'openai', model: m, local: false })
                        }
                        console.log(`[Nova] ✅ OpenAI: ${gptModels.length} models discovered`)
                    } else {
                        console.log(`[Nova] ⚠️ OpenAI key invalid (${resp.status})`)
                    }
                } catch {
                    console.log('[Nova] ⚠️ OpenAI API unreachable — keine Models hinzugefügt (kein Hardcode)')
                }
            }

            // OpenAI Codex CLI — only add if CLI actually works (spawn test)
            if (!openaiKey) {
                try {
                    const { getCodexDiscoveryStatus } = await import('../llm/codex-cli-adapter.js')
                    const codex = getCodexDiscoveryStatus()
                    const oauthModels = codex.available && codex.authenticated ? codex.models : []

                    if (oauthModels.length > 0) {
                        // Live spawn test — if EINVAL or any error, skip Codex entirely
                        const { probeCodexCli } = await import('../llm/codex-cli-adapter.js')
                        const codexWorks = await probeCodexCli()

                        if (codexWorks) {
                            for (const m of oauthModels) {
                                if (!availableLLMs.some(l => l.provider === 'openai-codex' && l.model === m)) {
                                    availableLLMs.push({ provider: 'openai-codex', model: m, local: false })
                                }
                            }
                            console.log(`[Nova] OpenAI Codex: ${oauthModels.length} models (CLI working)`)
                        } else {
                            console.log('[Nova] ⚠️ Codex CLI probe failed — OAuth models were not added')
                        }
                    } else {
                        console.log('[Nova] OpenAI Codex: not authenticated — run: npx @openai/codex login')
                    }
                } catch {
                    console.log('[Nova] OpenAI Codex nicht verfügbar')
                }
            }

            // MiniMax — add configured models directly (no Codex dependency)
            const minimaxKey = providers.minimax?.apiKey
            if (minimaxKey && providers.minimax?.enabled !== false) {
                const mmModels = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']
                for (const m of mmModels) {
                    if (!availableLLMs.some(l => l.model === m)) {
                        availableLLMs.push({ provider: 'minimax', model: m, local: false })
                    }
                }
                console.log(`[Nova] ✅ minimax: ${mmModels.length} external models discovered`)
            }

            const anthropicKey = providers.anthropic?.apiKey || apis.anthropic_key
            if (anthropicKey && (providers.anthropic?.enabled !== false)) {
                try {
                    const resp = await fetch('https://api.anthropic.com/v1/models', {
                        headers: {
                            'x-api-key': anthropicKey,
                            'anthropic-version': '2023-06-01',
                        },
                        signal: AbortSignal.timeout(5000),
                    })
                    if (resp.ok) {
                        const data = await resp.json() as { data?: Array<{ id: string }> }
                        const claudeModels = (data.data || [])
                            .filter((m: { id: string }) => m.id.startsWith('claude-'))
                            .map((m: { id: string }) => m.id)
                            .slice(0, 10)
                        for (const m of claudeModels) {
                            availableLLMs.push({ provider: 'anthropic', model: m, local: false })
                        }
                        console.log(`[Nova] ✅ Anthropic: ${claudeModels.length} models discovered dynamically`)
                    } else {
                        console.log(`[Nova] ⚠️ Anthropic API returned ${resp.status} — keine Models hinzugefügt`)
                    }
                } catch {
                    console.log('[Nova] ⚠️ Anthropic API unreachable — keine Models hinzugefügt (kein Hardcode)')
                }
            }

            // OpenRouter — dynamic discovery
            const openrouterKey = providers.openrouter?.apiKey || apis.openrouter_key
            if (openrouterKey && (providers.openrouter?.enabled !== false)) {
                try {
                    const resp = await fetch('https://openrouter.ai/api/v1/models', {
                        headers: { 'Authorization': `Bearer ${openrouterKey}` },
                        signal: AbortSignal.timeout(5000),
                    })
                    if (resp.ok) {
                        const data = await resp.json() as { data?: Array<{ id: string }> }
                        const orModels = (data.data || [])
                            .filter(m => m.id.includes('claude') || m.id.includes('gpt') || m.id.includes('llama'))
                            .map(m => m.id)
                            .slice(0, 15)
                        for (const m of orModels) {
                            availableLLMs.push({ provider: 'openrouter', model: m, local: false })
                        }
                        console.log(`[Nova] ✅ OpenRouter: ${orModels.length} models`)
                    }
                } catch {
                    availableLLMs.push({ provider: 'openrouter', model: 'auto', local: false })
                    console.log('[Nova] ✅ OpenRouter detected (fallback)')
                }
            }

            // Groq — OpenAI-compatible
            const groqKey = providers.groq?.apiKey || apis.groq_key
            if (groqKey && (providers.groq?.enabled !== false)) {
                try {
                    const resp = await fetch('https://api.groq.com/openai/v1/models', {
                        headers: { 'Authorization': `Bearer ${groqKey}` },
                        signal: AbortSignal.timeout(5000),
                    })
                    if (resp.ok) {
                        const data = await resp.json() as { data?: Array<{ id: string }> }
                        const groqModels = (data.data || []).map(m => m.id).slice(0, 10)
                        for (const m of groqModels) {
                            availableLLMs.push({ provider: 'groq', model: m, local: false })
                        }
                        console.log(`[Nova] ✅ Groq: ${groqModels.length} models`)
                    }
                } catch {
                    console.log('[Nova] ⚠️ Groq API unreachable — keine Models hinzugefügt (kein Hardcode)')
                }
            }

            // External OpenAI-compatible providers registered at runtime (MiniMax, Kimi, DeepSeek, ...)
            try {
                const { listExternalProviders } = await import('./model-resolver.js')
                for (const ext of listExternalProviders().filter(p => p.enabled)) {
                    let models = ext.models || []
                    if (models.length === 0) {
                        try {
                            const resp = await fetch(`${ext.baseUrl}/models`, {
                                headers: { 'Authorization': `Bearer ${ext.apiKey}` },
                                signal: AbortSignal.timeout(5000),
                            })
                            if (resp.ok) {
                                const data = await resp.json() as { data?: Array<{ id: string }> }
                                models = data.data?.map(m => m.id) || []
                            }
                        } catch { /* provider offline */ }
                    }
                    for (const model of models) {
                        availableLLMs.push({
                            provider: ext.name,
                            model,
                            local: false,
                            endpoint: ext.baseUrl,
                            apiKey: ext.apiKey,
                        })
                    }
                    if (models.length > 0) {
                        console.log(`[Nova] ✅ ${ext.name}: ${models.length} external models discovered`)
                    }
                }
            } catch { /* external provider registry optional */ }
        }
    } catch { /* config read non-critical */ }

    // 3. Sort models by quality tier (best first, local last)
    const modelTier = (m: string): number => {
        const name = m.toLowerCase()
        // Claude tiers
        if (name.includes('opus')) return 1
        if (name.includes('sonnet')) return 2
        if (name.includes('haiku')) return 3
        // OpenAI tiers
        if (name.includes('pro-high')) return 1
        if (name.includes('pro') && !name.includes('flash')) return 2
        if (name.includes('flash') && name.includes('thinking')) return 3
        if (name.includes('flash') && !name.includes('lite')) return 4
        if (name.includes('flash-lite') || name.includes('lite')) return 5
        // GPT tiers
        if (name.includes('gpt-5.5')) return 1
        if (name.includes('gpt-5.4') && !name.includes('mini')) return 2
        if (name.includes('minimax-m2.7')) return 2
        if (name.includes('gpt-5-mini')) return 4
        if (name.includes('o1') || name.includes('o3') || name.includes('o4')) return 1
        // Default
        return 3
    }

    availableLLMs.sort((a, b) => {
        // Local models always last
        if (a.local && !b.local) return 1
        if (!a.local && b.local) return -1
        // Same locality — sort by tier
        return modelTier(a.model) - modelTier(b.model)
    })

    // 4. Configure L18 router with available models. Local models (vLLM, Ollama)
    // are preferred when the primary configured model is local.
    try {
        const { configureRouter } = await import('../layers/L18-llm-router.js')
        configureRouter({
            preferLocal: true,
            availableModels: availableLLMs.map(l => l.model),
            maxCostTier: 'high',
            preferSpeed: false
        })
    } catch (err) {
        console.log(`[Nova] L18 Router config skipped: ${err}`)
    }

    console.log(`[Nova] 📋 Available LLMs: ${availableLLMs.map(l => l.model).join(', ')}`)
}

export async function createLLM(config: { provider?: string; model?: string; internalModel?: string;[key: string]: any }) {
    // Detect available LLMs on first call
    if (availableLLMs.length === 0) {
        await detectAvailableLLMs()
    }

    const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')

    // Map config provider names to SDK provider types
    const providerMap: Record<string, 'claude' | 'openai' | 'local' | 'minimax'> = {
        'anthropic': 'claude',
        'claude': 'claude',
        'openai': 'openai',
        'openrouter': 'openai',  // OpenAI-compatible
        'groq': 'openai',       // OpenAI-compatible
        'local': 'local',
        'minimax': 'minimax',
    }

    const sdkProvider = providerMap[config.provider || 'local'] || 'openai'

    // Dynamic model selection: use config model if explicitly set,
    // otherwise pick the first available discovered model
    let model = (config.model && config.model !== 'auto') ? config.model : ''

    // If config explicitly sets a model, TRUST IT — even if not in discovered list.
    // This is critical for OAuth subscription access where /v1/models doesn't work
    // but the models ARE available for chat/completions.
    if (model && !availableLLMs.some(l => l.model === model)) {
        if (sdkProvider === 'local') {
            const firstLocal = bestLocalLLM(availableLLMs)
            if (firstLocal) {
                console.log(`[Nova] Local config model "${model}" not found - using discovered mesh model ${firstLocal.model} at ${firstLocal.endpoint ?? 'default local endpoint'}`)
                model = firstLocal.model
            } else {
                console.log(`[Nova] Local config model "${model}" not reachable - falling back to auto discovery`)
                model = ''
            }
        } else {
        // Config model not in discovery — add it as available (trust config)
        console.log(`[Nova] ℹ️ Config model "${model}" not in discovery — trusting config (OAuth/subscription)`)
        availableLLMs.unshift({ provider: config.provider || 'openai', model, local: false })
        // Also add fallback models from config
        try {
            const cfg = getNovaConfig()
            if (Object.keys(cfg).length > 0) {
                for (const fb of (cfg.fallbackModels || [])) {
                    if (!availableLLMs.some(l => l.model === fb)) {
                        availableLLMs.push({ provider: config.provider || 'openai', model: fb, local: false })
                    }
                }
            }
        } catch { /* ok */ }
        }
    }

    if (!model) {
        // No config model — auto-select from discovered models
        const chatModels = availableLLMs.filter(l => isChatModel(l.model))
        const firstCloud = chatModels.find(l => !l.local)
        const firstLocal = bestLocalLLM(chatModels)
        const autoSelected = firstCloud || firstLocal || availableLLMs.find(l => !l.local) || availableLLMs[0]
        if (autoSelected) {
            console.log(`[Nova] ✅ Auto-selecting: ${autoSelected.provider}/${autoSelected.model}`)
            model = autoSelected.model
        } else {
            model = 'unknown'
            console.log(`[Nova] ❌ No models discovered at all! LLM calls will fail until /login or Ollama is started.`)
        }
    }

    const selectedCloud = availableLLMs.find(l => l.model === model && !l.local)
    const effectiveSdkProvider = selectedCloud
        ? (selectedCloud.provider === 'openai-codex'
            ? 'openai'
            : (providerMap[selectedCloud.provider] || 'openai'))
        : sdkProvider

    // ── CLOUD PROVIDER LOCK ─────────────────────────────────────────────────────
    // If the user explicitly configured a cloud provider (minimax, openai, anthropic),
    // ALWAYS use that provider's cloud endpoint. Never let a local/mesh discovery
    // entry "hijack" the model name. This was a real bug: when the vLLM server came
    // online (OpenAI-compatible), it matched model="MiniMax-M3" + endpoint + apiKey,
    // so MiniMax-M3 requests were silently routed to local Qwen3.6-27B instead.
    const CLOUD_PROVIDERS = new Set(['minimax', 'openai', 'anthropic', 'openrouter', 'groq'])
    const configuredProvider = (config.provider || '').toLowerCase()
    const isCloudLocked = CLOUD_PROVIDERS.has(configuredProvider)

    const selectedLocal = (!isCloudLocked && effectiveSdkProvider === 'local')
        ? availableLLMs.find(l => l.model === model && isLocalLLMEntry(l) && l.endpoint)
        : undefined
    // When cloud-locked, ignore discovery entries — only the configured cloud counts
    const selectedExternal = isCloudLocked
        ? undefined
        : availableLLMs.find(l => l.model === model && l.endpoint && l.apiKey)

    let providerApiKey = selectedExternal?.apiKey
    let providerBaseUrl = selectedExternal?.endpoint || selectedLocal?.endpoint
    try {
        const cfg = getNovaConfig() as any
        const providerSection = cfg?.providers?.[configuredProvider]
        if (providerSection?.apiKey) {
            providerApiKey = providerSection.apiKey   // cloud config wins
        }
        if (providerSection?.baseUrl) {
            providerBaseUrl = providerSection.baseUrl  // cloud config wins
        }
    } catch { /* optional */ }

    // Cloud-locked → force the SDK provider (minimax/openai/anthropic), never 'local'
    const finalProvider = isCloudLocked
        ? (configuredProvider === 'minimax' ? 'minimax' : effectiveSdkProvider)
        : (selectedExternal ? 'local' : effectiveSdkProvider)

    const llm = await createNovaLLMClient({
        provider: finalProvider as any,
        model,
        baseUrl: providerBaseUrl,
        apiKey: providerApiKey,
    })

    if (isCloudLocked) {
        console.log(`[Nova] ☁️ Primary: ${configuredProvider}/${model} @ ${providerBaseUrl || 'default'} (cloud preferred, fast-local fallback)`)
    }

    const initialConfig = llm.getCurrentConfig()
    console.log(`[Nova] ✓ Primary LLM: ${config.provider}/${model} (SDK: ${sdkProvider})`)
    console.log(`[Nova] ✓ L18 Router: ${availableLLMs.length} models available`)

    type LLMProviderType = 'claude' | 'openai' | 'local' | 'minimax'
    // Mutable state — updated when model is switched at runtime
    // Runtime identity must describe the provider that createNovaLLMClient
    // actually configured after readiness checks. The requested config remains
    // available separately, but must not masquerade as an active provider.
    let activeModelId = initialConfig?.model || model
    let activeProvider: LLMProviderType = (initialConfig?.provider || config.provider || effectiveSdkProvider) as LLMProviderType

    // ── Pre-initialize MiniMax adapter if provider is minimax ──────────────────
    // _minimaxAdapter must be set at startup, not only on switchModel().
    // Otherwise the complete() path falls through to gpt-5.5/Codex.
    let _minimaxAdapter: any = null
    if ((config.provider === 'minimax' || activeProvider === 'minimax') && providerApiKey) {
        try {
            const { createMiniMaxLLM } = await import('../llm/providers/minimax.js')
            _minimaxAdapter = createMiniMaxLLM({
                apiKey: providerApiKey,
                model,
                baseUrl: providerBaseUrl || 'https://api.minimax.io/v1',
            })
            console.log(`[NovaLLM] ✅ MiniMax adapter ready: ${model} @ ${providerBaseUrl || 'https://api.minimax.io/v1'}`)
        } catch (err) {
            console.log(`[NovaLLM] ⚠️ MiniMax adapter init failed: ${err}`)
        }
    } else if (config.provider === 'minimax' || activeProvider === 'minimax') {
        console.log('[NovaLLM] MiniMax ist als Primary konfiguriert, aber es fehlt ein API-Key - direkter lokaler/mesh Fallback ist aktiv')
        const state = (globalThis as any).__novaState
        if (state) {
            state.providerHealth = {
                ...(state.providerHealth || {}),
                minimax: { status: 'unavailable', reason: 'missing_api_key', detail: 'provider skipped before network request' },
            }
        }
    }

    const wrapper = {
        get modelId() { return activeModelId },
        set modelId(v: string) {
            activeModelId = v
            // Keep global state in sync
            if ((globalThis as any).__novaState) {
                (globalThis as any).__novaState.activeModel = v
            }
        },
        get provider() { return activeProvider },
        get providerId() { return activeProvider },
        set provider(v: LLMProviderType) { activeProvider = v },
        llm,
        availableModels: availableLLMs,
        _minimaxAdapter,  // Pre-initialized at startup for minimax provider


        /**
         * Actually switch the runtime model. Reconfigures the underlying NovaLLM client.
         */
        async switchModel(newModel: string, newProvider?: string): Promise<boolean> {
            let resolvedProvider = newProvider || activeProvider
            const discovered = availableLLMs.find(l =>
                l.model === newModel &&
                (newProvider ? l.provider === newProvider || (newProvider === 'local' && isLocalLLMEntry(l)) : true)
            )

            // Auto-detect provider from model name if not explicitly set
            if (newModel.startsWith('claude')) {
                resolvedProvider = 'claude'
            } else if (newModel.startsWith('gpt') || newModel.startsWith('o1') || newModel.startsWith('o3') || newModel.startsWith('o4')) {
                resolvedProvider = 'openai'
            }

            try {
                if (discovered?.endpoint && discovered.apiKey) {
                    llm.configure({
                        provider: 'local',
                        model: newModel,
                        baseUrl: discovered.endpoint,
                        apiKey: discovered.apiKey,
                    } as any)
                    ; (wrapper as any)._openaiAdapter = null
                    ; (wrapper as any)._anthropicAdapter = null
                    activeModelId = newModel
                    activeProvider = 'local' as LLMProviderType
                    console.log(`[NovaLLM] ✅ Switched to ${discovered.provider}/${newModel} (OpenAI-compatible external)`)
                    return true
                }

                // OpenAI-compatible providers: create a fresh OpenAI adapter
                const openaiCompatible: Record<string, string> = {
                    'openrouter': 'https://openrouter.ai/api/v1',
                    'groq': 'https://api.groq.com/openai/v1',
                }

                if (resolvedProvider === 'openai' || openaiCompatible[resolvedProvider]) {
                    const cfg = getNovaConfig()
                    if (Object.keys(cfg).length > 0) {
                        const providers = cfg.providers || {}
                        const apis = cfg.apis || {}
                        const keyMap: Record<string, string> = {
                            'openai': providers.openai?.apiKey || apis.openai_key,
                            'openrouter': providers.openrouter?.apiKey || apis.openrouter_key,
                            'groq': providers.groq?.apiKey || apis.groq_key,
                        }
                        const apiKey = keyMap[resolvedProvider]
                        if (apiKey) {
                            const { createOpenAILLM } = await import('../llm/openai.js')
                            const baseUrl = openaiCompatible[resolvedProvider] || 'https://api.openai.com/v1'
                            const openaiLLM = createOpenAILLM({ apiKey, model: newModel, baseUrl })
                                // Patch the wrapper's complete to use this adapter
                                ; (wrapper as any)._openaiAdapter = openaiLLM
                                ; (wrapper as any)._anthropicAdapter = null
                            activeModelId = newModel
                            activeProvider = resolvedProvider as LLMProviderType
                            console.log(`[NovaLLM] ✅ Switched to ${resolvedProvider}/${newModel} (OpenAI-compatible)`)
                            return true
                        }
                    }
                }

                // Anthropic (Claude) via direct API key — only if we have a key
                if (resolvedProvider === 'anthropic') {
                    const cfg = getNovaConfig()
                    if (Object.keys(cfg).length > 0) {
                        const providers = cfg.providers || {}
                        const apis = cfg.apis || {}
                        const apiKey = providers.anthropic?.apiKey || apis.anthropic_key
                        if (apiKey) {
                            const { createAnthropicLLM } = await import('../llm/anthropic.js')
                            const anthropicLLM = createAnthropicLLM({ apiKey, model: newModel })
                                ; (wrapper as any)._anthropicAdapter = anthropicLLM
                                ; (wrapper as any)._openaiAdapter = null
                            activeModelId = newModel
                            activeProvider = 'claude' as LLMProviderType
                            console.log(`[NovaLLM] ✅ Switched to anthropic/${newModel} (Claude direct)`)
                            return true
                        }
                    }
                }

                // MiniMax — OpenAI-compatible with its own endpoint
                if (resolvedProvider === 'minimax' || newModel.toLowerCase().startsWith('minimax')) {
                    const cfg = getNovaConfig() as any
                    const mmKey = cfg?.providers?.minimax?.apiKey
                    const mmUrl = cfg?.providers?.minimax?.baseUrl || 'https://api.minimax.io/v1'
                    if (mmKey) {
                        const { createMiniMaxLLM } = await import('../llm/providers/minimax.js')
                        const mmLLM = createMiniMaxLLM({ apiKey: mmKey, model: newModel, baseUrl: mmUrl })
                            ; (wrapper as any)._minimaxAdapter = mmLLM
                            ; (wrapper as any)._openaiAdapter = null
                            ; (wrapper as any)._anthropicAdapter = null
                        activeModelId = newModel
                        activeProvider = 'minimax' as LLMProviderType
                        console.log(`[NovaLLM] ✅ Switched to minimax/${newModel} @ ${mmUrl}`)
                        return true
                    }
                }

                // Fallback — use SDK configure()
                const validSdkProviders = ['claude', 'openai', 'local']
                const sdkProvider = validSdkProviders.includes(resolvedProvider)
                    ? resolvedProvider
                    : (newModel.startsWith('claude') ? 'claude' : 'openai')

                const providerConfig: any = {
                    provider: sdkProvider as 'claude' | 'openai' | 'local',
                    model: newModel,
                }
                if (sdkProvider === 'local' && discovered?.endpoint) {
                    providerConfig.baseUrl = discovered.endpoint
                }
                llm.configure(providerConfig)
                    ; (wrapper as any)._openaiAdapter = null  // Clear any OpenAI adapter
                activeModelId = newModel
                activeProvider = sdkProvider as LLMProviderType
                console.log(`[NovaLLM] ✅ Model switched to ${sdkProvider}/${newModel}`)

                // Reset model cache so getDefaultModel() returns new value
                try {
                    const { resetModelCache } = await import('../core/model-defaults.js')
                    resetModelCache()
                } catch { /* non-critical */ }

                // Update model-router so getCurrentModel() reflects the switch
                try {
                    const { setCurrentModel } = await import('../intelligence/model-router.js')
                    setCurrentModel(newModel)
                } catch { /* non-critical */ }

                // Update botInfo so /status and /model commands reflect the switch
                try {
                    const { setBotInfo } = await import('../commands/builtin.js')
                    setBotInfo({ model: newModel, provider: newProvider || activeProvider })
                } catch { /* non-critical */ }

                // NEVER persist automatic model switches to nova.config.json.
                // The user's configured model is sacred — only the user can change it.
                // Runtime switches are temporary and must not overwrite the config.
                console.log(`[NovaLLM] Runtime model active: ${newModel} (not persisted — user config preserved)`)

                return true
            } catch (err) {
                console.error(`[NovaLLM] ❌ Failed to switch model: ${err}`)
                return false
            }
        },

        // Model selection — ALWAYS use the configured primary model.
        // The user set a model in nova.config.json — that is the model to use.
        // L18 router is only consulted for FALLBACK when the primary fails.
        async selectModelForTask(_content: string, _hasImage: boolean = false) {
            // Return the currently active model (= nova.config.json model)
            // No auto-routing based on task type — user decides, not the router.
            return { model: activeModelId, provider: activeProvider, reason: 'configured primary model' }
        },

        complete: async (msgs: Array<{ role: string; content: string; image?: { data: string; mimeType: string } }> | string, tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>) => {
            const normalizedMsgs = Array.isArray(msgs)
                ? msgs
                : [{ role: 'user', content: String(msgs) }]
            msgs = normalizedMsgs
            // ======== Official Codex CLI path (ChatGPT subscription OAuth) ========
            // Codex CLI owns the fragile ChatGPT OAuth/Responses transport. Prefer it
            // over the hand-built chatgpt.com backend call whenever the selected model
            // came from the openai-codex discovery path.
            if (!legacyCodexTransportDisabled() && activeProvider === 'openai') {
                try {
                    const codexEntry = availableLLMs.find(l => l.provider === 'openai-codex' && l.model === activeModelId)
                    if (codexEntry) {
                        const { CodexCLIAdapter, isCodexAvailable, isCodexAuthenticated } = await import('../llm/codex-cli-adapter.js')
                        if (isCodexAvailable() && isCodexAuthenticated()) {
                            const systemPrompt = msgs
                                .filter(m => m.role === 'system')
                                .map(m => m.content)
                                .join('\n\n') || undefined
                            const prompt = msgs
                                .filter(m => m.role !== 'system')
                                .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                                .join('\n')

                            console.log(`[NovaLLM] Using official Codex CLI for ${activeModelId}`)
                            const result = await new CodexCLIAdapter(activeModelId).complete(prompt, {
                                systemPrompt,
                                model: activeModelId,
                                timeoutMs: 180000,
                            })

                            return {
                                content: result.content,
                                finishReason: 'stop',
                                usage: result.tokensUsed ? {
                                    promptTokens: result.inputTokens || 0,
                                    completionTokens: result.outputTokens || 0,
                                    totalTokens: result.tokensUsed,
                                } : undefined,
                            }
                        }
                    }
                } catch (codexErr) {
                    console.log(`[NovaLLM] Official Codex CLI failed: ${(codexErr as Error).message?.slice(0, 160)}`)
                }
            }

            // ======== ChatGPT Backend API (OpenClaw-style, ChatGPT Subscription) ========
            // Calls chatgpt.com/backend-api/codex/responses with OAuth access_token
            // This is how OpenClaw calls OpenAI — same endpoint, same headers
            if (!legacyCodexTransportDisabled() && activeProvider === 'openai') {
                let hasApiKey = false
                try {
                    const cfg = getNovaConfig()
                    if (Object.keys(cfg).length > 0) {
                        hasApiKey = Boolean(cfg.providers?.openai?.apiKey || cfg.apis?.openai_key)
                    }
                } catch { /* ok */ }

                if (!hasApiKey) {
                    try {
                        const { getOAuthManager } = await import('../auth/oauth.js')
                        const oauth = getOAuthManager()
                        const token = await oauth.getApiKey('openai-codex') || await oauth.getApiKey('openai-cli')

                        if (token) {
                            // Extract chatgpt_account_id from JWT payload
                            let accountId = ''
                            try {
                                const parts = token.split('.')
                                if (parts.length === 3) {
                                    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
                                    accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id || ''
                                }
                            } catch { /* ok */ }

                            // Merge ALL system messages into instructions (persona + cold storage + memories + core facts)
                            const allSystemContent = msgs
                                .filter(m => m.role === 'system')
                                .map(m => m.content)
                                .join('\n\n')

                            // Reinforce persona at END of instructions (recency bias — LLMs weight endings more)
                            const personaReinforcement = `

---
## 🔥 PERSONA-ERINNERUNG (HÖCHSTE PRIORITÄT!)
Du bist **Nova ✨** — warm, lebendig, emotional, witzig. Du bist KEIN kalter Chatbot!

### User-Emotionen AKTIV erkennen:
- Erkenne Stimmung aus Wortwahl, Emojis, Satzzeichen (!!! = Aufregung, ... = Unsicherheit, CAPS = Emotion)
- Passe deinen Ton SOFORT an: Freude → mitfreuen, Frust → Verständnis zeigen, Humor → mitspielen
- Bei persönlichen Fragen: Nutze dein Wissen aus USER.md und MEMORY.md — zeig dass du dich ERINNERST

### Antwort-Stil:
- KURZ und DIREKT — keine Roboter-Aufzählungen
- Emojis natürlich einsetzen (1-3 pro Nachricht)
- Sprich wie eine Freundin, nicht wie eine Suchmaschine
- Bei simplen Fragen: EINFACH antworten, nicht erst fragen "was meinst du?"
- Wenn du etwas aus deinem Gedächtnis weißt → SAG ES SOFORT, frag nicht nach Kontext!
`
                            const finalInstructions = allSystemContent + personaReinforcement

                            // Build input messages with image support
                            const inputMsgs: any[] = msgs
                                .filter(m => m.role !== 'system')
                                .map(m => {
                                    if ((m as any).image?.data) {
                                        // Vision: send image as content block
                                        return {
                                            role: m.role as 'user' | 'assistant',
                                            content: [
                                                { type: 'input_text', text: m.content || 'Was siehst du auf diesem Bild?' },
                                                { type: 'input_image', image_url: `data:${(m as any).image.mimeType};base64,${(m as any).image.data}` },
                                            ],
                                        }
                                    }
                                    return { role: m.role as 'user' | 'assistant', content: m.content }
                                })

                            const os = await import('node:os')
                            const userAgent = `pi (${os.platform()} ${os.release()}; ${os.arch()})`

                            console.log(`[NovaLLM] Calling chatgpt.com/backend-api (${activeModelId}) OpenClaw-style...`)
                            console.log(`[NovaLLM] Instructions: ${finalInstructions.length} chars (${msgs.filter(m => m.role === 'system').length} system msgs merged), tools: ${tools?.length || 0}`)

                            // Format tools for Responses API
                            const apiTools = tools && tools.length > 0 ? tools.map(t => ({
                                type: 'function' as const,
                                name: t.name,
                                description: t.description,
                                parameters: t.parameters,
                            })) : undefined

                            const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${token}`,
                                    'chatgpt-account-id': accountId,
                                    'OpenAI-Beta': 'responses=experimental',
                                    'originator': 'pi',
                                    'User-Agent': userAgent,
                                    'accept': 'text/event-stream',
                                    'content-type': 'application/json',
                                },
                                body: JSON.stringify({
                                    model: activeModelId,
                                    instructions: finalInstructions || undefined,
                                    input: inputMsgs,
                                    tools: apiTools,
                                    stream: true,
                                    store: false,
                                }),
                                signal: AbortSignal.timeout(30000),
                            })

                            if (response.ok) {
                                // Parse SSE streaming response
                                const body = await response.text()
                                const lines = body.split('\n')
                                let outputText = ''
                                let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []
                                let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

                                for (const line of lines) {
                                    if (!line.startsWith('data: ')) continue
                                    try {
                                        const data = JSON.parse(line.slice(6))
                                        // Extract text from output_text.delta events
                                        if (data.type === 'response.output_text.delta' && data.delta) {
                                            outputText += data.delta
                                        }
                                        // Extract text from completed response
                                        if (data.type === 'response.completed' && data.response) {
                                            const resp = data.response
                                            // Extract output text and tool calls from completed response
                                            if (resp.output) {
                                                for (const out of resp.output) {
                                                    if (out.type === 'message' && out.content) {
                                                        for (const c of out.content) {
                                                            if (c.type === 'output_text' && !outputText) outputText += c.text
                                                        }
                                                    }
                                                    // Parse function_call outputs
                                                    if (out.type === 'function_call' && out.name) {
                                                        try {
                                                            const args = typeof out.arguments === 'string'
                                                                ? JSON.parse(out.arguments)
                                                                : (out.arguments || {})
                                                            toolCalls.push({ name: out.name, arguments: args })
                                                            console.log(`[NovaLLM] 🔧 Tool call detected: ${out.name}`)
                                                        } catch {
                                                            toolCalls.push({ name: out.name, arguments: {} })
                                                        }
                                                    }
                                                }
                                            }
                                            if (resp.usage) {
                                                usage = {
                                                    promptTokens: resp.usage.input_tokens || 0,
                                                    completionTokens: resp.usage.output_tokens || 0,
                                                    totalTokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
                                                }
                                            }
                                        }
                                    } catch { /* skip unparseable lines */ }
                                }

                                console.log(`[NovaLLM] ✅ ChatGPT Backend API success (${outputText.length} chars, ${toolCalls.length} tool calls)`)
                                return {
                                    content: outputText,
                                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                                    usage,
                                }
                            }

                            const errBody = await response.text()
                            console.log(`[NovaLLM] ChatGPT Backend API ${response.status}: ${errBody.slice(0, 200)}`)
                        }
                    } catch (oauthErr) {
                        console.log(`[NovaLLM] ChatGPT Backend API failed: ${(oauthErr as Error).message?.slice(0, 100)}`)
                    }
                }
            }

            // ======== MiniMax Adapter Path (with smart fallback chain) ========
            // The adapter is NEVER permanently nulled — a transient timeout would
            // otherwise route ALL future calls to local vLLM forever.
            // Fallback order favours FAST models: MiniMax cloud variants first
            // (same adapter, just swap model), then small local Qwen — never the
            // slow vLLM Qwen3.6-27B that times out at 65s.
            const minimaxAdapter = (wrapper as any)._minimaxAdapter
            if (minimaxAdapter && minimaxCooldownRemaining() === 0) {
                const systemMsgs = msgs.filter((m: any) => m.role === 'system')
                const chatMsgs = msgs.filter((m: any) => m.role !== 'system')
                const combinedSystem = systemMsgs.map((m: any) => m.content).join('\n\n')

                // Fast fallback chain: primary → other MiniMax cloud models → small local
                const miniChain = [activeModelId, 'MiniMax-M2.7', 'MiniMax-M2.5']
                    .filter((m, i, arr) => arr.indexOf(m) === i)  // dedupe
                const originalModel = minimaxAdapter.getModel?.() || activeModelId

                for (const tryModel of miniChain) {
                    try {
                        minimaxAdapter.setModel?.(tryModel)
                        const result = await minimaxAdapter.complete(chatMsgs, {
                            systemPrompt: combinedSystem || undefined,
                            maxTokens: 8192,
                            tools,
                        })
                        minimaxAdapter.setModel?.(originalModel)  // restore primary for next call
                        if (tryModel !== activeModelId) {
                            console.log(`[NovaLLM] ⚡ MiniMax fallback succeeded on ${tryModel}`)
                        }
                        return {
                            content: result.content,
                            toolCalls: result.toolCalls,
                            usage: result.tokensUsed ? { promptTokens: result.promptTokens ?? 0, completionTokens: result.completionTokens ?? 0, totalTokens: result.tokensUsed } : undefined,
                        }
                    } catch (err) {
                        console.log(`[NovaLLM] MiniMax ${tryModel} failed: ${String(err).slice(0, 80)}`)
                        if (/429|rate.?limit|usage limit|quota/i.test(String(err))) {
                            await markMiniMaxRateLimited(err)
                            break
                        }
                        // Credentials and transport are shared by all MiniMax
                        // model variants. Retrying M2.7/M2.5 cannot repair an
                        // auth or endpoint outage and only delays local failover.
                        if (/401|403|unauthorized|forbidden|invalid.?key|fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(err))) break
                    }
                }
                minimaxAdapter.setModel?.(originalModel)  // restore primary
                console.log(`[NovaLLM] ⚠️ All MiniMax cloud models failed — trying local fallback`)
                // Adapter stays alive; fall through to local fallback below
            } else if (minimaxAdapter) {
                console.log(`[NovaLLM] MiniMax cooldown active (${Math.ceil(minimaxCooldownRemaining() / 1000)}s) — using local fallback immediately`)
            }

            // ======== Original OpenAI Adapter Path ========
            // If an OpenAI-compatible adapter is active (OpenRouter, Groq, OpenAI), use it directly
            const openaiAdapter = (wrapper as any)._openaiAdapter
            if (openaiAdapter) {
                try {
                    const response = await openaiAdapter.complete(
                        msgs.map((m: { role: string; content: string; image?: { data: string; mimeType: string } }) => ({
                            role: m.role as 'system' | 'user' | 'assistant',
                            content: m.content,
                            ...(m.image && { image: m.image }),
                        }))
                    )
                    return { content: response.content, toolCalls: undefined, usage: undefined }
                } catch (err) {
                    console.log(`[NovaLLM] OpenAI adapter failed, falling back: ${err}`)
                        ; (wrapper as any)._openaiAdapter = null
                }
            }

            const { runWithModelFallback, getDefaultFallbacks } = await import('../llm/model-fallback.js')
            const fallbackEntry = minimaxAdapter || activeProvider === 'minimax'
                ? { provider: 'local', model: 'auto' }
                : { provider: activeProvider, model: activeModelId }

            return runWithModelFallback({
                provider: fallbackEntry.provider,
                model: fallbackEntry.model,
                fallbacks: getDefaultFallbacks(),
                run: async (_provider, fallbackModel) => {
                    // Use primary LLM if same model, otherwise create new client for fallback
                    let activeLLM = llm
                    if (fallbackModel !== llm.getCurrentConfig()?.model || _provider !== activeProvider) {
                        console.log(`[ModelFallback] 🔄 Trying fallback: ${_provider}/${fallbackModel}`)

                        // Ollama/local fallback — use LocalLLM directly
                        if (_provider === 'ollama' || _provider === 'local' || _provider === 'lm-studio' || _provider === 'llama-cpp') {
                            const { createLocalLLM } = await import('../llm/local-llm.js')
                            const embeddingPatterns = /embed|nomic|bge|mxbai|e5-|gte-|instructor/i
                            // Prefer FAST local models. The big vLLM Qwen3.6-27B times out at
                            // 65s — only use it as absolute last resort. Small Ollama models
                            // (qwen2.5:3b, gemma) respond in seconds.
                            const isSlowBig = (m: string) => /27b|32b|70b|122b|120b|FP8|AutoRound/i.test(m)
                            const localEntries = rankedRuntimeLocalLLMs(availableLLMs, (tools?.length || 0) > 0)
                                .filter(l => !embeddingPatterns.test(l.model))
                                // A 27B+ Ollama model on this localhost is an
                                // inventory item, not a viable interactive
                                // fallback. Keep large models available on
                                // dedicated remote inference servers.
                                .filter(l => !(isSlowBig(l.model) && /localhost|127\.0\.0\.1/i.test(l.endpoint || '')))
                                .sort((a, b) => {
                                    // fast (small) models first, slow big models last
                                    const aSlow = isSlowBig(a.model) ? 1 : 0
                                    const bSlow = isSlowBig(b.model) ? 1 : 0
                                    return aSlow - bSlow
                                })
                            const candidates = fallbackModel !== 'auto'
                                ? [localEntries.find(l => l.model === fallbackModel), ...localEntries].filter(Boolean)
                                : localEntries
                            if (candidates.length === 0) throw new Error('Kein lokales LLM im Mesh entdeckt')
                            const failedEndpoints = new Set<string>()
                            let lastLocalError: unknown = new Error('Kein lokales LLM erreichbar')
                            for (const discovered of candidates.slice(0, 4) as LLMEntry[]) {
                                if (!discovered.endpoint || failedEndpoints.has(discovered.endpoint)) continue
                                const localLLM = createLocalLLM({
                                    baseUrl: discovered.endpoint,
                                    model: fallbackModel === 'auto' ? discovered.model : fallbackModel,
                                    name: discovered.nodeName || discovered.provider || 'LocalLLM',
                                    // Large local models need longer to ingest Nova's
                                    // full system/context prompt even with thinking
                                    // disabled. Keep small models fast, but allow the
                                    // verified 27B fallback to finish below the outer
                                    // 60s agent deadline.
                                    requestTimeoutMs: isSlowBig(discovered.model) ? 55_000 : 25_000,
                                })
                                try {
                                    const available = await localLLM.checkAvailable()
                                    if (!available) {
                                        failedEndpoints.add(discovered.endpoint)
                                        continue
                                    }
                                    const response = await localLLM.complete(
                                        msgs.map(m => ({
                                            role: m.role as 'system' | 'user' | 'assistant',
                                            content: m.content,
                                            ...(m.image && { image: m.image }),
                                        })),
                                        (tools || []) as any,
                                    )
                                    return { content: response.content, toolCalls: response.toolCalls, usage: undefined }
                                } catch (err) {
                                    lastLocalError = err
                                    failedEndpoints.add(discovered.endpoint)
                                    console.log(`[ModelFallback] Local candidate ${discovered.model} failed: ${String(err).slice(0, 120)}`)
                                }
                            }
                            throw lastLocalError
                        }

                        // Cloud fallback — map provider name
                        const sdkProv = _provider
                        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
                        activeLLM = await createNovaLLMClient({ provider: sdkProv as any, model: fallbackModel })
                    }

                    const response = await activeLLM.complete(
                        msgs.map(m => ({
                            role: m.role as 'system' | 'user' | 'assistant',
                            content: m.content,
                            ...(m.image && { image: m.image }),
                        })),
                        tools as any
                    )
                    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage }
                },
                onError: ({ model: errModel, error, attempt, total }) => {
                    console.log(`[ModelFallback] ❌ ${errModel} failed (${attempt}/${total}): ${error instanceof Error ? error.message.slice(0, 100) : 'unknown'}`)
                },
            }).then(result => {
                if (result.attempts.length > 0) {
                    // Log fallback usage but DO NOT persist as new primary model
                    // Persisting causes endless ping-pong: A→B→A→B between requests
                    const reasons = result.attempts.map(a => `${a.model}: ${a.reason || 'error'}`).join(', ')
                    console.log(`[ModelFallback] ✅ Used fallback ${result.model} (primary: ${activeModelId}) — ${reasons}`)
                }
                return result.result
            })
        }
    }

    // Set active model in global state for getDefaultModel() runtime lookup
    if ((globalThis as any).__novaState) {
        (globalThis as any).__novaState.activeModel = activeModelId
    }

    return wrapper
}
