/**
 * Nova Model Resolver — Config-Driven Capability Resolution
 *
 * Uses the existing ai-scanner for network-wide device discovery,
 * then resolves the best model/service for each role.
 *
 * Scan-Ergebnis vom ai-scanner (mesh/ai-scanner.ts):
 *   - Alle lokalen AI Services (Ollama, LM Studio, llama.cpp, Whisper, Piper, etc.)
 *   - Alle Mesh-Nodes (via mesh-registry + Supabase)
 *   - Alle Geräte im Netzwerk (via xaventra.config.json → nodes)
 *   - Installierte aber nicht laufende Software ("Schlafende Schätze")
 *
 * Resolution priority:
 *   1. xaventra.config.json → models.{role}
 *   2. xaventra.config.json → model (global)
 *   3. ai-scanner results (best match per role)
 *   4. OpenAI cloud (via OAuth or API key)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sideEffectsDisabled } from './side-effects.js'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Types
// ============================================

export type ModelRole =
    | 'chat' | 'vision' | 'embedding' | 'small' | 'code' | 'reasoning'
    | 'tts' | 'stt' | 'image_gen'

export interface ResolvedModel {
    id: string
    provider: string
    role: ModelRole
    capabilities: string[]
    endpoint?: string
    host?: string
    contextWindow?: number
    /** API key for external cloud providers (MiniMax, Kimi, DeepSeek, etc.) */
    apiKey?: string
}

interface ResolverCache {
    version?: number
    timestamp: number
    resolved: Partial<Record<ModelRole, ResolvedModel>>
    scanSummary?: string
}

// ============================================
// Model preference lists (for picking best from scan results)
// ============================================

const OLLAMA_PREFS: Partial<Record<ModelRole, string[]>> = {
    vision: ['gemma3:27b', 'gemma3:12b', 'gemma3:4b', 'gemma3:latest', 'llava:34b', 'llava:13b', 'llava:latest'],
    chat: ['qwen3.5:27b', 'qwen3.5:9b', 'qwen3.6:35b', 'qwen3.6:27b', 'Intel/Qwen3-Coder-Next-int4-AutoRound', 'qwen2.5:14b', 'qwen2.5:7b', 'llama3:latest', 'mistral:latest', 'gemma3:27b', 'gemma3:12b', 'gemma3:4b', 'gemma3:latest'],
    code: ['qwen3.6:27b-coding-mxfp8', 'qwen3.6:27b-coding-nvfp4', 'Qwen2.5-Coder:latest', 'codellama:latest', 'deepseek-coder:latest', 'starcoder2:latest'],
    embedding: ['nomic-embed-text:latest', 'nomic-embed-text', 'mxbai-embed-large:latest', 'all-minilm:latest'],
    small: ['gemma3:4b', 'gemma3:latest', 'phi3:mini', 'tinyllama:latest'],
}

const KEYWORD_MAP: Partial<Record<ModelRole, string[]>> = {
    vision: ['vl', 'vision', 'llava', 'multimodal'],
    code: ['code', 'coder', 'codellama', 'deepseek-coder', 'starcoder'],
    embedding: ['embed', 'embedding', 'nomic-embed', 'bge', 'e5'],
}

const OPENAI_PREFS: Partial<Record<ModelRole, string[]>> = {
    chat: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3', 'gpt-5', 'gpt-5-mini'],
    vision: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3', 'gpt-5', 'gpt-5-mini'],
    code: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5-mini'],
    reasoning: ['gpt-5.5', 'o3', 'o3-mini', 'gpt-5.4-pro', 'gpt-5.4'],
    small: ['gpt-5-mini', 'gpt-5.3-instant'],
    embedding: ['text-embedding-3-large', 'text-embedding-3-small'],
    tts: ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'],
    stt: ['gpt-4o-mini-transcribe', 'whisper-1'],
    image_gen: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'],
}

// Map ai-scanner's AIServiceType to our ModelRole
const SERVICE_TYPE_TO_ROLE: Record<string, ModelRole> = {
    'llm': 'chat',
    'vlm': 'vision',
    'tts': 'tts',
    'stt': 'stt',
    'embeddings': 'embedding',
}

// ============================================
// State
// ============================================

const CACHE_FILE = join(process.cwd(), '.nova-data', 'resolver-cache.json')
const CACHE_TTL = 10 * 60 * 1000
const CACHE_VERSION = 2

