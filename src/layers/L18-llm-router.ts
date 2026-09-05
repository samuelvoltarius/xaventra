/**
 * L18 - Intelligent LLM Router
 * 
 * Nova wählt SELBST welches LLM sie nutzt basierend auf:
 * - Task-Komplexität (einfach → Flash, komplex → Pro/Claude)
 * - Task-Typ (Coding → Claude, Vision → GPT-5.4, Speed → GPT-5.4-mini)
 * - Verfügbarkeit (lokale LLMs bevorzugt wenn verfügbar)
 * - Kosten (günstig zuerst, teuer nur wenn nötig)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getModelScoreAdjustment, getAvgLatency } from '../llm/model-perf-db.js'

// ============================================
// Model Capabilities Registry
// ============================================

export interface ModelCapability {
    id: string
    provider: 'claude' | 'openai' | 'local'
    name: string
    strengths: string[]
    weaknesses: string[]
    costTier: 'free' | 'low' | 'medium' | 'high'
    contextWindow: number
    supportsVision: boolean
    supportsTools: boolean
    speedTier: 'fast' | 'medium' | 'slow'
    bestFor: string[]
}

export const MODEL_REGISTRY: Record<string, ModelCapability> = {
    // === OPENAI ===
    'auto': {
        id: 'auto',
        provider: 'openai',
        name: 'GPT-5 Mini',
        strengths: ['speed', 'cost', 'vision', 'reasoning'],
        weaknesses: [],
        costTier: 'low',
        contextWindow: 128000,
        supportsVision: true,
        supportsTools: true,
        speedTier: 'fast',
        bestFor: ['simple-qa', 'chat', 'image-analysis', 'summarization', 'general']
    },
    'gpt-4o': {
        id: 'gpt-4o',
        provider: 'openai',
        name: 'GPT-4o',
        strengths: ['complex-reasoning', 'analysis', 'multimodal', 'coding', 'vision'],
        weaknesses: ['cost'],
        costTier: 'medium',
        contextWindow: 128000,
        supportsVision: true,
        supportsTools: true,
        speedTier: 'medium',
        bestFor: ['complex-analysis', 'code-review', 'research', 'complex-coding']
    },
    'gpt-4-turbo': {
        id: 'gpt-4-turbo',
        provider: 'openai',
        name: 'GPT-4 Turbo',
        strengths: ['complex-reasoning', 'analysis', 'huge-context', 'multimodal', 'coding'],
        weaknesses: ['speed', 'cost'],
        costTier: 'high',
        contextWindow: 128000,
        supportsVision: true,
        supportsTools: true,
        speedTier: 'slow',
        bestFor: ['complex-analysis', 'code-review', 'research', 'complex-coding', 'difficult-tasks']
    },

    // === CLAUDE ===
    'claude-sonnet-4-6-thinking': {
        id: 'claude-sonnet-4-6-thinking',
        provider: 'claude',
        name: 'Claude Sonnet 4.6 (thinking)',
        strengths: ['coding', 'nuance', 'creative', 'instruction-following', 'reasoning'],
        weaknesses: ['speed'],
        costTier: 'high',
        contextWindow: 200000,
        supportsVision: true,
        supportsTools: true,
        speedTier: 'medium',
        bestFor: ['complex-coding', 'creative-writing', 'nuanced-analysis', 'difficult-tasks']
    },



    // === CLOUD APIs (non-OpenAI, non-Anthropic) ===
    'MiniMax-M3': {
        id: 'MiniMax-M3',
        provider: 'openai',
        name: 'MiniMax M3 (Cloud)',
        strengths: ['general', 'chat', 'coding', 'multilingual', 'vision', 'long-context', 'reasoning'],
        weaknesses: [],
        costTier: 'medium',
        contextWindow: 1000000,
        supportsVision: true,
        supportsTools: true,
        speedTier: 'fast',
        bestFor: ['chat', 'general', 'coding', 'research', 'analysis', 'simple-qa', 'complex-reasoning']
    },
    'MiniMax-M2.7': {
        id: 'MiniMax-M2.7',
        provider: 'openai',
        name: 'MiniMax M2.7 (Cloud)',
        strengths: ['general', 'chat', 'multilingual'],
        weaknesses: [],
        costTier: 'medium',
        contextWindow: 1000000,
        supportsVision: false,
        supportsTools: true,
        speedTier: 'medium',
        bestFor: ['chat', 'general', 'research']
    },
    'kimi-k2.5': {
        id: 'kimi-k2.5',
        provider: 'openai',
        name: 'Kimi K2.5 (Cloud)',
        strengths: ['general', 'chat', 'reasoning'],
        weaknesses: ['latency', 'cost'],
        costTier: 'medium',
        contextWindow: 128000,
        supportsVision: false,
        supportsTools: true,
        speedTier: 'fast',
        bestFor: ['chat', 'general']
    },

    // === LOCAL ===
    // === vLLM LOCAL (primary model) ===
    'Intel/Qwen3.5-122B-A10B-int4-AutoRound': {
        id: 'Intel/Qwen3.5-122B-A10B-int4-AutoRound',
        provider: 'local',
        name: 'Qwen3.5 122B (vLLM)',
        strengths: ['complex-reasoning', 'coding', 'analysis', 'huge-context', 'privacy', 'cost'],
        weaknesses: ['speed'],
        costTier: 'free',
        contextWindow: 262144,
        supportsVision: false,
        supportsTools: true,
        speedTier: 'medium',
        bestFor: ['chat', 'complex-reasoning', 'coding', 'research', 'complex-analysis', 'long-document', 'difficult-tasks', 'general']
    },

    'ollama:llama3': {
        id: 'ollama:llama3',
        provider: 'local',
        name: 'Llama 3 (Ollama)',
        strengths: ['privacy', 'cost', 'offline'],
        weaknesses: ['context-size', 'speed-on-weak-hardware'],
        costTier: 'free',
        contextWindow: 8192,
        supportsVision: false,
        supportsTools: false,
        speedTier: 'medium',
        bestFor: ['privacy-sensitive', 'offline', 'simple-tasks']
    },
    'ollama:codellama': {
        id: 'ollama:codellama',
        provider: 'local',
        name: 'Code Llama (Ollama)',
        strengths: ['coding', 'privacy', 'cost', 'offline'],
        weaknesses: ['general-knowledge', 'context-size'],
        costTier: 'free',
        contextWindow: 16384,
        supportsVision: false,
        supportsTools: false,
        speedTier: 'medium',
        bestFor: ['coding', 'code-completion', 'debugging']
    },
    'ollama:mistral': {
        id: 'ollama:mistral',
        provider: 'local',
        name: 'Mistral (Ollama)',
        strengths: ['speed', 'efficiency', 'privacy', 'cost'],
        weaknesses: ['complex-reasoning', 'context-size'],
        costTier: 'free',
        contextWindow: 32768,
        supportsVision: false,
        supportsTools: false,
        speedTier: 'fast',
        bestFor: ['quick-tasks', 'chat', 'privacy-sensitive']
    },
}

// ============================================
// Task Type Detection
// ============================================

export type TaskType =
    | 'simple-qa'
    | 'complex-reasoning'
    | 'coding'
    | 'creative'
    | 'vision'
    | 'long-document'
    | 'chat'
    | 'system-command'
    | 'research'
    | 'unknown'

export function detectTaskType(content: string, hasImage: boolean): TaskType {
    const lower = content.toLowerCase()

    // Vision tasks
    if (hasImage) return 'vision'

    // Coding patterns
    const codingPatterns = [
        /code|programm|script|function|class|bug|debug|compile|syntax|refactor/i,
        /python|javascript|typescript|java|c\+\+|rust|go|php|ruby/i,
        /erstell.*datei|schreib.*code|fix.*fehler|implementier/i,
    ]
    if (codingPatterns.some(p => p.test(content))) return 'coding'

    // System commands
    const systemPatterns = [
        /scan|netzwerk|process|datei|ordner|install|download|kopier|lösch/i,
        /führe aus|starte|stoppe|restart|power|system|command/i,
    ]
    if (systemPatterns.some(p => p.test(content))) return 'system-command'

    // Complex reasoning
    const complexPatterns = [
        /analysier|vergleich|erkläre.*genau|warum.*funktioniert/i,
        /strategie|plan|design|architekt|trade.?off/i,
        /was denkst du|wie würdest du|bewerte|evaluier/i,
    ]
    if (complexPatterns.some(p => p.test(content))) return 'complex-reasoning'

    // Research
    const researchPatterns = [
        /recherchier|such.*nach|find.*heraus|was ist|wer ist|wo ist/i,
        /information|daten|statistik|studie|quelle/i,
    ]
    if (researchPatterns.some(p => p.test(content))) return 'research'

    // Creative
    const creativePatterns = [
        /schreib.*geschichte|gedicht|slogan|text|kreativ/i,
        /erfinde|imagine|story|brainstorm/i,
    ]
    if (creativePatterns.some(p => p.test(content))) return 'creative'

    // Long document (by length)
    if (content.length > 5000) return 'long-document'

    // Simple Q&A (short, question-like)
    if (content.length < 100 && /\?|was|wie|wer|wo|wann|warum/.test(lower)) {
        return 'simple-qa'
    }

    // Default chat
    return 'chat'
}

// ============================================
// Smart Model Selection
// ============================================

export interface RouterConfig {
    preferLocal: boolean
    maxCostTier: 'free' | 'low' | 'medium' | 'high'
    preferSpeed: boolean
    availableModels: string[]
    preferredModel?: string   // Explicit primary model from nova.config.json (e.g. "MiniMax-M3")
    preferredProvider?: string // Explicit primary provider (e.g. "minimax")
}

// Build initial available models from discovery cache (if any)
function getInitialAvailableModels(): string[] {
    try {
        const { getAvailableModels } = require('../llm/model-discovery.js')
        const discovered = getAvailableModels()
        if (discovered && discovered.length > 0) {
            return discovered.map((m: any) => m.id)
        }
    } catch { /* discovery not loaded yet */ }
    // Fallback to seed list
    return ['auto', 'auto', 'auto', 'claude-sonnet-4-6-thinking', 'claude-opus-4-6-thinking', 'o3']
}

