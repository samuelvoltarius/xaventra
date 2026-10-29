/**
 * Nova LLM Factory - Extracted from daemon.ts
 * 
 * Handles LLM detection, creation, model switching, and smart routing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'
import { isPlaintextProviderKey, providerKeyProfileId, rehydrateConfigProviderKeys, resolveProviderKey } from '../secrets/provider-keys.js'
import { fetchModelList } from '../llm/model-list-cache.js'
import { readProbeResults } from '../llm/capability-probe.js'



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
            detail: `MiniMax ist bis ${new Date(minimaxBlockedUntil).toISOString()} gesperrt; Xaventra verwendet lokale Modelle.`,
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
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            // 2.89.5: `apiKey` on disk is a vault reference — fill it from the
            // sealed 0600 store so consumers keep seeing a usable `apiKey`.
            _configCache = rehydrateConfigProviderKeys(JSON.parse(readFileSync(configPath, 'utf-8'))) as NovaConfig
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
        // 2.82.0 schema fix: the probe cache has `results` (not `models`); read it through
        // the probe module itself so the format has one reader.
        for (const capability of readProbeResults() as any[]) {
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
                    const resp = await fetchModelList('https://api.openai.com/v1/models', {
                        headers: { 'Authorization': `Bearer ${openaiKey}` },
                        timeoutMs: 5000,
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
                    const resp = await fetchModelList('https://api.anthropic.com/v1/models', {
                        headers: {
                            'x-api-key': anthropicKey,
                            'anthropic-version': '2023-06-01',
                        },
                        timeoutMs: 5000,
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
                    const resp = await fetchModelList('https://openrouter.ai/api/v1/models', {
                        headers: { 'Authorization': `Bearer ${openrouterKey}` },
                        timeoutMs: 5000,
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
                    const resp = await fetchModelList('https://api.groq.com/openai/v1/models', {
                        headers: { 'Authorization': `Bearer ${groqKey}` },
                        timeoutMs: 5000,
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
                            const resp = await fetchModelList(`${ext.baseUrl}/models`, {
                                headers: { 'Authorization': `Bearer ${ext.apiKey}` },
                                timeoutMs: 5000,
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

/** Cloud section names in `providers.*` whose key lives in the sealed vault. */
const CLOUD_CONFIG_PROVIDERS = new Set(['minimax', 'openai', 'anthropic', 'claude', 'openrouter', 'groq'])
/**
 * Cloud sections that may serve as an automatic fallback. openrouter and groq are
 * excluded: they are built through the `openai` SDK provider, which ignores
 * `baseUrl` and would send their key to the OpenAI endpoint (2.89.7).
 */
const CLOUD_FALLBACK_PROVIDERS = new Set(['minimax', 'openai', 'anthropic', 'claude'])
/** Config/discovery provider name → the SDK provider the client is built with. */
function toSdkCloudProvider(name: string): string {
    const value = String(name || '').toLowerCase()
    if (value === 'anthropic' || value === 'claude') return 'claude'
    if (value === 'minimax') return 'minimax'
    if (['openai', 'openai-codex', 'openrouter', 'groq'].includes(value)) return 'openai'
    return ''
}
/** Alias list under which a cloud provider's key may be configured. */
function cloudProviderAliases(name: string): string[] {
    const value = String(name || '').toLowerCase()
    const sdk = toSdkCloudProvider(value)
    return [...new Set([value, sdk, value === 'claude' ? 'anthropic' : '', sdk === 'claude' ? 'anthropic' : ''].filter(Boolean))]
}
/**
 * Credentials of a cloud provider as the vault rehydrates them into
 * `providers.<name>` (see `getNovaConfig`). Undefined when nothing is configured.
 */
export function cloudProviderCredentials(name: string): { apiKey?: string; baseUrl?: string } | undefined {
    const providers = getNovaConfig().providers || {}
    for (const alias of cloudProviderAliases(name)) {
        const section = providers[alias]
        if (section && (section.apiKey || section.baseUrl)) return { apiKey: section.apiKey, baseUrl: section.baseUrl }
    }
    return undefined
}
/** Environment variables that carry a cloud provider's key (the service.env way). */
const PROVIDER_KEY_ENV: Record<string, string[]> = {
    minimax: ['MINIMAX_API_KEY'], openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], claude: ['ANTHROPIC_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'], groq: ['GROQ_API_KEY'],
}

