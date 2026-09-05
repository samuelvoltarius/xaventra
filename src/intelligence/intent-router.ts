/**
 * Nova — Intent Router
 *
 * Classifies user intent and routes to the optimal model.
 * Uses regex-based classification (no extra API call needed).
 * 
 *
 * Models are resolved dynamically via model-defaults.ts.
 * NO hardcoded model strings — all driven by config/env.
 */

import { getDefaultModel, getComplexModel } from '../core/model-defaults.js'

// ============================================
// Types
// ============================================

export type IntentCategory =
    | 'simple'     // Greetings, yes/no, status checks
    | 'code'       // Code generation, debugging, refactoring
    | 'analysis'   // Complex reasoning, planning, architecture
    | 'creative'   // Writing, brainstorming, storytelling
    | 'search'     // Web search, fact lookup
    | 'tool'       // Tool usage (SSH, file ops, system commands)
    | 'longcontext' // Very long messages or document analysis

export interface IntentResult {
    category: IntentCategory
    confidence: number // 0-1
    suggestedModel: string
    reason: string
}

export interface RouterConfig {
    /** Override model for specific categories */
    modelOverrides: Partial<Record<IntentCategory, string>>
    /** Enable/disable routing (false = always use primary model) */
    enabled: boolean
    /** Minimum confidence to switch models (below = use primary) */
    confidenceThreshold: number
}

// ============================================
// Default Model Mapping
// ============================================

function buildModelMap(): Record<IntentCategory, string> {
    const fast = getDefaultModel()
    const reasoning = getComplexModel()
    return {
        simple: fast,
        code: reasoning,
        analysis: reasoning,
        creative: fast,
        search: fast,
        tool: fast,
        longcontext: fast,  // Model discovery handles context window
    }
}

// ============================================
// Intent Classification Patterns
// ============================================