const DEFAULT_CONFIG: RouterConfig = {
    preferLocal: true,
    maxCostTier: 'high',
    preferSpeed: false,
    availableModels: getInitialAvailableModels()
}

let routerConfig: RouterConfig = { ...DEFAULT_CONFIG }

function isRoutableModelId(modelId: string): boolean {
    const lower = modelId.toLowerCase()
    if (/embed|nomic|bge|mxbai|e5-|gte-|instructor|minilm/.test(lower)) return false
    if (/:cloud\b/.test(lower) || /\bcloud\b/.test(lower)) return false
    if (lower.includes('gemini')) return false
    return true
}

/**
 * Infer capabilities from a model ID that was discovered by the probe
 * but doesn't have a manual entry in MODEL_REGISTRY.
 */
function inferModelCapability(modelId: string): ModelCapability {
    const lower = modelId.toLowerCase()

    // Detect embedding models — these are NOT generative LLMs
    const isEmbeddingModel = lower.includes('embed') || lower.includes('minilm') || lower.includes('bge-')

    // Infer provider
    // Cloud APIs: MiniMax (api.minimax.io), Kimi (Moonshot AI), deepseek.com
    const isCloudApi = lower.startsWith('minimax') || lower.includes('minimax-m') ||
                       lower.startsWith('kimi') || lower.startsWith('moonshot') ||
                       (lower.startsWith('deepseek') && !lower.includes('@'))
    let provider: 'claude' | 'openai' | 'local' = 'openai'
    if (lower.startsWith('claude')) provider = 'claude'
    else if (isCloudApi) provider = 'openai' // cloud APIs — treat like openai (no local bonus)
    else if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) provider = 'openai'
    else if (isEmbeddingModel || lower.startsWith('qwen') || lower.startsWith('llama') || lower.startsWith('mistral')
          || lower.startsWith('gemma') || lower.startsWith('phi') || lower.startsWith('intel/')
          || lower.startsWith('minicpm') || lower.startsWith('nomic') || lower.startsWith('mxbai')) provider = 'local'

    // Infer cost tier
    let costTier: 'free' | 'low' | 'medium' | 'high' = 'medium'
    if ((provider === 'local' && !isCloudApi) || isEmbeddingModel) costTier = 'free'
    else if (lower.includes('flash') || lower.includes('lite') || lower.includes('mini')) costTier = 'low'
    if (lower.includes('pro') || lower.includes('opus') || lower.includes('high')) costTier = 'high'

    // Infer speed
    let speedTier: 'fast' | 'medium' | 'slow' = 'medium'
    if (lower.includes('flash') || lower.includes('lite')) speedTier = 'fast'
    if (lower.includes('thinking') || lower.includes('opus') || lower.includes('high')) speedTier = 'slow'

    // Infer strengths
    const strengths: string[] = isEmbeddingModel ? ['embeddings'] : ['general']
    if (!isEmbeddingModel && provider === 'openai') strengths.push('vision', 'large-context')
    if (provider === 'claude') strengths.push('coding', 'nuance', 'instruction-following')
    if (lower.includes('thinking') || lower.includes('pro') || lower.includes('opus')) strengths.push('complex-reasoning')
    if (lower.includes('flash') || lower.includes('lite')) strengths.push('speed', 'cost')
    if (lower.includes('code') || lower.includes('coding')) strengths.push('coding')
    if (!isEmbeddingModel && (lower.includes('image') || lower.includes('vision'))) strengths.push('vision')

    // Infer bestFor
    const bestFor: string[] = isEmbeddingModel ? [] : ['general']
    if (!isEmbeddingModel && provider === 'openai') bestFor.push('chat', 'simple-qa')
    if (!isEmbeddingModel && provider === 'local') bestFor.push('chat', 'simple-qa')
    if (lower.includes('flash') || lower.includes('lite')) bestFor.push('simple-qa', 'chat')
    if (lower.includes('pro') || lower.includes('opus') || lower.includes('high')) bestFor.push('complex-analysis', 'research')
    if (provider === 'claude') bestFor.push('complex-coding')

    return {
        id: modelId,
        provider,
        name: modelId,
        strengths,
        weaknesses: isEmbeddingModel ? ['not-generative'] : [],
        costTier,
        contextWindow: isEmbeddingModel ? 512 : (provider === 'openai' ? 128000 : 200000),
        supportsVision: !isEmbeddingModel && (provider === 'openai' || lower.includes('vision') || lower.includes('image')),
        supportsTools: !isEmbeddingModel,
        speedTier,
        bestFor,
    }
}