/**
 * P0 (28.10.2026): the key of a built-in cloud provider, wherever it lives. The daemon hands
 * createLLM its loaded config, whose section carries only `apiKeyRef` after the vault move —
 * reading `section.apiKey` alone made MiniMax "keyless" and every turn fell back to local.
 * Order: plaintext in the section → its vault reference → the rehydrated config → the
 * provider's vault profile → environment (MINIMAX_API_KEY, …). Never logged.
 */
export function cloudProviderKey(name: string, section?: any): string {
    const lower = String(name || '').toLowerCase()
    if (isPlaintextProviderKey(section?.apiKey)) return section.apiKey
    const fromSection = resolveProviderKey(section)
    if (fromSection) return fromSection
    const rehydrated = cloudProviderCredentials(lower)?.apiKey
    if (isPlaintextProviderKey(rehydrated)) return rehydrated
    for (const alias of cloudProviderAliases(lower)) {
        const fromVault = resolveProviderKey({ apiKeyRef: `auth:${providerKeyProfileId(alias)}` })
        if (fromVault) return fromVault
    }
    for (const variable of PROVIDER_KEY_ENV[lower] || []) {
        const value = process.env[variable]
        if (isPlaintextProviderKey(value)) return value
    }
    return ''
}

/** Names a self-registered provider may not take over: they already have a built-in route. */
const RESERVED_PROVIDER_NAMES = new Set([...CLOUD_CONFIG_PROVIDERS, 'openai-codex', 'local', 'ollama', 'lm-studio', 'lmstudio', 'llama-cpp', 'vllm'])

/**
 * Registered providers as register_llm_provider stored them, key rehydrated from the sealed vault.
 * (Read here, not via model-resolver: a static import of that module from this one makes tsc mis-infer
 * unrelated regex match results to `never` - the file format is the contract, same as model-resolver's.)
 */
function readRegisteredProviders(): Array<{ name: string; baseUrl: string; apiKey: string; models: string[]; enabled: boolean }> {
    try {
        const file = join(process.cwd(), '.nova-data', 'external-providers.json')
        if (!existsSync(file)) return []
        const list = JSON.parse(readFileSync(file, 'utf-8'))
        if (!Array.isArray(list)) return []
        return list.filter(entry => entry && typeof entry === 'object' && entry.name).map((entry: any) => {
            const name = String(entry.name)
            const apiKey = (entry.apiKey && !/^(?:auth|tresor|ref):/i.test(String(entry.apiKey)) && !String(entry.apiKey).startsWith('nova-sealed:') ? String(entry.apiKey) : '')
                || resolveProviderKey({ apiKeyRef: entry.apiKeyRef || `auth:${providerKeyProfileId(name)}` })
                || resolveProviderKey({ apiKeyRef: `auth:llm-provider:${name}` })
            return { name, baseUrl: String(entry.baseUrl || ''), apiKey, models: Array.isArray(entry.models) ? entry.models.map(String) : [], enabled: entry.enabled !== false }
        })
    } catch { return [] }
}

/**
 * 2.89.7: route of an owner-REGISTERED OpenAI-compatible provider (register_llm_provider:
 * `.nova-data/external-providers.json`, key in the sealed vault) for an explicitly named model.
 * Only an enabled provider that lists the model, has a vault-resolvable key and a plain http(s)
 * baseUrl yields a route - otherwise undefined and the model is not a candidate.
 */
export function registeredProviderRoute(model: string, providerName?: string): { name: string; baseUrl: string; apiKey: string } | undefined {
    const wanted = String(model || '').trim()
    if (!wanted) return undefined
    let configured: Record<string, any> = {}
    try { configured = getNovaConfig().providers || {} } catch { /* config optional */ }
    const list = readRegisteredProviders()
    for (const ext of list) {
        const name = String(ext?.name || '')
        if (!name || RESERVED_PROVIDER_NAMES.has(name.toLowerCase())) continue
        if (providerName && name.toLowerCase() !== providerName.toLowerCase()) continue
        if (!ext.enabled || configured[name]?.enabled === false) continue
        if (!ext.models.includes(wanted)) continue
        const apiKey = String(ext.apiKey || '')
        if (!apiKey) continue
        const baseUrl = String(ext.baseUrl || configured[name]?.baseUrl || '').replace(/\/+$/, '')
        if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) continue
        return { name, baseUrl, apiKey }
    }
    return undefined
}

