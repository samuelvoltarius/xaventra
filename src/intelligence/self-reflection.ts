/**
 * Self-Reflection Module
 * 
 * Provides post-response analysis and improvement suggestions.
 * Nova can reflect on her answers and improve them.
 */

// ============================================
// Types
// ============================================

export interface ReflectionResult {
    needsImprovement: boolean
    issues: string[]
    suggestions: string[]
    improvedResponse?: string
}

export interface ReflectionContext {
    userMessage: string
    assistantResponse: string
    toolsUsed: string[]
    toolResults: Array<{ tool: string; success: boolean; error?: string }>
}

// ============================================
// Reflection Checks
// ============================================

const QUALITY_CHECKS = [
    {
        name: 'empty_response',
        check: (ctx: ReflectionContext) =>
            !ctx.assistantResponse || ctx.assistantResponse.trim().length < 10,
        issue: 'Antwort ist zu kurz oder leer',
        suggestion: 'Gib eine ausführlichere Antwort',
    },
    {
        name: 'tool_failure_not_addressed',
        check: (ctx: ReflectionContext) => {
            const failures = ctx.toolResults.filter(r => !r.success)
            if (failures.length === 0) return false
            // Check if response mentions the failure
            return !ctx.assistantResponse.toLowerCase().includes('fehler') &&
                !ctx.assistantResponse.includes('❌')
        },
        issue: 'Tool-Fehler nicht kommuniziert',
        suggestion: 'Erkläre dem User, was schiefgelaufen ist',
    },
    {
        name: 'question_not_answered',
        check: (ctx: ReflectionContext) => {
            const isQuestion = ctx.userMessage.includes('?') ||
                /^(was|wer|wie|wo|wann|warum|welche)/i.test(ctx.userMessage)
            if (!isQuestion) return false
            // Very short response to a question is suspicious
            return ctx.assistantResponse.length < 50
        },
        issue: 'Frage möglicherweise nicht beantwortet',
        suggestion: 'Prüfe ob die Frage vollständig beantwortet wurde',
    },
    {
        name: 'english_in_german_context',
        check: (ctx: ReflectionContext) => {
            // Check for English patterns in response when user wrote German
            const isGermanUser = /[äöüß]|und|oder|nicht|ich|du|ist/i.test(ctx.userMessage)
            const hasEnglish = /\b(I am|I will|I can|you should|please)\b/i.test(ctx.assistantResponse)
            return isGermanUser && hasEnglish
        },
        issue: 'Englische Phrasen in deutscher Konversation',
        suggestion: 'Antworte konsequent auf Deutsch',
    },
    {
        name: 'no_tool_used_for_action',
        check: (ctx: ReflectionContext) => {
            const actionKeywords = ['installier', 'erstell', 'schreib', 'such', 'zeig', 'lese']
            const isActionRequest = actionKeywords.some(kw => ctx.userMessage.toLowerCase().includes(kw))
            return isActionRequest && ctx.toolsUsed.length === 0
        },
        issue: 'Aktion angefragt aber kein Tool verwendet',
        suggestion: 'Nutze die verfügbaren Tools um Aktionen auszuführen',
    },
]

// ============================================
// Main API
// ============================================

/**
 * Reflect on a response and check for quality issues
 */
export function reflect(context: ReflectionContext): ReflectionResult {
    const issues: string[] = []
    const suggestions: string[] = []

    for (const check of QUALITY_CHECKS) {
        if (check.check(context)) {
            issues.push(check.issue)
            suggestions.push(check.suggestion)
        }
    }

    return {
        needsImprovement: issues.length > 0,
        issues,
        suggestions,
    }
}

/**
 * Get a prompt addition that encourages reflection
 */
export function getReflectionPrompt(): string {
    return `
## SELBST-REFLEXION
Bevor du antwortest, prüfe kurz:
1. Habe ich die Frage verstanden?
2. Brauche ich ein Tool?
3. Ist meine Antwort hilfreich und vollständig?
4. Antworte ich auf Deutsch?`
}

/**
 * Log reflection results
 */
export function logReflection(result: ReflectionResult): void {
    if (result.needsImprovement) {
        console.log(`[Self-Reflection] ⚠️ Issues found:`)
        for (const issue of result.issues) {
            console.log(`  - ${issue}`)
        }
    } else {
        console.log(`[Self-Reflection] ✅ Response quality OK`)
    }
}

export default {
    reflect,
    getReflectionPrompt,
    logReflection,
}