export function configureRouter(config: Partial<RouterConfig>): void {
    routerConfig = { ...routerConfig, ...config }
    routerConfig.availableModels = [...new Set(routerConfig.availableModels)].filter(isRoutableModelId)
    console.log(`[L18 Router] Configured:`, JSON.stringify(routerConfig))
}

/**
 * Enrich MODEL_REGISTRY dynamically from ProviderRegistry.
 * Call at startup — adds live-discovered models to the scoring registry.
 */
export async function enrichRegistryFromProviders(): Promise<number> {
    try {
        const { getProviderRegistry } = await import('../llm/provider-registry.js')
        const registry = getProviderRegistry()
        const models = await registry.discoverAllModels()
        let added = 0

        for (const m of models) {
            if (MODEL_REGISTRY[m.id]) continue  // Already in built-in registry
            MODEL_REGISTRY[m.id] = {
                id: m.id,
                provider: m.provider === 'minimax' ? 'openai' : m.provider as any,
                name: `${m.providerName} ${m.id}`,
                strengths: [
                    ...(m.capabilities.reasoning ? ['complex-reasoning'] : []),
                    ...(m.capabilities.vision ? ['vision'] : []),
                    'general', 'chat',
                ],
                weaknesses: [],
                costTier: m.costTier,
                contextWindow: 128000,
                supportsVision: m.capabilities.vision,
                supportsTools: m.capabilities.tools,
                speedTier: 'medium',
                bestFor: ['chat', 'general', 'research'],
            }
            added++
        }

        if (added > 0) {
            console.log(`[L18 Router] ✅ +${added} models from ProviderRegistry (live API)`)
        }
        return added
    } catch (err) {
        console.log(`[L18 Router] ProviderRegistry enrichment skipped: ${err}`)
        return 0
    }
}

