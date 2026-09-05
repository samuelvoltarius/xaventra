
import { resolveConfigPath } from '../config/config-path.js'
/**
 * Model Router - DYNAMIC Model Selection
 * 
 * Nova autonomously discovers and selects the best model:
 * - Queries server for available models at startup
 * - Auto-switches when rate limited (429 errors)
 * - Caches model capabilities for fast lookup
 */

// ============================================
// Model Capabilities
// ============================================

export interface ModelCapability {
    id: string
    name: string
    capabilities: ('text' | 'vision' | 'video' | 'code' | 'reasoning')[]
    speed: 'fast' | 'medium' | 'slow'
    cost: 'low' | 'medium' | 'high'
    contextWindow: number
    available: boolean
    rateLimited?: boolean
    rateLimitResetAt?: number
}

// Dynamic model cache (populated at runtime)
let discoveredModels: ModelCapability[] = []
let lastModelFetch = 0
const MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Fallback models when server is unreachable
const FALLBACK_MODELS: ModelCapability[] = [
    {
        id: 'auto',  // resolved by model-resolver
        name: 'GPT-5 Mini',
        capabilities: ['text', 'vision', 'code'],
        speed: 'fast',
        cost: 'low',
        contextWindow: 1000000,
        available: true,
    },
    {
        id: 'auto',  // resolved by model-resolver
        name: 'GPT-5.4',
        capabilities: ['text', 'vision', 'video', 'code', 'reasoning'],
        speed: 'medium',
        cost: 'medium',
        contextWindow: 2000000,
        available: true,
    },
    {
        id: 'claude-opus-4-6-thinking',
        name: 'Claude Opus 4.6 Thinking',
        capabilities: ['text', 'code', 'reasoning'],
        speed: 'slow',
        cost: 'high',
        contextWindow: 200000,
        available: true,
    },
]

// ============================================
// Dynamic Model Discovery
// ============================================

/**
 * Fetch available models from OpenAI API
 * Returns cached models if recently fetched
 */
