/**
 * Nova Provider Registry — Dynamic, Self-Registering
 *
 * Inspired by Hermes-Agent's ProviderProfile pattern.
 * Instead of a hardcoded MODEL_REGISTRY, providers register themselves
 * and are discovered from:
 *   1. Built-in provider definitions (this file)
 *   2. nova.config.json providers{} section (enabled + apiKey)
 *   3. Live /v1/models API query (actual available models)
 *
 * Usage:
 *   const registry = getProviderRegistry()
 *   const models = await registry.discoverModels()
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface ProviderCapabilities {
    chat: boolean
    vision: boolean
    tools: boolean        // Native function calling
    tts: boolean
    imageGen: boolean
    videoGen: boolean
    embedding: boolean
    reasoning: boolean    // Extended thinking / chain-of-thought
}

export interface ProviderProfile {
    id: string                          // e.g. 'minimax', 'openai', 'anthropic'
    name: string
    baseUrl: string
    modelsEndpoint?: string             // /v1/models endpoint (if available)
    authHeader: (key: string) => string // How to pass the API key
    capabilities: ProviderCapabilities
    modelPrefix?: string                // Filter models by prefix (e.g. 'MiniMax')
    defaultModel?: string
    ttsEndpoint?: string                // If provider has TTS
    imageEndpoint?: string              // If provider has image generation
    costTier: 'free' | 'low' | 'medium' | 'high'
}

export interface DiscoveredModel {
    id: string
    provider: string
    providerName: string
    capabilities: ProviderCapabilities
    costTier: 'free' | 'low' | 'medium' | 'high'
    contextWindow?: number
    source: 'live' | 'config' | 'builtin'
}

// ============================================
// Built-in Provider Definitions
// (Self-registering — no hardcoded MODEL_REGISTRY needed)
// ============================================

const BUILTIN_PROVIDERS: ProviderProfile[] = [
    {
        id: 'minimax',
        name: 'MiniMax',
        baseUrl: 'https://api.minimax.io/v1',
        modelsEndpoint: '/models',
        authHeader: (key) => `Bearer ${key}`,
        capabilities: { chat: true, vision: true, tools: true, tts: true, imageGen: true, videoGen: true, embedding: false, reasoning: true },
        modelPrefix: 'MiniMax',
        defaultModel: 'MiniMax-M3',
        ttsEndpoint: 'https://api.minimax.io/v1/t2a_v2',
        imageEndpoint: 'https://api.minimax.io/v1/image_generation',
        costTier: 'medium',
    },
    {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        modelsEndpoint: '/models',
        authHeader: (key) => `Bearer ${key}`,
        capabilities: { chat: true, vision: true, tools: true, tts: true, imageGen: true, videoGen: false, embedding: true, reasoning: true },
        defaultModel: 'gpt-4o',
        costTier: 'medium',
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        modelsEndpoint: '/models',
        authHeader: (key) => `x-api-key: ${key}`,
        capabilities: { chat: true, vision: true, tools: true, tts: false, imageGen: false, videoGen: false, embedding: false, reasoning: true },
        defaultModel: 'claude-opus-4-6',
        costTier: 'high',
    },
    {
        id: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        modelsEndpoint: '/models',
        authHeader: (key) => `Bearer ${key}`,
        capabilities: { chat: true, vision: false, tools: true, tts: false, imageGen: false, videoGen: false, embedding: false, reasoning: false },
        defaultModel: 'llama-3.3-70b-versatile',
        costTier: 'free',
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelsEndpoint: '/models',
        authHeader: (key) => `Bearer ${key}`,
        capabilities: { chat: true, vision: true, tools: true, tts: false, imageGen: false, videoGen: false, embedding: false, reasoning: true },
        costTier: 'low',
    },
]

// ============================================
// Provider Registry
// ============================================

interface CachedModels {
    models: DiscoveredModel[]
    timestamp: number
}

export class ProviderRegistry {
    private cache: Map<string, CachedModels> = new Map()
    private readonly cacheTtlMs = 5 * 60 * 1000  // 5 minutes

    // ---- Config ----

    private loadConfig(): Record<string, any> {
        try {
            const path = join(process.cwd(), 'nova.config.json')
            if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'))
        } catch { /* ok */ }
        return {}
    }

    /** Returns provider profiles that have an API key in nova.config.json */
    getEnabledProviders(): Array<{ provider: ProviderProfile; apiKey: string }> {
        const cfg = this.loadConfig()
        const providers = cfg.providers || {}
        const result: Array<{ provider: ProviderProfile; apiKey: string }> = []

        for (const pf of BUILTIN_PROVIDERS) {
            const provCfg = providers[pf.id]
            const apiKey = provCfg?.apiKey || process.env[`${pf.id.toUpperCase()}_API_KEY`]
            if (apiKey && provCfg?.enabled !== false) {
                result.push({ provider: pf, apiKey })
            }
        }

        return result
    }

    /** Detect which providers support TTS */
    getBestTTSProvider(): { provider: ProviderProfile; apiKey: string } | null {
        const enabled = this.getEnabledProviders()
        const ttsProviders = enabled.filter(p => p.provider.capabilities.tts)
        // Prefer MiniMax TTS (best quality)
        return ttsProviders.find(p => p.provider.id === 'minimax') || ttsProviders[0] || null
    }

    /** Detect which providers support image generation */
    getBestImageProvider(): { provider: ProviderProfile; apiKey: string } | null {
        const enabled = this.getEnabledProviders()
        return enabled.find(p => p.provider.capabilities.imageGen) || null
    }

    /** Auto-detect preferLocal based on cloud API availability */
    async shouldPreferCloud(): Promise<boolean> {
        const enabled = this.getEnabledProviders()
        if (enabled.length === 0) return false

        // Quick connectivity check for first enabled provider
        try {
            const { provider: profile, apiKey } = enabled[0]
            const headers: Record<string, string> = { 'Authorization': profile.authHeader(apiKey) }
            const res = await fetch(`${profile.baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(3000),
            })
            return res.ok
        } catch {
            return false
        }
    }

    // ---- Model Discovery ----

    async discoverModelsForProvider(profile: ProviderProfile, apiKey: string): Promise<DiscoveredModel[]> {
        const cacheKey = `${profile.id}:${apiKey.slice(-8)}`
        const cached = this.cache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
            return cached.models
        }

        const models: DiscoveredModel[] = []

        try {
            if (profile.modelsEndpoint) {
                const url = `${profile.baseUrl}${profile.modelsEndpoint}`
                const headers: Record<string, string> = { 'Content-Type': 'application/json' }
                // Parse auth header (could be "Bearer KEY" or "x-api-key: KEY")
                const authStr = profile.authHeader(apiKey)
                if (authStr.startsWith('Bearer ')) {
                    headers['Authorization'] = authStr
                } else if (authStr.includes(':')) {
                    const [k, v] = authStr.split(':').map(s => s.trim())
                    headers[k] = v
                }

                const res = await fetch(url, {
                    headers,
                    signal: AbortSignal.timeout(5000),
                })

                if (res.ok) {
                    const data = await res.json() as any
                    const rawModels: string[] = (data.data || data.models || []).map((m: any) =>
                        typeof m === 'string' ? m : m.id || m.model || ''
                    ).filter(Boolean)

                    for (const id of rawModels) {
                        if (profile.modelPrefix && !id.startsWith(profile.modelPrefix)) continue
                        if (/embed|tts|whisper|dall-e|davinci-002/i.test(id)) continue  // Skip non-chat models
                        models.push({
                            id,
                            provider: profile.id,
                            providerName: profile.name,
                            capabilities: profile.capabilities,
                            costTier: profile.costTier,
                            source: 'live',
                        })
                    }
                    console.log(`[ProviderRegistry] ${profile.name}: ${models.length} models (live)`)
                }
            }
        } catch (err) {
            console.log(`[ProviderRegistry] ${profile.name}: model fetch failed (${err}), using defaults`)
        }

        // Fallback: at least add the default model
        if (models.length === 0 && profile.defaultModel) {
            models.push({
                id: profile.defaultModel,
                provider: profile.id,
                providerName: profile.name,
                capabilities: profile.capabilities,
                costTier: profile.costTier,
                source: 'config',
            })
        }

        this.cache.set(cacheKey, { models, timestamp: Date.now() })
        return models
    }

    async discoverAllModels(): Promise<DiscoveredModel[]> {
        const enabled = this.getEnabledProviders()
        const allModels: DiscoveredModel[] = []

        await Promise.allSettled(
            enabled.map(async ({ provider, apiKey }) => {
                const models = await this.discoverModelsForProvider(provider, apiKey)
                allModels.push(...models)
            })
        )

        return allModels
    }

    clearCache(): void {
        this.cache.clear()
    }

    getProviderProfile(providerId: string): ProviderProfile | undefined {
        return BUILTIN_PROVIDERS.find(p => p.id === providerId)
    }

    getAllProfiles(): ProviderProfile[] {
        return [...BUILTIN_PROVIDERS]
    }
}

// ============================================
// Singleton
// ============================================

let _registry: ProviderRegistry | null = null

export function getProviderRegistry(): ProviderRegistry {
    if (!_registry) _registry = new ProviderRegistry()
    return _registry
}

export default { ProviderRegistry, getProviderRegistry, BUILTIN_PROVIDERS }