let cache: ResolverCache | null = null
let detectPromise: Promise<void> | null = null

// ============================================
// Config
// ============================================

interface NovaModelConfig {
    provider: string
    model: string
    models: Record<string, string>
}

function readConfig(): NovaModelConfig {
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
            return {
                provider: cfg.provider || 'local',
                model: cfg.model || 'auto',
                models: cfg.models || {},
            }
        }
    } catch { /* defaults */ }
    return { provider: 'local', model: 'auto', models: {} }
}

/**
 * Returns true only for real OpenAI API keys (sk-… format).
 * Rejects OAuth access_tokens (JWT, eyJ…) which work on chatgpt.com/backend-api
 * but return 401 against api.openai.com/v1.
 */
function isRealApiKey(token: string): boolean {
    if (!token) return false
    // JWTs start with eyJ (base64url-encoded '{"') — these are OAuth tokens, not API keys
    if (token.startsWith('eyJ')) return false
    // OpenAI API keys start with sk-  (sk-proj-…, sk-None-…, etc.)
    return token.startsWith('sk-')
}

async function getOpenAIKey(): Promise<string | undefined> {
    // 1. Check dedicated OpenAI OAuth tokens (PKCE flow from /login openai)
    // Only accept if it's a real API key obtained via token-exchange, not the raw access_token
    try {
        throw new Error('legacy OAuth disabled')
        const { getOpenAIAccessToken } = await import('../auth/openai-oauth.js')
        const oauthToken = await getOpenAIAccessToken()
        if (oauthToken && isRealApiKey(oauthToken)) return oauthToken
        if (oauthToken && !isRealApiKey(oauthToken)) {
            console.log('[ModelResolver] OpenAI OAuth token is a JWT (access_token) — skipping for api.openai.com/v1')
        }
    } catch { /* openai-oauth module not available */ }

    // 2. Check generic OAuth manager (multiple profiles)
    try {
        const { getOAuthManager } = await import('../auth/oauth.js')
        const oauth = getOAuthManager()
        for (const profile of ['openai']) {
            const key = await oauth.getApiKey(profile)
            if (key && isRealApiKey(key)) return key
        }
    } catch { /* OAuth not available */ }

    // 3. Config file
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
            const configKey = cfg.auth?.openaiApiKey || cfg.providers?.openai?.apiKey
            if (configKey && isRealApiKey(configKey)) return configKey
        }
    } catch { /* ignore */ }

    // 4. Environment variable
    const envKey = process.env.OPENAI_API_KEY
    return envKey && isRealApiKey(envKey) ? envKey : undefined
}

// ============================================
// Matching Helpers
// ============================================

function findBestFromList(available: string[], candidates: string[]): string | null {
    for (const c of candidates) {
        // Exact match always wins
        if (available.includes(c)) return c
        // Prefix match ONLY for untagged or ':latest' — never for specific versions like gemma3:27b
        // (prevents gemma3:27b matching gemma3:4b and picking a weaker local model)
        const colonIdx = c.indexOf(':')
        const tag = colonIdx >= 0 ? c.slice(colonIdx + 1) : ''
        if (!tag || tag === 'latest') {
            const name = colonIdx >= 0 ? c.slice(0, colonIdx) : c
            const match = available.find(a => a.startsWith(name + ':') || a === name)
            if (match) return match
        }
    }
    return null
}

function findByKeyword(available: string[], keywords: string[]): string | null {
    for (const kw of keywords) {
        const match = available.find(m => m.toLowerCase().includes(kw))
        if (match) return match
    }
    return null
}

function findBestChat(models: string[]): string | null {
    const embedKw = KEYWORD_MAP.embedding || []
    const chatModels = models.filter(m => {
        const l = m.toLowerCase()
        return !embedKw.some(k => l.includes(k)) && !l.includes('nsfw') && !l.includes('wan2') && !l.includes('tts')
    })
    return chatModels[0] || null
}

function findBestOpenAI(available: string[], role: ModelRole): string | null {
    const prefs = OPENAI_PREFS[role] || OPENAI_PREFS.chat || []
    for (const pref of prefs) {
        if (available.includes(pref)) return pref
    }
    for (const pref of prefs) {
        const match = available.find(m => m.startsWith(pref))
        if (match) return match
    }
    return null
}

// ============================================
// OpenAI Cloud Discovery
// ============================================