export function selectModel(
    content: string,
    hasImage: boolean = false,
    complexity: number = 50
): { model: string; reason: string } {
    const taskType = detectTaskType(content, hasImage)

    // Build candidate list from MODEL_REGISTRY + dynamically probed models
    const registryModels = Object.values(MODEL_REGISTRY).filter(m =>
        routerConfig.availableModels.includes(m.id)
    )

    // Auto-create entries for probe-discovered models NOT in MODEL_REGISTRY
    const knownIds = new Set(registryModels.map(m => m.id))
    const dynamicModels: ModelCapability[] = routerConfig.availableModels
        .filter(id => !knownIds.has(id))
        .filter(isRoutableModelId)
        .map(id => inferModelCapability(id))

    const candidates = [...registryModels, ...dynamicModels]

    if (candidates.length === 0) {
        return {
            model: routerConfig.availableModels[0] || 'auto',
            reason: 'Fallback: Keine konfigurierten Modelle'
        }
    }

    // Score each model
    const scored = candidates.map(model => {
        let score = 50
        const reasons: string[] = []

        // Task type match
        if (model.bestFor.includes(taskType)) {
            score += 30
            reasons.push(`Gut für ${taskType}`)
        }

        // Vision requirement
        if (hasImage) {
            if (model.supportsVision) {
                score += 20
                reasons.push('Vision-fähig')
            } else {
                score -= 100  // Disqualify
                reasons.push('Kein Vision')
            }
        }

        // Tool support requirement — models without native function calling get penalized
        // Small local models (qwen2.5:3b, gemma3:4b, phi, etc.) output text-formatted
        // "function calls" instead of using the OpenAI-compatible function calling API
        if (model.supportsTools === false) {
            score -= 80  // Heavy penalty — only use if NO tool-supporting model available
            reasons.push('Kein natives Function Calling')
        }

        // Complexity matching
        if (complexity > 70 && model.strengths.includes('complex-reasoning')) {
            score += 25
            reasons.push('Komplex-reasoning')
        }
        if (complexity < 30 && model.speedTier === 'fast') {
            score += 20
            reasons.push('Schnell für einfache Tasks')
        }

        // Coding bonus for Claude
        if (taskType === 'coding' && model.strengths.includes('coding')) {
            score += 25
            reasons.push('Coding-Spezialist')
        }

        // Local preference
        if (model.provider === 'local' && routerConfig.preferLocal) {
            score += 15
            reasons.push('Lokal bevorzugt')
        }
        if (model.provider !== 'local' && !routerConfig.preferLocal) {
            score += 15
            reasons.push('Cloud/Subscription bevorzugt')
        }
        // Preferred model bonus — configured via nova.config.json (model + preferredProvider)
        // This ensures the user's chosen primary model wins regardless of other scoring
        const preferred = routerConfig.preferredModel?.toLowerCase()
        const preferredProv = routerConfig.preferredProvider?.toLowerCase()
        if (preferred && model.id.toLowerCase() === preferred) {
            score += 40
            reasons.push('Bevorzugtes Primärmodell')
        } else if (preferredProv && model.id.toLowerCase().startsWith(preferredProv)) {
            score += 20
            reasons.push(`Bevorzugter Provider (${preferredProv})`)
        }

        // gpt-5.5 bonus only when cloud preferred AND no explicit preferredModel configured
        if (!preferred && (model.id.toLowerCase() === 'gpt-5.5' || model.name.toLowerCase().includes('gpt-5.5')) && !routerConfig.preferLocal) {
            score += 25
            reasons.push('OpenAI/Codex bevorzugt')
        }

        // Cost consideration
        const costPenalty = { free: 0, low: 5, medium: 15, high: 25 }
        score -= costPenalty[model.costTier]

        // Speed preference
        if (routerConfig.preferSpeed && model.speedTier === 'fast') {
            score += 15
            reasons.push('Schnell')
        }

        // Real-world performance adjustment (from ModelPerfDB)
        try {
            const perfAdj = getModelScoreAdjustment(model.id, taskType)
            if (perfAdj !== 0) {
                score += perfAdj
                if (perfAdj > 0) reasons.push(`Bewährt für ${taskType} (+${perfAdj})`)
                else reasons.push(`Schlechte History (${perfAdj})`)
            }
            // Measured latency matters for every provider, not only local models.
            const avgMs = getAvgLatency(model.id)
            if (avgMs !== undefined) {
                if (avgMs < 1500) {
                    score += routerConfig.preferSpeed ? 12 : 6
                    reasons.push(`Sehr schnell (${avgMs}ms avg)`)
                } else if (avgMs < 3000) {
                    score += 4
                    reasons.push(`Schnell (${avgMs}ms avg)`)
                } else if (avgMs > 15_000) {
                    score -= routerConfig.preferSpeed ? 20 : 10
                    reasons.push(`Hohe Latenz (${avgMs}ms avg)`)
                } else if (avgMs > 8_000) {
                    score -= routerConfig.preferSpeed ? 10 : 5
                    reasons.push(`Langsam (${avgMs}ms avg)`)
                }
            }
        } catch { /* perf db optional */ }

        return { model, score, reasons }
    })

    // Sort by score and pick best
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]

    console.log(`[L18 Router] Task: ${taskType}, Complexity: ${complexity}`)
    console.log(`[L18 Router] Selected: ${best.model.name} (Score: ${best.score})`)
    console.log(`[L18 Router] Reasons: ${best.reasons.join(', ')}`)

    return {
        model: best.model.id,
        reason: `${best.model.name} - ${best.reasons.slice(0, 2).join(', ')}`
    }
}

