/**
 * Adaptive Chain-of-Thought Thinking System
 * 
 * Three modes:
 * - 'off': Never use thinking
 * - 'auto': Enable based on complexity score
 * - 'on': Always use thinking
 * 
 * Also supports failure recovery: retry with thinking if first attempt fails
 * 
 * IMPORTANT: Model-agnostic - works with any LLM!
 */

// ============================================
// Types
// ============================================

export type ThinkLevel = 'off' | 'auto' | 'on'

export interface ThinkingConfig {
    level: ThinkLevel
    /** Complexity threshold for auto mode (0-100) */
    autoThreshold: number
    /** Log thinking to console for debugging */
    logThinking: boolean
    /** Enable retry with thinking on failure */
    retryWithThinking: boolean
}

export interface ExtractedThinking {
    /** The thinking content (null if not found) */
    thinking: string | null
    /** The response content without thinking tags */
    content: string
    /** Whether thinking was present */
    hadThinking: boolean
}

// ============================================
// Default Configuration
// ============================================

export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
    level: 'auto',
    autoThreshold: 60,  // Enable thinking for complexity > 60
    logThinking: true,
    retryWithThinking: true,
}

// ============================================
// Thinking Prompt Builder
// ============================================

/**
 * Build the thinking instruction to inject into system prompt
 * Model-agnostic - works with any LLM that follows instructions
 */
export function buildThinkingPrompt(language: 'de' | 'en' = 'de'): string {
    if (language === 'en') {
        return `## THINKING PROCESS

For complex tasks, THINK FIRST using <thinking> tags:
<thinking>
- What exactly does the user want?
- Which tools do I need?
- What could go wrong?
- What's the best approach?
</thinking>

Then execute the action. The <thinking> block is NOT shown to the user!
ALWAYS use tools when actions are requested - never just describe what you would do.`
    }

    return `## DENKPROZESS

Bei komplexen Aufgaben, DENKE ZUERST in <thinking> Tags:
<thinking>
- Was genau will der Nutzer?
- Welche Tools brauche ich?
- Was könnte schiefgehen?
- Was ist der beste Ansatz?
</thinking>

Dann führe die Aktion aus. Der <thinking> Block wird NICHT an den Nutzer gezeigt!
BENUTZE IMMER Tools wenn Aktionen angefragt werden - beschreibe niemals nur was du tun würdest.`
}

// ============================================
// Thinking Extraction
// ============================================

/**
 * Extract <thinking>...</thinking> content from LLM response
 * Handles multiple thinking blocks and nested content
 */
export function extractThinking(response: string): ExtractedThinking {
    if (!response) {
        return { thinking: null, content: '', hadThinking: false }
    }

    // Match <thinking>...</thinking> blocks (case insensitive, multiline)
    const thinkingPattern = /<thinking>([\s\S]*?)<\/thinking>/gi
    const matches = [...response.matchAll(thinkingPattern)]

    if (matches.length === 0) {
        return { thinking: null, content: response.trim(), hadThinking: false }
    }

    // Collect all thinking content
    const thinkingParts = matches.map(m => m[1]?.trim()).filter(Boolean)
    const thinking = thinkingParts.join('\n---\n')

    // Remove thinking blocks from response
    const content = response
        .replace(thinkingPattern, '')
        .replace(/\n{3,}/g, '\n\n')  // Clean up excessive newlines
        .trim()

    return { thinking, content, hadThinking: true }
}

/**
 * Strip thinking tags from response (alias for extractThinking)
 */
export function stripThinking(response: string): string {
    return extractThinking(response).content
}

// ============================================
// Auto-Detection
// ============================================

/**
 * Determine if thinking should be enabled based on complexity score
 */
export function shouldEnableThinking(
    complexity: number,
    config: ThinkingConfig = DEFAULT_THINKING_CONFIG
): boolean {
    switch (config.level) {
        case 'off':
            return false
        case 'on':
            return true
        case 'auto':
        default:
            return complexity >= config.autoThreshold
    }
}

/**
 * Check if this looks like an action request that might benefit from thinking
 */
export function isComplexActionRequest(content: string): boolean {
    const actionKeywords = [
        'scan', 'netzwerk', 'install', 'deploy', 'create', 'build',
        'debug', 'fix', 'analyze', 'analyse', 'compare', 'evaluate',
        'implement', 'refactor', 'migrate', 'setup', 'configure',
        'search', 'find all', 'check all', 'verify', 'test',
    ]

    const lowerContent = content.toLowerCase()
    return actionKeywords.some(kw => lowerContent.includes(kw))
}

// ============================================
// Thinking State Management
// ============================================

// Per-user thinking preference (in-memory, resets on restart)
const userThinkingPrefs = new Map<string, ThinkLevel>()

export function getUserThinkingLevel(userId: string): ThinkLevel {
    return userThinkingPrefs.get(userId) ?? 'auto'
}

export function setUserThinkingLevel(userId: string, level: ThinkLevel): void {
    userThinkingPrefs.set(userId, level)
    console.log(`[Thinking] User ${userId} set thinking to: ${level}`)
}

// ============================================
// Thinking Retry Logic
// ============================================

/**
 * Build a retry prompt that emphasizes thinking
 * Used when first attempt failed without using tools
 */
export function buildThinkingRetryPrompt(): string {
    return `🧠 DENKPAUSE - Dein letzter Versuch hat NICHT funktioniert!

JETZT MUSST DU DENKEN. Schreibe <thinking> Tags und analysiere:

<thinking>
1. Was ging schief beim letzten Versuch?
2. Welches TOOL muss ich JETZT verwenden?
3. Wie lautet der exakte Befehl?
</thinking>

DANN: Führe die Aktion mit [TOOL:...] aus!`
}

// ============================================
// Export Default Config
// ============================================

export default {
    DEFAULT_THINKING_CONFIG,
    buildThinkingPrompt,
    extractThinking,
    stripThinking,
    shouldEnableThinking,
    isComplexActionRequest,
    getUserThinkingLevel,
    setUserThinkingLevel,
    buildThinkingRetryPrompt,
}