async function discoverOpenAIModels(apiKey: string): Promise<string[]> {
    try {
        const resp = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
        })
        if (!resp.ok) return []
        const data = await resp.json() as { data?: Array<{ id: string }> }
        return (data.data || []).map(m => m.id)
    } catch { return [] }
}

async function discoverCodexModels(): Promise<string[]> {
    try {
        const { getCodexDiscoveryStatus } = await import('../llm/codex-cli-adapter.js')
        const status = getCodexDiscoveryStatus()
        if (!status.available || !status.authenticated) return []
        return status.models
    } catch { return [] }
}

// ============================================
// Core Detection — delegates to ai-scanner
// ============================================

async function detectCapabilities(): Promise<void> {
    if (detectPromise) { await detectPromise; return }

    detectPromise = (async () => {
        try {
            if (cache && cache.version === CACHE_VERSION && Date.now() - cache.timestamp < CACHE_TTL) return
            if (cache && cache.version !== CACHE_VERSION) {
                console.log(`[ModelResolver] Cache schema changed (${cache.version ?? 'legacy'} -> ${CACHE_VERSION}) — rescanning`)
                cache = null
            }

            const config = readConfig()

            // 1. Run ai-scanner (scans localhost, mesh nodes, installed software)
            let scanResult: import('../mesh/ai-scanner.js').AIScanResult | null = null
            try {
                const { scanAllAIServices } = await import('../mesh/ai-scanner.js')
                scanResult = await scanAllAIServices()
            } catch (err) {
                console.log(`[ModelResolver] ⚠ AI Scanner not available: ${err}`)
            }

            // 2. OpenAI cloud + registered external providers (parallel)
            const openaiKey = await getOpenAIKey()
            const [openaiModels, codexModels, externalProviderServices] = await Promise.all([
                openaiKey ? discoverOpenAIModels(openaiKey) : Promise.resolve([] as string[]),
                discoverCodexModels(),
                (async () => {
                    const extProviders = loadExternalProviders().filter(p => p.enabled)
                    const services: Array<{ name: string; endpoint: string; models: string[]; roles: ModelRole[]; apiKey: string }> = []
                    for (const p of extProviders) {
                        let models = p.models || []
                        if (models.length === 0) {
                            try {
                                const res = await fetch(`${p.baseUrl}/models`, {
                                    headers: { 'Authorization': `Bearer ${p.apiKey}` },
                                    signal: AbortSignal.timeout(5000),
                                })
                                if (res.ok) {
                                    const data = await res.json() as { data?: Array<{ id: string }> }
                                    models = data.data?.map(m => m.id) || []
                                }
                            } catch { /* offline */ }
                        }
                        if (models.length > 0) {
                            services.push({ name: p.name, endpoint: p.baseUrl, models, roles: p.roles || ['chat', 'code'], apiKey: p.apiKey })
                        }
                    }
                    return services
                })(),
            ])

            // 2b. Quick latency probe for running Ollama services — deprioritize slow/dead endpoints
            const endpointLatency = new Map<string, number>() // endpoint → ping ms (Infinity = dead)
            const runningOllamaServices = (scanResult?.services || []).filter(
                s => s.status === 'running' && (s.provider === 'ollama' || s.name === 'ollama')
            )
            await Promise.all(runningOllamaServices.map(async svc => {
                const start = Date.now()
                try {
                    const res = await fetch(`${svc.endpoint}/api/tags`, {
                        signal: AbortSignal.timeout(3000),
                    })
                    endpointLatency.set(svc.endpoint, res.ok ? Date.now() - start : Infinity)
                } catch {
                    endpointLatency.set(svc.endpoint, Infinity)
                }
                const lat = endpointLatency.get(svc.endpoint)!
                if (lat === Infinity) {
                    console.log(`[ModelResolver] ⚠ ${svc.endpoint} dead — excluded from routing`)
                } else {
                    console.log(`[ModelResolver] 🏓 ${svc.endpoint}: ${lat}ms`)
                }
            }))

            // 3. Resolve best model for each role
            const resolved: Partial<Record<ModelRole, ResolvedModel>> = {}
            const allRoles: ModelRole[] = ['chat', 'vision', 'embedding', 'code', 'reasoning', 'small', 'tts', 'stt', 'image_gen']
            // All discovered services — running first (sorted by latency), then installed
            const allServices = scanResult?.services || []
            const sortedServices = [
                // Running services sorted by latency (fast first, dead/untested last)
                ...allServices
                    .filter(s => s.status === 'running')
                    .sort((a, b) => {
                        const latA = endpointLatency.get(a.endpoint) ?? 9999
                        const latB = endpointLatency.get(b.endpoint) ?? 9999
                        return latA - latB
                    })
                    .filter(s => (endpointLatency.get(s.endpoint) ?? 0) < Infinity), // exclude dead
                ...allServices.filter(s => s.status === 'installed'),
                ...allServices.filter(s => s.status === 'stopped'),
            ]

            for (const role of allRoles) {
                const configModel = config.models[role]

                // Priority 1: Per-role config override
                if (configModel && configModel !== 'auto') {
                    resolved[role] = { id: configModel, provider: config.provider, role, capabilities: [role] }
                    continue
                }

                // Priority 2: Global model override (LLM roles only)
                const isLLM = ['chat', 'vision', 'code', 'reasoning', 'small'].includes(role)
                if (isLLM && config.model !== 'auto') {
                    resolved[role] = { id: config.model, provider: config.provider, role, capabilities: ['chat'] }
                    continue
                }

                let found = false

                // Priority 3: OpenAI/Codex subscription for LLM roles.
                // External providers are cloud fallbacks, but OpenAI/Codex is the
                // preferred primary when the subscription is available.
                if (!found && isLLM && (openaiModels.length > 0 || codexModels.length > 0)) {
                    const combinedOpenAIModels = [...openaiModels, ...codexModels]
                    const model = findBestOpenAI(combinedOpenAIModels, role)
                    if (model) {
                        const fromCodex = codexModels.includes(model) && !openaiModels.includes(model)
                        resolved[role] = {
                            id: model,
                            provider: fromCodex ? 'openai-codex' : 'openai',
                            role,
                            capabilities: [role],
                            endpoint: fromCodex ? undefined : 'https://api.openai.com/v1',
                        }
                        found = true
                    }
                }

                // Priority 4: Registered external providers (minimax, kimi, deepseek, etc.)
                if (!found && isLLM && externalProviderServices.length > 0) {
                    for (const ext of externalProviderServices) {
                        if (!ext.roles.includes(role)) continue
                        if (ext.models.length === 0) continue
                        resolved[role] = {
                            id: ext.models[0],
                            provider: ext.name,
                            role,
                            capabilities: [role],
                            endpoint: ext.endpoint,
                            apiKey: ext.apiKey,
                        }
                        found = true
                        break
                    }
                }

                // Priority 5: AI Scanner results (all devices in network, running + installed)
                if (!found && sortedServices.length > 0) {
                    // Direct type match (tts→tts, stt→stt, etc.)
                    const scanRole = Object.entries(SERVICE_TYPE_TO_ROLE).find(([, r]) => r === role)?.[0]
                    const matching = scanRole
                        ? sortedServices.filter(s => s.type === scanRole)
                        : []

                    // Also include LLM services for LLM sub-roles AND embedding
                    const llmServices = (isLLM || role === 'embedding')
                        ? sortedServices.filter(s => s.status === 'running' && s.type === 'llm' && s.models.length > 0)
                        : []

                    const candidates = [...matching, ...llmServices]

                    // For LLM/embedding roles: find the GLOBALLY best model across ALL services
                    // (not just the first service that has any match — avoids picking a weak local
                    //  model when a better one exists on a mesh node)
                    if (isLLM || role === 'embedding') {
                        const prefs = OLLAMA_PREFS[role]
                        let bestPrefIdx = Infinity
                        let bestModel: string | null = null
                        let bestSvc: typeof candidates[0] | null = null

                        for (const svc of candidates) {
                            if (!svc.models.length) continue
                            if (svc.provider !== 'ollama' && svc.name !== 'ollama') continue
                            if (!prefs) continue

                            for (let pi = 0; pi < prefs.length; pi++) {
                                if (pi >= bestPrefIdx) break   // can't beat current best
                                const pref = prefs[pi]
                                // Exact match
                                if (svc.models.includes(pref)) {
                                    bestPrefIdx = pi
                                    bestModel = pref
                                    bestSvc = svc
                                    break
                                }
                                // Prefix match only for :latest / untagged
                                const colonIdx = pref.indexOf(':')
                                const tag = colonIdx >= 0 ? pref.slice(colonIdx + 1) : ''
                                if (!tag || tag === 'latest') {
                                    const name = colonIdx >= 0 ? pref.slice(0, colonIdx) : pref
                                    const m = svc.models.find(a => a.startsWith(name + ':') || a === name)
                                    if (m) {
                                        bestPrefIdx = pi
                                        bestModel = m
                                        bestSvc = svc
                                        break
                                    }
                                }
                            }
                        }

                        if (bestModel && bestSvc) {
                            resolved[role] = { id: bestModel, provider: 'ollama', role, capabilities: [role], endpoint: bestSvc.endpoint, host: bestSvc.host }
                            found = true
                        }

                        // Keyword/fallback for non-ollama LLM services
                        if (!found) {
                            for (const svc of candidates) {
                                if (!svc.models.length) continue
                                const keywords = KEYWORD_MAP[role]
                                let model: string | null = null
                                if (keywords) model = findByKeyword(svc.models, keywords)
                                if (!model && isLLM) model = findBestChat(svc.models)
                                if (model) {
                                    resolved[role] = { id: model, provider: svc.name, role, capabilities: [role], endpoint: svc.endpoint, host: svc.host }
                                    found = true
                                    break
                                }
                            }
                        }
                    }

                    // For TTS/STT/image_gen: first running service wins
                    if (!found) {
                        for (const svc of candidates) {
                            if (role === 'tts' || role === 'stt' || role === 'image_gen') {
                                const statusLabel = svc.status === 'running' ? '' : ` [${svc.status}]`
                                resolved[role] = {
                                    id: `${svc.name}${statusLabel}`,
                                    provider: svc.name, role, capabilities: [role],
                                    endpoint: svc.endpoint, host: svc.host,
                                }
                                found = true
                                break
                            }
                        }
                    }
                }

                // Priority 6: OpenAI cloud / Codex subscription fallback
                if (!found && (openaiModels.length > 0 || codexModels.length > 0)) {
                    const combinedOpenAIModels = [...openaiModels, ...codexModels]
                    const model = findBestOpenAI(combinedOpenAIModels, role)
                    if (model) {
                        const fromCodex = codexModels.includes(model) && !openaiModels.includes(model)
                        resolved[role] = {
                            id: model,
                            provider: fromCodex ? 'openai-codex' : 'openai',
                            role,
                            capabilities: [role],
                            endpoint: fromCodex ? undefined : 'https://api.openai.com/v1',
                        }
                        found = true
                    }
                }

                // Priority 7: Registered external providers (minimax, kimi, deepseek, etc.)
                if (!found && externalProviderServices.length > 0) {
                    for (const ext of externalProviderServices) {
                        if (!ext.roles.includes(role)) continue
                        if (ext.models.length === 0) continue
                        // Pick first model from provider (they come pre-sorted by preference)
                        resolved[role] = {
                            id: ext.models[0],
                            provider: ext.name,
                            role,
                            capabilities: [role],
                            endpoint: ext.endpoint,
                            apiKey: ext.apiKey,   // ← forwarded so LLM client can auth
                        }
                        found = true
                        break
                    }
                }
            }

            // Build summary
            const deviceCount = new Set(allServices.map(s => s.host)).size
            const totalModels = allServices.reduce((sum, s) => sum + s.models.length, 0)
            const scanSummary = `${deviceCount} Geräte, ${totalModels} Models, ${openaiModels.length} OpenAI, ${codexModels.length} Codex`

            cache = { version: CACHE_VERSION, timestamp: Date.now(), resolved, scanSummary }

            // Persist
            try {
                const dir = join(process.cwd(), '.nova-data')
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
                writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
            } catch { /* non-critical */ }

            // Log
            console.log(`[ModelResolver] ✅ Resolution complete (${scanSummary}):`)
            for (const [role, model] of Object.entries(resolved)) {
                if (model) {
                    const loc = model.host && model.host !== 'localhost' && model.host !== '127.0.0.1' ? ` @ ${model.host}` : ''
                    console.log(`  ${role}: ${model.id} (${model.provider}${loc})`)
                }
            }
        } finally {
            detectPromise = null
        }
    })()

    await detectPromise
}