// ============================================
// Model Selection History (Learning)
// ============================================

interface ModelUsage {
    modelId: string
    taskType: TaskType
    success: boolean
    duration: number
    timestamp: number
}

const USAGE_FILE = '.nova-learning/model-usage.json'

function loadUsageHistory(): ModelUsage[] {
    const path = join(process.cwd(), USAGE_FILE)
    if (!existsSync(path)) return []
    try {
        return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
        return []
    }
}

function saveUsageHistory(history: ModelUsage[]): void {
    const dir = join(process.cwd(), '.nova-learning')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(process.cwd(), USAGE_FILE), JSON.stringify(history.slice(-500), null, 2))
}

export function recordModelUsage(
    modelId: string,
    taskType: TaskType,
    success: boolean,
    duration: number
): void {
    const history = loadUsageHistory()
    history.push({
        modelId,
        taskType,
        success,
        duration,
        timestamp: Date.now()
    })
    saveUsageHistory(history)
    console.log(`[L18 Router] Recorded: ${modelId} for ${taskType} (${success ? '✅' : '❌'})`)
}

export function getModelStats(): Record<string, { uses: number; successRate: number; avgDuration: number }> {
    const history = loadUsageHistory()
    const stats: Record<string, { uses: number; successes: number; totalDuration: number }> = {}

    for (const entry of history) {
        if (!stats[entry.modelId]) {
            stats[entry.modelId] = { uses: 0, successes: 0, totalDuration: 0 }
        }
        stats[entry.modelId].uses++
        if (entry.success) stats[entry.modelId].successes++
        stats[entry.modelId].totalDuration += entry.duration
    }

    const result: Record<string, { uses: number; successRate: number; avgDuration: number }> = {}
    for (const [id, s] of Object.entries(stats)) {
        result[id] = {
            uses: s.uses,
            successRate: s.uses > 0 ? s.successes / s.uses : 0,
            avgDuration: s.uses > 0 ? s.totalDuration / s.uses : 0
        }
    }

    return result
}