/** Built-in provider names createLLM knows how to build (anything else must be a registered provider, or it fails closed). */
const BUILTIN_PRIMARY_PROVIDERS: Record<string, 'claude' | 'openai' | 'local' | 'minimax'> = {
    'anthropic': 'claude',
    'claude': 'claude',
    'openai': 'openai',
    'openai-codex': 'openai',   // OAuth transport, never a baseUrl
    'local': 'local',
    'ollama': 'local',
    'lm-studio': 'local',
    'lmstudio': 'local',
    'llama-cpp': 'local',
    'vllm': 'local',
    'minimax': 'minimax',
}
/** OpenAI-compatible hosts that are reached through their own baseUrl (never through the `openai` SDK provider). */
const OPENAI_COMPATIBLE_DEFAULT_URLS: Record<string, string> = {
    'openrouter': 'https://openrouter.ai/api/v1',
    'groq': 'https://api.groq.com/openai/v1',
}

/**
 * 2.89.8: how the configured PRIMARY provider is reached.
 *  - `route`: an exclusive endpoint (owner-registered provider, or openrouter/groq with their real baseUrl):
 *    called at exactly that baseUrl with its own key, never through the `openai` SDK provider (which ignores
 *    baseUrl and would send the key to the OpenAI endpoint).
 *  - `failClosed`: the name is neither built in nor usable as a registered provider - nothing is built for it.
 *  - neither: a built-in provider, handled by the regular path.
 */
export function resolvePrimaryRoute(provider: string | undefined, model: string | undefined, inlineProviders?: Record<string, any>):
    { route?: { name: string; baseUrl: string; apiKey: string; model: string; models: string[] }; failClosed?: string } {
    const name = String(provider || 'local').trim()
    const lower = name.toLowerCase()
    if (lower in BUILTIN_PRIMARY_PROVIDERS) return {}
    let configured: Record<string, any> = {}
    try { configured = { ...(inlineProviders || {}), ...(getNovaConfig().providers || {}) } } catch { configured = { ...(inlineProviders || {}) } }
    const wanted = model && model !== 'auto' ? String(model).trim() : ''
    if (lower in OPENAI_COMPATIBLE_DEFAULT_URLS) {
        const section = configured[lower] || configured[name] || {}
        const apiKey = String(section.apiKey || '')
        const baseUrl = String(section.baseUrl || OPENAI_COMPATIBLE_DEFAULT_URLS[lower]).replace(/\/+$/, '')
        if (!apiKey) return { failClosed: `${name} has no API key` }
        if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) return { failClosed: `${name} has no usable baseUrl` }
        if (!wanted) return { failClosed: `${name} needs an explicit model` }
        return { route: { name, baseUrl, apiKey, model: wanted, models: [wanted] } }
    }
    const entry = readRegisteredProviders().find(item => item.name.toLowerCase() === lower)
    if (!entry || !entry.enabled || configured[entry.name]?.enabled === false) {
        return { failClosed: `provider "${name}" is neither built in nor registered (register_llm_provider)` }
    }
    const chosen = wanted || entry.models[0] || ''
    if (!chosen) return { failClosed: `registered provider "${name}" lists no model` }
    const route = registeredProviderRoute(chosen, entry.name)
    if (!route) return { failClosed: `registered provider "${name}" cannot serve "${chosen}" (model not listed, no vault key or no http(s) baseUrl)` }
    return { route: { ...route, model: chosen, models: entry.models } }
}

const PROVIDER_HINTS: Array<[RegExp, string]> = [
    [/^(?:gpt-|o\d|chatgpt)/i, 'openai'],
    [/^claude/i, 'claude'],
    [/^minimax/i, 'minimax'],
]

/**
 * Owner-approved cloud fallbacks from `fallbackModels` (2.89.6). A node without
 * the Main GPU cannot reach the configured local model; it must fall over to a
 * cloud provider the owner configured (key from the sealed provider vault)
 * instead of hanging. Only explicitly listed models are ever routed to a cloud —
 * discovery never widens this list. The `provider` is the configured section
 * name so the credential lookup keeps hitting the right vault profile.
 */