// ============================================
// Public API
// ============================================

export async function resolveModel(role: ModelRole): Promise<ResolvedModel | null> {
    const resolveFromCache = (): ResolvedModel | null => {
        const model = cache?.resolved[role]
        if (model) return model

        const llmRoles: ModelRole[] = ['chat', 'small', 'vision', 'code', 'reasoning']
        if (llmRoles.includes(role)) {
            for (const fb of llmRoles) {
                const fallback = cache?.resolved[fb]
                if (fallback) return { ...fallback, role }
            }
        }
        return null
    }

    // Stale-while-revalidate: a previously verified route is safer and much
    // faster than blocking a user request behind a full mesh/SSH scan. The
    // refresh updates the cache in the background; explicit refreshModels()
    // remains the hard, blocking rescan path.
    const cached = resolveFromCache()
    if (cached) {
        if (cache && Date.now() - cache.timestamp >= CACHE_TTL && !detectPromise) {
            void detectCapabilities().catch(() => undefined)
        }
        return cached
    }

    await detectCapabilities()
    const model = cache?.resolved[role]
    if (model) return model

    const llmRoles: ModelRole[] = ['chat', 'small', 'vision', 'code', 'reasoning']
    if (llmRoles.includes(role)) {
        for (const fb of llmRoles) {
            const m = cache?.resolved[fb]
            if (m) return { ...m, role }
        }
    }
    return null
}

