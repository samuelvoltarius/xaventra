/**
 * Nova - Model Catalog
 * 
 * Discovers and manages available LLM models per provider.
 * Uses static model definitions (no external dependencies).
 * 
 * IMPORTANT: Model IDs come from model-defaults.ts — do NOT hardcode here.
 */

import { KNOWN_MODELS, MODEL_CONTEXT_WINDOWS, getContextWindow } from '../core/model-defaults.js'

// ============================================
// Types
// ============================================

export interface NovaModel {
    id: string
    name: string
    provider: string
    contextWindow?: number
    reasoning?: boolean
    capabilities: ModelCapability[]
}

export type ModelCapability = 'chat' | 'vision' | 'tools' | 'reasoning' | 'code'

export interface ModelCatalogConfig {
    cacheEnabled?: boolean
    cacheTtlMs?: number
}

// ============================================
// Static Model Registry
// ============================================

// Seed models — used as initial catalog before runtime discovery.
// Dynamic discovery (model-discovery.ts) takes priority when available.
const SEED_MODELS: Record<string, NovaModel[]> = {
    openai: [
        { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', contextWindow: 128000, capabilities: ['chat', 'vision', 'tools'] },
        { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai', contextWindow: 128000, capabilities: ['chat', 'vision', 'tools'] },
        { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', contextWindow: 1048576, reasoning: true, capabilities: ['chat', 'vision', 'tools', 'reasoning', 'code'] },
        { id: 'gpt-5-mini', name: 'GPT-5.4 Mini', provider: 'openai', contextWindow: 1048576, capabilities: ['chat', 'vision', 'tools', 'code'] },
        { id: 'o1', name: 'O1', provider: 'openai', contextWindow: 200000, reasoning: true, capabilities: ['chat', 'reasoning'] },
        { id: 'o3-mini', name: 'O3 Mini', provider: 'openai', contextWindow: 200000, reasoning: true, capabilities: ['chat', 'reasoning'] },
        { id: 'o3', name: 'O4 Mini', provider: 'openai', contextWindow: 200000, reasoning: true, capabilities: ['chat', 'reasoning'] },
    ],
    anthropic: [
        // Claude 4.6 (Feb 2026) — 1M context in beta
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 1000000, capabilities: ['chat', 'vision', 'tools', 'code'] },
        { id: 'claude-sonnet-4-6-thinking', name: 'Claude Sonnet 4.6 (thinking)', provider: 'anthropic', contextWindow: 1000000, reasoning: true, capabilities: ['chat', 'vision', 'tools', 'reasoning'] },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 1000000, capabilities: ['chat', 'vision', 'tools', 'code'] },
        { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (thinking)', provider: 'anthropic', contextWindow: 1000000, reasoning: true, capabilities: ['chat', 'vision', 'tools', 'reasoning'] },
        // Claude 4.5 (legacy)
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', contextWindow: 200000, capabilities: ['chat', 'vision', 'tools', 'code'] },
        { id: 'claude-sonnet-4-5-thinking', name: 'Claude Sonnet 4.5 (thinking)', provider: 'anthropic', contextWindow: 200000, reasoning: true, capabilities: ['chat', 'vision', 'tools', 'reasoning'] },
    ],
    minimax: [
        // MiniMax M3 — 1M context, frontier coding, MSA sparse attention
        { id: 'MiniMax-M3', name: 'MiniMax M3', provider: 'minimax', contextWindow: 1000000, reasoning: true, capabilities: ['chat', 'vision', 'tools', 'reasoning', 'code'] },
        // MiniMax M2.7 series — 204800 context
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
        { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 (Fast)', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
        // MiniMax M2.5 series — 204800 context
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
        { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 (Fast)', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
        // MiniMax M2.1 series — 204800 context
        { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
        { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 (Fast)', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
        // MiniMax M2 — 204800 context
        { id: 'MiniMax-M2', name: 'MiniMax M2', provider: 'minimax', contextWindow: 204800, capabilities: ['chat', 'tools', 'code'] },
    ],
    ollama: [
        { id: 'llama3.2', name: 'Llama 3.2', provider: 'ollama', contextWindow: 128000, capabilities: ['chat', 'tools'] },
        { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', provider: 'ollama', contextWindow: 128000, capabilities: ['chat', 'code'] },
        { id: 'deepseek-coder-v2', name: 'DeepSeek Coder V2', provider: 'ollama', contextWindow: 128000, capabilities: ['chat', 'code'] },
    ],
    groq: [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', provider: 'groq', contextWindow: 128000, capabilities: ['chat', 'tools'] },
        { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', provider: 'groq', contextWindow: 32768, capabilities: ['chat'] },
    ],
    openrouter: [
        { id: 'auto', name: 'Auto (Best)', provider: 'openrouter', contextWindow: 200000, capabilities: ['chat', 'vision', 'tools'] },
        { id: 'anthropic/claude-4-sonnet', name: 'Claude 4 Sonnet', provider: 'openrouter', contextWindow: 200000, capabilities: ['chat', 'vision', 'tools', 'code'] },
        { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', provider: 'openrouter', contextWindow: 128000, capabilities: ['chat', 'vision', 'tools'] },
        { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', provider: 'openrouter', contextWindow: 128000, capabilities: ['chat', 'tools'] },
        { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'openrouter', contextWindow: 128000, reasoning: true, capabilities: ['chat', 'reasoning'] },
    ],
}

// ============================================
// Model Catalog Class
// ============================================

let catalogCache: NovaModel[] | null = null
let cacheTimestamp = 0

export class ModelCatalog {
    private config: ModelCatalogConfig

    constructor(config: ModelCatalogConfig = {}) {
        this.config = {
            cacheEnabled: config.cacheEnabled ?? true,
            cacheTtlMs: config.cacheTtlMs ?? 5 * 60 * 1000, // 5 minutes
        }
    }

    /**
     * Get all available models (static + discovered)
     */
    async getAllModels(): Promise<NovaModel[]> {
        // Check cache
        if (this.config.cacheEnabled && catalogCache && Date.now() - cacheTimestamp < this.config.cacheTtlMs!) {
            return catalogCache
        }

        const models: NovaModel[] = []

        // Add static models
        for (const provider of Object.keys(SEED_MODELS)) {
            models.push(...SEED_MODELS[provider])
        }

        // Try dynamic discovery with pi-coding-agent
        try {
            const discovered = await this.discoverModels()
            // Merge discovered models (avoid duplicates)
            for (const model of discovered) {
                if (!models.find(m => m.id === model.id && m.provider === model.provider)) {
                    models.push(model)
                }
            }
        } catch {
            // Dynamic discovery failed, use static models only
        }

        // Update cache
        catalogCache = models
        cacheTimestamp = Date.now()

        return models
    }

    /**
     * Get models for a specific provider
     */
    async getModelsForProvider(provider: string): Promise<NovaModel[]> {
        const all = await this.getAllModels()
        return all.filter(m => m.provider === provider)
    }

    /**
     * Get a specific model by ID
     */
    async getModel(id: string, provider?: string): Promise<NovaModel | undefined> {
        const all = await this.getAllModels()
        return all.find(m => m.id === id && (!provider || m.provider === provider))
    }

    /**
     * Get models with a specific capability
     */
    async getModelsByCapability(capability: ModelCapability): Promise<NovaModel[]> {
        const all = await this.getAllModels()
        return all.filter(m => m.capabilities.includes(capability))
    }

    /**
     * Dynamic model discovery - now uses static models only (no pi-ai dependency)
     */
    private async discoverModels(): Promise<NovaModel[]> {
        // NOTE: We used to use @mariozechner/pi-ai for dynamic discovery
        // but that's a private package. Now using static models only.
        // For openai, models are updated in SEED_MODELS.
        return []
    }

    /**
     * Infer capabilities from model properties
     */
    private inferCapabilities(m: { input?: string[]; reasoning?: boolean }): ModelCapability[] {
        const caps: ModelCapability[] = ['chat']
        if (m.input?.includes('image')) caps.push('vision')
        if (m.reasoning) caps.push('reasoning')
        return caps
    }

    /**
     * List all providers
     */
    getProviders(): string[] {
        return Object.keys(SEED_MODELS)
    }

    /**
     * Clear the cache
     */
    clearCache(): void {
        catalogCache = null
        cacheTimestamp = 0
    }
}

// ============================================
// Singleton
// ============================================

let catalogInstance: ModelCatalog | null = null

export function getModelCatalog(): ModelCatalog {
    if (!catalogInstance) {
        catalogInstance = new ModelCatalog()
    }
    return catalogInstance
}
/**
 * Synchronous helper: get models for a provider from the static catalog
 */
export function getModelsForProvider(provider: string): NovaModel[] {
    return SEED_MODELS[provider] || []
}

export default { ModelCatalog, getModelCatalog, getModelsForProvider, SEED_MODELS }