export function configuredCloudFallbacks(): Array<{ provider: string; model: string }> {
    const cfg = getNovaConfig()
    const listed = Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : []
    const providers = cfg.providers || {}
    const keyedCloud = Object.entries(providers)
        .filter(([name, section]: [string, any]) => CLOUD_FALLBACK_PROVIDERS.has(name.toLowerCase()) && Boolean(section?.apiKey))
        .map(([name]) => name.toLowerCase())
    const out: Array<{ provider: string; model: string }> = []
    for (const item of listed) {
        const model = String(item || '').trim()
        if (!model) continue
        // 2.89.7: a model the owner's own registered provider lists is an explicit cloud route
        // (its baseUrl + vault key) - checked first, it is the more specific statement.
        const registered = registeredProviderRoute(model)
        if (registered) {
            if (!out.some(entry => entry.model === model && entry.provider === registered.name)) out.push({ provider: registered.name, model })
            continue
        }
        // A model a local runtime serves is a LOCAL fallback; the local chain
        // already covers it and must stay in front of any cloud route.
        const discovered = availableLLMs.find(entry => entry.model === model)
        if (discovered && isLocalLLMEntry(discovered)) continue
        const fromDiscovery = discovered && !isLocalLLMEntry(discovered) ? String(discovered.provider).toLowerCase() : ''
        const hinted = PROVIDER_HINTS.find(([pattern]) => pattern.test(model))?.[1] || ''
        const provider = [fromDiscovery, hinted, String(cfg.provider || '').toLowerCase(), ...keyedCloud]
            .map(name => name.toLowerCase())
            .find(name => (CLOUD_FALLBACK_PROVIDERS.has(name) || name === 'openai-codex') && Boolean(cloudProviderCredentials(name)))
        if (!provider) continue
        if (out.some(entry => entry.model === model && entry.provider === provider)) continue
        out.push({ provider, model })
    }
    return out
}

/** True while the SDK holds this endpoint as unreachable (see nova-llm-sdk server health). */
async function isEndpointHeld(endpoint: string): Promise<boolean> {
    try { return Boolean((await import('../llm/nova-llm-sdk.js')).isServerUnreachable?.(endpoint)) } catch { return false }
}