export async function resolveModelId(role: ModelRole): Promise<string> {
    return (await resolveModel(role))?.id || 'unavailable'
}

export async function hasCapability(role: ModelRole): Promise<boolean> {
    return (await resolveModel(role)) !== null
}

export function getCapabilityStatus(): string {
    if (!cache) return 'Capabilities: noch nicht gescannt'
    const lines: string[] = [`**Capabilities** (${cache.scanSummary}):`]

    const groups: [string, ModelRole[]][] = [
        ['🧠 LLM', ['chat', 'vision', 'code', 'reasoning', 'small']],
        ['📐 Embedding', ['embedding']],
        ['🔊 Audio', ['tts', 'stt']],
        ['🎨 Bild', ['image_gen']],
    ]

    for (const [label, roles] of groups) {
        const available = roles.filter(r => cache?.resolved[r])
        if (available.length > 0) {
            const details = available.map(r => {
                const m = cache?.resolved[r]
                if (!m) return ''
                const loc = m.host && m.host !== 'localhost' && m.host !== '127.0.0.1' ? ` @ ${m.host}` : ''
                return `${r}=\`${m.id}\` (${m.provider}${loc})`
            }).filter(Boolean)
            lines.push(`- ${label}: ${details.join(', ')}`)
        } else {
            lines.push(`- ${label}: ❌ nicht verfügbar`)
        }
    }
    return lines.join('\n')
}