export async function fetchAvailableModels(forceRefresh = false): Promise<ModelCapability[]> {
    // Return cache if fresh
    if (!forceRefresh && discoveredModels.length > 0 && Date.now() - lastModelFetch < MODEL_CACHE_TTL) {
        return discoveredModels
    }

    try {
        // Try to get token manager
        const { existsSync, readFileSync } = await import('node:fs')
        const { join } = await import('node:path')

        // Check nova-data auth first, then legacy path
        const novaAuthPath = join(process.cwd(), '.nova-data', 'auth.json')
        const legacyAuthPath = join(
            process.env.USERPROFILE || process.env.HOME || '',
            '.pi', 'agent', 'auth.json'
        )
        const authPath = existsSync(novaAuthPath) ? novaAuthPath : legacyAuthPath

        if (!existsSync(authPath)) {
            console.log('[ModelRouter] No auth found, using fallback models')
            return FALLBACK_MODELS
        }

        const authData = JSON.parse(readFileSync(authPath, 'utf-8'))
        const openaiAuth = authData['openai'] || authData['local']

        if (!openaiAuth?.access) {
            console.log('[ModelRouter] No OpenAI token, using fallback models')
            return FALLBACK_MODELS
        }

        // Query the server for available models
        // Query OpenAI for available models
        const response = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${openaiAuth.access}`,
                'Content-Type': 'application/json',
            },
        })

        if (response.ok) {
            const data = await response.json() as { models?: Array<{ name: string; displayName?: string; supportedCapabilities?: string[] }> }

            if (data.models && data.models.length > 0) {
                discoveredModels = data.models.map(m => ({
                    id: m.name.replace('models/', ''),
                    name: m.displayName || m.name,
                    capabilities: inferCapabilities(m.name, m.supportedCapabilities),
                    speed: inferSpeed(m.name),
                    cost: inferCost(m.name),
                    contextWindow: 1000000,
                    available: true,
                }))

                lastModelFetch = Date.now()
                console.log(`[ModelRouter] Discovered ${discoveredModels.length} models from server`)
                return discoveredModels
            }
        } else {
            console.log(`[ModelRouter] Server returned ${response.status}, using fallback models`)
        }
    } catch (err) {
        console.log(`[ModelRouter] Could not fetch models: ${err}`)
    }

    // Fallback
    discoveredModels = FALLBACK_MODELS
    lastModelFetch = Date.now()
    return FALLBACK_MODELS
}

/**
 * Infer model capabilities from name
 */
function inferCapabilities(name: string, serverCaps?: string[]): ModelCapability['capabilities'] {
    const caps: ModelCapability['capabilities'] = ['text']
    const lower = name.toLowerCase()

    // Vision support
    if (lower.includes('flash') || lower.includes('pro') || lower.includes('vision')) {
        caps.push('vision')
    }

    // Video support (only pro models)
    if (lower.includes('pro')) {
        caps.push('video')
    }

    // Code support (all modern models)
    caps.push('code')

    // Reasoning (thinking models and pro)
    if (lower.includes('thinking') || lower.includes('opus') || lower.includes('pro-high')) {
        caps.push('reasoning')
    }

    return caps
}

function inferSpeed(name: string): 'fast' | 'medium' | 'slow' {
    const lower = name.toLowerCase()
    if (lower.includes('flash') || lower.includes('lite')) return 'fast'
    if (lower.includes('thinking') || lower.includes('opus') || lower.includes('high')) return 'slow'
    return 'medium'
}

function inferCost(name: string): 'low' | 'medium' | 'high' {
    const lower = name.toLowerCase()
    if (lower.includes('flash') || lower.includes('lite') || lower.includes('oss')) return 'low'
    if (lower.includes('opus') || lower.includes('high') || lower.includes('thinking')) return 'high'
    return 'medium'
}

// ============================================
// Rate Limit Handling & Auto-Failover
// ============================================

const FAILOVER_CHAIN = [
    'auto',
    'auto',
    'auto',
    'claude-opus-4-6-thinking',
]

/**
 * Mark a model as rate limited
 */
export function markRateLimited(modelId: string, resetInMs = 60000): void {
    const model = discoveredModels.find(m => m.id === modelId)
    if (model) {
        model.rateLimited = true
        model.rateLimitResetAt = Date.now() + resetInMs
        console.log(`[ModelRouter] Model ${modelId} rate limited, reset in ${resetInMs / 1000}s`)
    }
}

/**
 * Get next available model in failover chain
 */
export function getFailoverModel(currentModelId: string): string | null {
    const currentIndex = FAILOVER_CHAIN.indexOf(currentModelId)

    for (let i = currentIndex + 1; i < FAILOVER_CHAIN.length; i++) {
        const candidate = FAILOVER_CHAIN[i]
        const model = discoveredModels.find(m => m.id === candidate)

        // Check if model is available and not rate limited
        if (model && model.available && !isRateLimited(model)) {
            console.log(`[ModelRouter] Failover: ${currentModelId} → ${candidate}`)
            return candidate
        }
    }

    // No failover available
    console.log(`[ModelRouter] No failover models available!`)
    return null
}

function isRateLimited(model: ModelCapability): boolean {
    if (!model.rateLimited) return false
    if (model.rateLimitResetAt && Date.now() > model.rateLimitResetAt) {
        // Reset expired
        model.rateLimited = false
        model.rateLimitResetAt = undefined
        return false
    }
    return true
}

/**
 * Get all available (non-rate-limited) models
 */
export function getAvailableModels(): ModelCapability[] {
    return discoveredModels.filter(m => m.available && !isRateLimited(m))
}

// ============================================
// Task Detection
// ============================================

export type TaskType = 'vision' | 'video' | 'code' | 'reasoning' | 'simple'

export function detectTaskType(content: string, hasImage: boolean): TaskType {
    const lower = content.toLowerCase()

    // Image/Vision tasks
    if (hasImage) {
        return 'vision'
    }
    if (/bild|image|foto|photo|screenshot|sieh.*an|schau.*an|analysier.*bild/i.test(lower)) {
        return 'vision'
    }

    // Video tasks
    if (/video|youtube|vimeo|mp4|mov|schau.*video/i.test(lower)) {
        return 'video'
    }

    // Code tasks
    if (/code|programm|script|funktion|klasse|debug|fehler.*im.*code|typescript|javascript|python/i.test(lower)) {
        return 'code'
    }

    // Complex reasoning
    if (/erklär.*detail|analysier|vergleich|warum|wieso|weshalb|architekt/i.test(lower)) {
        if (lower.length > 200) {
            return 'reasoning'
        }
    }

    return 'simple'
}

// ============================================
// Model Selection
// ============================================

export interface ModelRecommendation {
    modelId: string
    reason: string
    taskType: TaskType
}

export function selectBestModel(
    content: string,
    hasImage: boolean,
    preferredModel?: string
): ModelRecommendation {
    const taskType = detectTaskType(content, hasImage)

    // If user has a preferred model that can handle the task, use it
    if (preferredModel) {
        const preferred = discoveredModels.find((m: ModelCapability) => m.id === preferredModel)
        if (preferred) {
            // Check if preferred model can handle this task type
            const neededCapability = taskType === 'simple' ? 'text' : taskType
            if (preferred.capabilities.includes(neededCapability as any)) {
                return {
                    modelId: preferredModel,
                    reason: 'User preferred model',
                    taskType,
                }
            }
        }
    }

    // Select based on task type
    switch (taskType) {
        case 'vision':
            return {
                modelId: 'auto',  // Fast vision
                reason: 'Bild-Analyse mit schnellem Vision-Modell',
                taskType,
            }

        case 'video':
            return {
                modelId: 'auto',  // Video support
                reason: 'Video-Analyse braucht Pro-Modell',
                taskType,
            }

        case 'reasoning':
            return {
                modelId: 'claude-opus-4-6-thinking',  // Best reasoning
                reason: 'Komplexe Analyse mit Claude Thinking',
                taskType,
            }

        case 'code':
            return {
                modelId: 'auto',  // Fast and good for code
                reason: 'Code-Generierung mit schnellem Modell',
                taskType,
            }

        case 'simple':
        default:
            return {
                modelId: 'auto',  // Fastest
                reason: 'Einfache Aufgabe mit schnellem Modell',
                taskType,
            }
    }
}

// ============================================
// Model Switch Helper
// ============================================

// Read initial model from config (not hardcoded!)
function readConfiguredModel(): string {
    try {
        const { readFileSync } = require('node:fs')
        const { join } = require('node:path')
        const cfg = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))
        return cfg.model || 'auto'
    } catch {
        return 'auto'
    }
}

let currentModel = readConfiguredModel()
let switchCount = 0

export function getCurrentModel(): string {
    return currentModel
}

export function setCurrentModel(modelId: string): void {
    if (modelId !== currentModel) {
        console.log(`[ModelRouter] Model switch: ${currentModel} → ${modelId}`)
        currentModel = modelId
        switchCount++
    }
}

export function getStats(): { currentModel: string; switchCount: number } {
    return { currentModel, switchCount }
}

// ============================================
// Auto-Route (main entry point)
// ============================================

export function autoRoute(
    content: string,
    options: { hasImage?: boolean; preferredModel?: string } = {}
): ModelRecommendation {
    const recommendation = selectBestModel(
        content,
        options.hasImage || false,
        options.preferredModel
    )

    // Only log if switching models
    if (recommendation.modelId !== currentModel) {
        console.log(`[ModelRouter] Task: ${recommendation.taskType} → ${recommendation.modelId} (${recommendation.reason})`)
    }

    return recommendation
}

export default {
    detectTaskType,
    selectBestModel,
    autoRoute,
    getCurrentModel,
    setCurrentModel,
    getStats,
    getAvailableModels,
    fetchAvailableModels,
    markRateLimited,
    getFailoverModel,
}