export async function createLLM(config: { provider?: string; model?: string; internalModel?: string;[key: string]: any }) {
    // Detect available LLMs on first call
    if (availableLLMs.length === 0) {
        await detectAvailableLLMs()
    }

    // 2.89.8: an unknown provider name must never fall onto the `openai` SDK provider (it ignores baseUrl, the
    // key of a self-registered provider would go to the OpenAI endpoint). Registered providers (and openrouter/
    // groq) get an exclusive client at their own baseUrl; anything else fails closed onto the local chain.
    const primaryRoute = resolvePrimaryRoute(config.provider, config.model, config.providers)
    const exclusivePrimary = primaryRoute.route
    const requestedProvider = config.provider
    if (primaryRoute.failClosed) {
        console.error(`[Nova] Primary provider "${requestedProvider}" refused (fail-closed, no key leaves this machine): ${primaryRoute.failClosed}. Using the local chain instead.`)
        const state = (globalThis as any).__novaState
        if (state) {
            state.providerHealth = {
                ...(state.providerHealth || {}),
                [String(requestedProvider)]: { status: 'unavailable', reason: 'provider_not_usable', detail: primaryRoute.failClosed },
            }
        }
        config = { ...config, provider: 'local', model: '' }
    }
    const failedClosed = Boolean(primaryRoute.failClosed)

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

    const sdkProvider = exclusivePrimary ? 'local' : (providerMap[config.provider || 'local'] ?? 'local')
    const configuredSection = exclusivePrimary ? undefined : (config.providers?.[config.provider || 'local']
        || (getNovaConfig() as any)?.providers?.[config.provider || 'local'])
    const explicitLocalEndpoint = sdkProvider === 'local' && !exclusivePrimary && configuredSection?.enabled !== false
        ? configuredSection?.baseUrl : undefined

    // Dynamic model selection: use config model if explicitly set,
    // otherwise pick the first available discovered model
    let model = exclusivePrimary ? exclusivePrimary.model : ((config.model && config.model !== 'auto') ? config.model : '')
    if (exclusivePrimary) {
        // Listed so discovery/status show the real provider; no endpoint or key in the entry.
        for (const listed of new Set([exclusivePrimary.model, ...exclusivePrimary.models])) {
            if (!availableLLMs.some(l => l.model === listed && l.provider === exclusivePrimary.name)) {
                availableLLMs.push({ provider: exclusivePrimary.name, model: listed, local: false })
            }
        }
    }

    // If config explicitly sets a model, TRUST IT — even if not in discovered list.
    // This is critical for OAuth subscription access where /v1/models doesn't work
    // but the models ARE available for chat/completions.
    if (!exclusivePrimary && model && !availableLLMs.some(l => l.model === model)) {
        if (sdkProvider === 'local' && explicitLocalEndpoint) {
            // Discovery is opportunistic, not proof that an explicitly selected
            // endpoint is offline. Keep the requested model; execution will
            // verify availability instead of sending the invented ID "unknown".
            availableLLMs.unshift({ provider: 'local', model, local: true, endpoint: explicitLocalEndpoint })
            console.log(`[Nova] Configured local model "${model}" retained; endpoint availability is verified on use`)
        } else if (sdkProvider === 'local') {
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
        // A refused (fail-closed) provider never lands on a cloud entry: local chain only.
        const autoSelected = failedClosed
            ? (firstLocal || availableLLMs.find(l => isLocalLLMEntry(l)))
            : (firstCloud || firstLocal || availableLLMs.find(l => !l.local) || availableLLMs[0])
        if (autoSelected) {
            console.log(`[Nova] ✅ Auto-selecting: ${autoSelected.provider}/${autoSelected.model}`)
            model = autoSelected.model
        } else {
            model = failedClosed ? 'auto' : 'unknown'
            console.log(`[Nova] ❌ No models discovered at all! LLM calls will fail until /login or Ollama is started.`)
        }
    }

    const selectedCloud = (explicitLocalEndpoint || exclusivePrimary || failedClosed) ? undefined : availableLLMs.find(l => l.model === model && !l.local)
    const effectiveSdkProvider = selectedCloud
        ? (selectedCloud.provider === 'openai-codex'
            ? 'openai'
            : (providerMap[selectedCloud.provider] ?? sdkProvider))
        : sdkProvider

    // ── CLOUD PROVIDER LOCK ─────────────────────────────────────────────────────
    // If the user explicitly configured a cloud provider (minimax, openai, anthropic),
    // ALWAYS use that provider's cloud endpoint. Never let a local/mesh discovery
    // entry "hijack" the model name. This was a real bug: when the vLLM server came
    // online (OpenAI-compatible), it matched model="MiniMax-M3" + endpoint + apiKey,
    // so MiniMax-M3 requests were silently routed to local Qwen3.6-27B instead.
    const CLOUD_PROVIDERS = new Set(['minimax', 'openai', 'anthropic', 'openrouter', 'groq'])
    const configuredProvider = (config.provider || '').toLowerCase()
    const isCloudLocked = !exclusivePrimary && CLOUD_PROVIDERS.has(configuredProvider)

    const selectedLocal = (!isCloudLocked && effectiveSdkProvider === 'local')
        ? availableLLMs.find(l => l.model === model && isLocalLLMEntry(l) && l.endpoint)
        : undefined
    // When cloud-locked, ignore discovery entries — only the configured cloud counts
    const selectedExternal = (isCloudLocked || exclusivePrimary)
        ? undefined
        : availableLLMs.find(l => l.model === model && l.endpoint && l.apiKey)

    let providerApiKey = selectedExternal?.apiKey
    let providerBaseUrl = selectedExternal?.endpoint || selectedLocal?.endpoint
    try {
        const providerSection = configuredSection
        // P0: a cloud section after the vault move holds only a reference — resolve it (vault, env).
        const sectionKey = CLOUD_CONFIG_PROVIDERS.has(String(config.provider || '').toLowerCase())
            ? cloudProviderKey(String(config.provider), providerSection)
            : providerSection?.apiKey
        if (sectionKey) {
            providerApiKey = sectionKey   // cloud config wins
        }
        if (providerSection?.baseUrl) {
            providerBaseUrl = providerSection.baseUrl  // cloud config wins
        }
    } catch { /* optional */ }

    // Cloud-locked → force the SDK provider (minimax/openai/anthropic), never 'local'
    const finalProvider = isCloudLocked
        ? (configuredProvider === 'minimax' ? 'minimax' : effectiveSdkProvider)
        : (selectedExternal ? 'local' : effectiveSdkProvider)

    // 2.89.8: exclusive route = exactly this baseUrl + its own key, no failover candidates (same client as the
    // 2.89.7 registered-provider fallback). The key lives only in this client, not in availableLLMs or logs.
    const llm = await createNovaLLMClient(exclusivePrimary
        ? { provider: 'local', model, baseUrl: exclusivePrimary.baseUrl, apiKey: exclusivePrimary.apiKey, exclusive: true }
        : {
            provider: finalProvider as any,
            model,
            baseUrl: providerBaseUrl,
            apiKey: providerApiKey,
        })
    if (exclusivePrimary) console.log(`[Nova] Primary: ${exclusivePrimary.name}/${model} @ ${exclusivePrimary.baseUrl} (own endpoint + vault key; fallback: local chain, then fallbackModels)`)

    if (isCloudLocked) {
        console.log(`[Nova] ☁️ Primary: ${configuredProvider}/${model} @ ${providerBaseUrl || 'default'} (cloud preferred, fast-local fallback)`)
    }

    const initialConfig = llm.getCurrentConfig()
    console.log(`[Nova] ✓ Primary LLM: ${config.provider}/${model} (SDK: ${exclusivePrimary ? `own endpoint ${exclusivePrimary.name}` : sdkProvider})`)
    console.log(`[Nova] ✓ L18 Router: ${availableLLMs.length} models available`)

    type LLMProviderType = 'claude' | 'openai' | 'local' | 'minimax'
    // Mutable state — updated when model is switched at runtime
    // Runtime identity must describe the provider that createNovaLLMClient
    // actually configured after readiness checks. The requested config remains
    // available separately, but must not masquerade as an active provider.
    let activeModelId = initialConfig?.model || model
    let activeProvider: LLMProviderType = (exclusivePrimary ? exclusivePrimary.name : (initialConfig?.provider || config.provider || effectiveSdkProvider)) as LLMProviderType

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
        async switchModel(newModel: string, newProvider?: string, endpoint?: string): Promise<boolean> {
            let resolvedProvider = newProvider || activeProvider
            // `endpoint` pins the exact runtime when the same model is served twice
            // (Stufe 3: switch to the second known endpoint and back).
            const discovered = availableLLMs.find(l =>
                l.model === newModel &&
                (!endpoint || l.endpoint === endpoint) &&
                (newProvider ? l.provider === newProvider || (newProvider === 'local' && isLocalLLMEntry(l)) : true)
            )
            if (endpoint && !discovered) return false

            // 2.89.8: a non-built-in provider name is a registered provider (own baseUrl + vault key) or nothing;
            // it is never handed to the `openai` SDK provider below.
            const switchName = String(newProvider || activeProvider || '')
            if (switchName && !(switchName.toLowerCase() in BUILTIN_PRIMARY_PROVIDERS) && !(switchName.toLowerCase() in OPENAI_COMPATIBLE_DEFAULT_URLS)) {
                const route = registeredProviderRoute(newModel, switchName)
                if (!route) {
                    console.error(`[NovaLLM] Switch to ${switchName}/${newModel} refused (fail-closed): not a registered provider that lists this model with a vault key`)
                    return false
                }
                llm.configure({ provider: 'local', model: newModel, baseUrl: route.baseUrl, apiKey: route.apiKey, exclusive: true } as any)
                ; (wrapper as any)._openaiAdapter = null
                ; (wrapper as any)._anthropicAdapter = null
                ; (wrapper as any)._minimaxAdapter = null
                activeModelId = newModel
                activeProvider = route.name as LLMProviderType
                console.log(`[NovaLLM] Switched to ${route.name}/${newModel} (registered provider, own endpoint)`)
                return true
            }

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
                    ; (wrapper as any)._minimaxAdapter = null
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
                            const baseUrl = openaiCompatible[resolvedProvider] || 'https://api.openai.com/v1'
                            // Same OpenAI-compatible SDK contract as external
                            // providers: keeps tools, tool turns, limits and usage
                            // (the legacy adapter silently dropped all of them).
                            const { createNovaLLMClient: createSwitchClient } = await import('../llm/nova-llm-sdk.js')
                            const openaiLLM = await createSwitchClient({ provider: 'local', model: newModel, baseUrl, apiKey, isolated: true })
                                // Patch the wrapper's complete to use this adapter
                                ; (wrapper as any)._openaiAdapter = openaiLLM
                                ; (wrapper as any)._anthropicAdapter = null
                                ; (wrapper as any)._minimaxAdapter = null
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
                                ; (wrapper as any)._minimaxAdapter = null
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
                    ; (wrapper as any)._minimaxAdapter = null  // complete() would still prefer MiniMax
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

                // NEVER persist automatic model switches to xaventra.config.json.
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
        // The user set a model in xaventra.config.json — that is the model to use.
        // L18 router is only consulted for FALLBACK when the primary fails.
        async selectModelForTask(_content: string, _hasImage: boolean = false) {
            // Return the currently active model (= xaventra.config.json model)
            // No auto-routing based on task type — user decides, not the router.
            return { model: activeModelId, provider: activeProvider, reason: 'configured primary model' }
        },

        complete: async (msgs: Array<{ role: string; content: string; image?: { data: string; mimeType: string }; toolCalls?: any[]; toolCallId?: string }> | string, tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>, options?: import('../llm/nova-llm-sdk.js').LLMCallOptions) => {
            options?.signal?.throwIfAborted()
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
                                signal: options?.signal,
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
                    options?.signal?.throwIfAborted()
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
                                signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
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
                        options?.signal?.throwIfAborted()
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
                            signal: options?.signal,
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
                        minimaxAdapter.setModel?.(originalModel)
                        options?.signal?.throwIfAborted()
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
                    const response = await openaiAdapter.complete(msgs as any, (tools || []) as any, options)
                    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage }
                } catch (err) {
                    options?.signal?.throwIfAborted()
                    // Fall back for this call only. Dropping the adapter would
                    // silently return every later call to the previous model.
                    console.log(`[NovaLLM] ${activeProvider}/${activeModelId} failed, falling back for this call: ${err}`)
                }
            }

            const { runWithModelFallback, getDefaultFallbacks, localFallbackCandidates, FailoverError, isFailoverError } = await import('../llm/model-fallback.js')
            // 2.89.14 (Abnahme 2.89.13, task D): with providers.local.enabled = false the turn tried
            // local/auto after a MiniMax timeout and hung until the run deadline (105 s). Switched off
            // means no local fallback: only the owner's explicit cloud fallbacks, otherwise fail now.
            const localOff = (getNovaConfig() as any)?.providers?.local?.enabled === false
            const cloudOnly = localOff ? configuredCloudFallbacks() : []
            if (localOff && cloudOnly.length === 0) {
                throw new Error(`Kein Ersatzmodell: ${activeProvider}/${activeModelId} ist fehlgeschlagen, lokale Modelle sind abgeschaltet (providers.local.enabled=false) und keine Cloud-Ersatzmodelle (fallbackModels) konfiguriert`)
            }
            const fallbackEntry = localOff
                ? cloudOnly[0]
                : minimaxAdapter || activeProvider === 'minimax'
                ? { provider: 'local', model: 'auto' }
                : { provider: activeProvider, model: activeModelId }
            // 2.85: fallback targets only from what the KI scanner sees RUNNING (with its models);
            // installed-but-stopped runtimes and guessed names are never tried.
            let runningServices: Array<{ name?: string; type?: string; status: string; endpoint: string; models: string[] }> = []
            try {
                const scanner = await import('../mesh/ai-scanner.js')
                runningServices = scanner.getLastScanResult() ? scanner.getRunningServices() : []
            } catch { runningServices = [] }

            return runWithModelFallback({
                signal: options?.signal,
                provider: fallbackEntry.provider,
                model: fallbackEntry.model,
                // Local chain first, then the cloud models the owner listed in
                // fallbackModels: a standby without the Main GPU has no reachable
                // local model and must use the configured cloud instead of hanging.
                fallbacks: localOff ? cloudOnly.slice(1) : [...getDefaultFallbacks(runningServices), ...configuredCloudFallbacks()],
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
                            const candidates = localFallbackCandidates(localEntries, fallbackModel, runningServices)
                            // A dead local runtime is a failover-worthy failure,
                            // not a fatal one: the chain must reach the
                            // owner-configured cloud fallback (2.89.6).
                            if (candidates.length === 0) throw new FailoverError(
                                fallbackModel === 'auto' ? 'Kein laufendes lokales LLM entdeckt' : `${fallbackModel} läuft auf keinem erreichbaren Endpunkt`,
                                { reason: 'timeout', provider: _provider, model: fallbackModel },
                            )
                            const failedEndpoints = new Set<string>()
                            let lastLocalError: unknown = new Error('Kein lokales LLM erreichbar')
                            for (const discovered of candidates.slice(0, 4) as LLMEntry[]) {
                                options?.signal?.throwIfAborted()
                                if (!discovered.endpoint || failedEndpoints.has(discovered.endpoint)) continue
                                // 2.89.7: an endpoint already held as unreachable is not asked again (no 3 s probe per message).
                                if (await isEndpointHeld(discovered.endpoint)) { failedEndpoints.add(discovered.endpoint); continue }
                                const localLLM = createLocalLLM({
                                    baseUrl: discovered.endpoint,
                                    model: discovered.model,
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
                                    options?.signal?.throwIfAborted()
                                    if (!available) {
                                        failedEndpoints.add(discovered.endpoint)
                                        continue
                                    }
                                    // Discovery verifies availability; use the same SDK
                                    // execution contract as the primary route. The legacy
                                    // adapter discarded tool-call IDs, usage and limits.
                                    const fallbackClient = await createNovaLLMClient({
                                        provider: 'local', model: localLLM.getModel(),
                                        baseUrl: discovered.endpoint, isolated: true,
                                    })
                                    const response = await fallbackClient.complete(msgs as any, (tools || []) as any, {
                                        ...options,
                                        timeoutMs: options?.timeoutMs ?? (isSlowBig(discovered.model) ? 55_000 : 25_000),
                                    })
                                    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage }
                                } catch (err) {
                                    options?.signal?.throwIfAborted()
                                    lastLocalError = err
                                    failedEndpoints.add(discovered.endpoint)
                                    console.log(`[ModelFallback] Local candidate ${discovered.model} failed: ${String(err).slice(0, 120)}`)
                                }
                            }
                            throw isFailoverError(lastLocalError)
                                ? lastLocalError
                                : new FailoverError(String((lastLocalError as Error)?.message || lastLocalError || 'Kein lokales LLM erreichbar'),
                                    { reason: 'timeout', provider: _provider, model: fallbackModel, cause: lastLocalError })
                        }

                        // 2.89.7: an owner-registered provider (own baseUrl + vault key) listed in
                        // fallbackModels. Exactly its endpoint, never widened to other candidates.
                        const registeredRoute = registeredProviderRoute(fallbackModel, _provider)
                        if (registeredRoute) {
                            const listedFallbacks = (getNovaConfig() as any)?.fallbackModels
                            if (!Array.isArray(listedFallbacks) || !listedFallbacks.includes(fallbackModel)) {
                                throw new Error(`Cloud-Failover auf ${_provider}/${fallbackModel} nicht freigegeben (nicht in fallbackModels konfiguriert)`)
                            }
                            activeLLM = await createNovaLLMClient({
                                provider: 'local', model: fallbackModel,
                                baseUrl: registeredRoute.baseUrl, apiKey: registeredRoute.apiKey,
                                isolated: true, exclusive: true,
                            })
                        } else {
                        // Cloud fallback only to a model the owner listed in
                        // fallbackModels (or the provider already chosen as
                        // primary). Anything else is a visible error, never a
                        // silent route of the prompt to another cloud.
                        const configuredFallbacks = (getNovaConfig() as any)?.fallbackModels
                        const approved = _provider === activeProvider
                            || toSdkCloudProvider(_provider) === String(activeProvider)
                            || (Array.isArray(configuredFallbacks) && configuredFallbacks.includes(fallbackModel))
                        if (!approved) {
                            throw new Error(`Cloud-Failover auf ${_provider}/${fallbackModel} nicht freigegeben (nicht in fallbackModels konfiguriert)`)
                        }
                        const sdkProv = toSdkCloudProvider(_provider) || _provider
                        // The key comes from the sealed provider vault via the
                        // rehydrated config section — a standby without the Main
                        // GPU must not stall on a missing credential.
                        const credentials = cloudProviderCredentials(_provider)
                        activeLLM = await createNovaLLMClient({
                            provider: sdkProv as any,
                            model: fallbackModel,
                            ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
                            ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
                        })
                        }
                    }

                    const response = await activeLLM.complete(
                        msgs.map(m => ({
                            ...m,
                            role: m.role as 'system' | 'user' | 'assistant' | 'tool',
                            content: m.content,
                            ...(m.image && { image: m.image }),
                        })),
                        tools as any,
                        options,
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