export const getModelStatus = getCapabilityStatus

export async function refreshModels(): Promise<void> {
    cache = null
    await detectCapabilities()
}

// ============================================
// Self-Registration: Nova adds new LLM providers at runtime
// ============================================

export interface ExternalProvider {
    name: string           // "minimax", "kimi", "deepseek", "mistral", etc.
    apiKey: string
    baseUrl: string        // OpenAI-compatible endpoint
    models?: string[]      // known model IDs (optional — will be auto-discovered)
    roles?: ModelRole[]    // which roles this provider covers (default: ['chat', 'code'])
    enabled: boolean
    addedAt: number
}

const PROVIDERS_FILE = join(process.cwd(), '.nova-data', 'external-providers.json')

function loadExternalProviders(): ExternalProvider[] {
    try {
        if (existsSync(PROVIDERS_FILE)) {
            return JSON.parse(readFileSync(PROVIDERS_FILE, 'utf-8'))
        }
    } catch { /* start fresh */ }
    return []
}

function saveExternalProviders(providers: ExternalProvider[]): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2))
    } catch { /* non-critical */ }
}

/**
 * Register a new external LLM provider (OpenAI-compatible API).
 * Nova calls this herself when she discovers or is told about a new API.
 * Forces a model cache refresh so the new provider is immediately usable.
 */