// ============================================
// Prompt for Nova to know about models
// ============================================

export function getModelInfoPrompt(): string {
    const stats = getModelStats()

    // Include both static registry models AND dynamically probed ones
    const registryAvail = Object.values(MODEL_REGISTRY)
        .filter(m => routerConfig.availableModels.includes(m.id) || m.provider === 'local')
    const knownIds = new Set(registryAvail.map(m => m.id))
    const dynamicAvail = routerConfig.availableModels
        .filter(id => !knownIds.has(id))
        .filter(isRoutableModelId)
        .map(id => inferModelCapability(id))
    const available = [...registryAvail, ...dynamicAvail]

    let prompt = `\n## VERFÜGBARE LLMs
Du kannst zwischen folgenden Modellen wählen (automatisch geroutet):

`
    for (const m of available) {
        const s = stats[m.id]
        const usage = s ? ` (${s.uses}x genutzt, ${Math.round(s.successRate * 100)}% Erfolg)` : ''
        prompt += `- **${m.name}** [${m.costTier}]: ${m.strengths.slice(0, 3).join(', ')}${usage}\n`
    }

    prompt += `
Modell-Auswahl ist AUTOMATISCH basierend auf deiner Aufgabe.
`
    return prompt
}

// ============================================
// Export
// ============================================

export default {
    MODEL_REGISTRY,
    detectTaskType,
    selectModel,
    configureRouter,
    recordModelUsage,
    getModelStats,
    getModelInfoPrompt,
}