const SIMPLE_PATTERNS = [
    /^(hi|hallo|hey|moin|servus|grüß|guten\s?(morgen|tag|abend)|ciao|tschüss|danke|thx|ok|ja|nein|genau|passt|alles\s?klar)/i,
    /^(was geht|wie geht|how are you|what's up)/i,
    /^\/\w+/,  // Slash commands
    /^(status|version|uptime|help|hilfe)\??$/i,
    /^.{1,30}$/,  // Very short messages (< 30 chars)
]

const CODE_PATTERNS = [
    /\b(code|function|class|interface|type|import|export|const|let|var|return|async|await)\b/i,
    /\b(bug|fix|debug|error|exception|stack\s?trace|lint|compile|build|refactor)\b/i,
    /\b(typescript|javascript|python|rust|go|java|c\+\+|sql|html|css|react|next\.?js|node)\b/i,
    /```[\s\S]*```/,  // Code blocks
    /\.(ts|js|py|rs|go|java|cpp|sql|json|yaml|md)\b/,  // File extensions
    /\b(npm|pip|cargo|docker|git\s+(commit|push|pull|merge|rebase))\b/i,
]

const ANALYSIS_PATTERNS = [
    /\b(analy[sz]|vergleich|evaluate|bewert|assess|review|audit|plan|architect|design|strateg)/i,
    /\b(warum|why|explain|erklär|how\s+does|wie\s+funktioniert|trade.?off|vor.?und\s+nach)/i,
    /\b(optimier|improv|performance|bottleneck|benchmark|profil)/i,
    /\b(pro\s+and\s+con|pros?\s+cons?|advantages|disadvantages)/i,
]

const CREATIVE_PATTERNS = [
    /\b(schreib|write|text|artikel|article|blog|story|gedicht|poem|brief|letter|mail|email)/i,
    /\b(kreativ|creative|brainstorm|idee|idea|vorschlag|suggest|inspiration|motto|slogan)/i,
    /\b(übersetze?|translat|formul|rephrase|umformul|zusammenfass|summariz)/i,
]

const SEARCH_PATTERNS = [
    /\b(such|search|google|find|lookup|recherch)\b/i,
    /\b(was\s+ist|what\s+is|wer\s+ist|who\s+is|wann\s+war|when\s+was)\b/i,
    /\b(aktuel|current|latest|newest|recent|news)\b/i,
]

const TOOL_PATTERNS = [
    /\b(ssh|server|deploy|restart|install|sudo|chmod|chown|systemctl|docker|container)\b/i,
    /\b(datei|file|folder|directory|download|upload|copy|move|delete|löschen)\b/i,
    /\b(start|stop|kill|process|service|daemon|cron|schedule)\b/i,
]

// ============================================
// Router State
// ============================================

let routerConfig: RouterConfig = {
    modelOverrides: {},
    enabled: true,
    confidenceThreshold: 0.6,
}

// ============================================
// Classification Logic
// ============================================

function countMatches(text: string, patterns: RegExp[]): number {
    return patterns.filter(p => p.test(text)).length
}

/**
 * Classify user intent based on the message content.
 * Returns the category, confidence, and suggested model.
 */
export function classifyIntent(message: string): IntentResult {
    // Long context detection (> 3000 chars = likely document/paste)
    if (message.length > 3000) {
        return {
            category: 'longcontext',
            confidence: 0.9,
            suggestedModel: getModelForCategory('longcontext'),
            reason: `Long input (${message.length} chars) → 2M context model`,
        }
    }

    const scores: Record<IntentCategory, number> = {
        simple: 0,
        code: 0,
        analysis: 0,
        creative: 0,
        search: 0,
        tool: 0,
        longcontext: 0,
    }

    // Score each category
    scores.simple = countMatches(message, SIMPLE_PATTERNS) * 2  // Weight simple higher for short messages
    scores.code = countMatches(message, CODE_PATTERNS) * 1.5
    scores.analysis = countMatches(message, ANALYSIS_PATTERNS) * 1.3
    scores.creative = countMatches(message, CREATIVE_PATTERNS) * 1.2
    scores.search = countMatches(message, SEARCH_PATTERNS)
    scores.tool = countMatches(message, TOOL_PATTERNS) * 1.4

    // Find highest scoring category
    let bestCategory: IntentCategory = 'simple'
    let bestScore = 0

    for (const [cat, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score
            bestCategory = cat as IntentCategory
        }
    }

    // Calculate confidence (normalize to 0-1)
    const totalPatterns = Math.max(
        SIMPLE_PATTERNS.length,
        CODE_PATTERNS.length,
        ANALYSIS_PATTERNS.length,
    )
    const confidence = Math.min(bestScore / totalPatterns, 1)

    // If no strong signal, default to 'simple' with flash
    if (bestScore === 0) {
        return {
            category: 'simple',
            confidence: 0.5,
            suggestedModel: getModelForCategory('simple'),
            reason: 'No strong intent signal → default fast model',
        }
    }

    return {
        category: bestCategory,
        confidence: Math.round(confidence * 100) / 100,
        suggestedModel: getModelForCategory(bestCategory),
        reason: `Matched ${bestCategory} patterns (score=${bestScore.toFixed(1)})`,
    }
}

/**
 * Get the model for a given intent category, respecting overrides.
 */
function getModelForCategory(category: IntentCategory): string {
    return routerConfig.modelOverrides[category] || buildModelMap()[category]
}

/**
 * Route a message to the optimal model.
 * Returns the model name to use, or null if routing is disabled
 * or confidence is too low (caller should use primary model).
 */
export function routeToModel(message: string): {
    model: string
    intent: IntentResult
    routed: boolean
} {
    const intent = classifyIntent(message)

    if (!routerConfig.enabled || intent.confidence < routerConfig.confidenceThreshold) {
        return {
            model: buildModelMap().simple, // Default to fast
            intent,
            routed: false,
        }
    }

    console.log(`[IntentRouter] 🎯 ${intent.category} (${Math.round(intent.confidence * 100)}%) → ${intent.suggestedModel}: ${intent.reason}`)

    return {
        model: intent.suggestedModel,
        intent,
        routed: true,
    }
}

// ============================================
// Configuration
// ============================================

export function configureRouter(updates: Partial<RouterConfig>): void {
    routerConfig = { ...routerConfig, ...updates }
    console.log(`[IntentRouter] ⚙️ Config updated: enabled=${routerConfig.enabled}, threshold=${routerConfig.confidenceThreshold}`)
}

export function getRouterConfig(): RouterConfig {
    return { ...routerConfig }
}

/**
 * Get the full model map (default + overrides).
 */
export function getModelMap(): Record<IntentCategory, string> {
    const map = { ...buildModelMap() }
    for (const [cat, model] of Object.entries(routerConfig.modelOverrides)) {
        if (model) map[cat as IntentCategory] = model
    }
    return map
}