export async function registerExternalProvider(provider: Omit<ExternalProvider, 'addedAt'>): Promise<{
    success: boolean
    modelsFound: string[]
    message: string
}> {
    const providers = loadExternalProviders()

    // Test the provider first — quick model list fetch
    let modelsFound: string[] = provider.models || []
    try {
        const res = await fetch(`${provider.baseUrl}/models`, {
            headers: { 'Authorization': `Bearer ${provider.apiKey}` },
            signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
            const data = await res.json() as { data?: Array<{ id: string }> }
            if (data.data?.length) {
                modelsFound = data.data.map(m => m.id)
            }
        }
    } catch { /* provider doesn't expose /models — use provided list */ }

    if (modelsFound.length === 0 && !provider.models?.length) {
        return { success: false, modelsFound: [], message: `Provider "${provider.name}" nicht erreichbar oder keine Modelle gefunden.` }
    }

    // Upsert
    const idx = providers.findIndex(p => p.name === provider.name)
    const entry: ExternalProvider = { ...provider, models: modelsFound, addedAt: Date.now() }
    if (idx >= 0) {
        providers[idx] = entry
    } else {
        providers.push(entry)
    }
    saveExternalProviders(providers)

    // Also update xaventra.config.json providers section
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
            cfg.providers = cfg.providers || {}
            cfg.providers[provider.name] = {
                apiKey: provider.apiKey,
                baseUrl: provider.baseUrl,
                enabled: provider.enabled,
            }
            writeFileSync(configPath, JSON.stringify(cfg, null, 2))
        }
    } catch { /* non-critical */ }

    // Force re-scan so new provider is picked up
    cache = null
    console.log(`[ModelResolver] ➕ Registered provider "${provider.name}" with ${modelsFound.length} models`)

    return {
        success: true,
        modelsFound,
        message: `✅ Provider "${provider.name}" registriert mit ${modelsFound.length} Modellen: ${modelsFound.slice(0, 5).join(', ')}${modelsFound.length > 5 ? '...' : ''}`,
    }
}

/**
 * List all registered external providers.
 */
export function listExternalProviders(): ExternalProvider[] {
    return loadExternalProviders()
}

/**
 * Remove an external provider.
 */
export function removeExternalProvider(name: string): boolean {
    const providers = loadExternalProviders()
    const idx = providers.findIndex(p => p.name === name)
    if (idx < 0) return false
    providers.splice(idx, 1)
    saveExternalProviders(providers)
    cache = null
    return true
}

// Legacy helpers — now delegate to ai-scanner
export function getOllamaModels(): string[] {
    try {
        const { getLastScanResult } = require('../mesh/ai-scanner.js')
        const scan = getLastScanResult()
        return scan?.services.filter((s: any) => s.name === 'ollama' && s.status === 'running').flatMap((s: any) => s.models) || []
    } catch { return [] }
}

export function getLMStudioModels(): string[] {
    try {
        const { getLastScanResult } = require('../mesh/ai-scanner.js')
        const scan = getLastScanResult()
        return scan?.services.filter((s: any) => s.name === 'lm-studio' && s.status === 'running').flatMap((s: any) => s.models) || []
    } catch { return [] }
}

export function getOpenAIModels(): string[] { return [] } // Only available via resolveModel
export function getLocalTools(): Record<string, boolean> { return {} }
export function getCapabilityCache(): ResolverCache | null { return cache }

// Init (non-blocking)
function init(): void {
    if (process.env.NOVA_SKIP_MODEL_RESOLVER_INIT === '1' || sideEffectsDisabled()) {
        console.log('[ModelResolver] Auto-init skipped (side-effect guard active)')
        return
    }
    try {
        if (existsSync(CACHE_FILE)) {
            const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
            if (data.version === CACHE_VERSION && data.timestamp) {
                cache = data
                const ageMs = Date.now() - data.timestamp
                console.log(`[ModelResolver] Loaded ${ageMs < CACHE_TTL ? 'fresh' : 'stale'} cache (${Object.keys(cache?.resolved || {}).length} capabilities)`)
                if (ageMs < CACHE_TTL) return
                void detectCapabilities().catch(() => undefined)
                return
            } else if (data.version !== CACHE_VERSION) {
                console.log(`[ModelResolver] Ignoring legacy resolver cache (${data.version ?? 'no version'} -> ${CACHE_VERSION})`)
            }
        }
    } catch { /* start fresh */ }
    detectCapabilities().catch(() => { })
}

init()

export default {
    resolveModel, resolveModelId, hasCapability,
    getCapabilityStatus, getModelStatus, refreshModels,
    getOllamaModels, getLMStudioModels, getOpenAIModels,
    getLocalTools, getCapabilityCache,
}
