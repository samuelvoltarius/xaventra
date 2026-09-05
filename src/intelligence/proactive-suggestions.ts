/**
 * Proactive Suggestions
 * 
 * Generates helpful follow-up suggestions based on context.
 * Nova proactively offers next steps without being asked.
 */

// ============================================
// Types
// ============================================

export interface Suggestion {
    text: string
    action?: string  // Tool call if user accepts
    priority: 'high' | 'medium' | 'low'
}

export interface SuggestionContext {
    lastToolName?: string
    lastToolResult?: unknown
    lastError?: string
    userMessage: string
}

// ============================================
// Suggestion Generators
// ============================================

const GENERATORS: Array<{
    condition: (ctx: SuggestionContext) => boolean
    generate: (ctx: SuggestionContext) => Suggestion[]
}> = [
        {
            // After successful file creation
            condition: (ctx) => ctx.lastToolName === 'write_file' && !ctx.lastError,
            generate: (ctx) => {
                const result = ctx.lastToolResult as { path?: string }
                const path = result?.path || 'die Datei'
                return [
                    { text: `Soll ich ${path} ausführen?`, action: `run_command`, priority: 'high' },
                    { text: `Soll ich den Inhalt nochmal zeigen?`, action: `read_file`, priority: 'low' },
                ]
            }
        },
        {
            // After failed install
            condition: (ctx) => ctx.lastToolName === 'run_command' && !!(
                ctx.lastError?.includes('not found') ||
                ctx.lastError?.includes('nicht gefunden')
            ),
            generate: (ctx) => {
                const pkg = ctx.lastError?.match(/'([^']+)'/)?.[1] || 'das Paket'
                return [
                    { text: `${pkg} scheint nicht installiert. Soll ich es installieren?`, action: 'run_command', priority: 'high' },
                    { text: `Soll ich nach einer Alternative suchen?`, action: 'web_search', priority: 'medium' },
                ]
            }
        },
        {
            // After search
            condition: (ctx) => ['web_search', 'tavily_search', 'brave_search'].includes(ctx.lastToolName || ''),
            generate: () => [
                { text: `Soll ich mehr Details zu einem der Ergebnisse holen?`, action: 'browse_url', priority: 'medium' },
            ]
        },
        {
            // After listing directory
            condition: (ctx) => ctx.lastToolName === 'list_directory',
            generate: () => [
                { text: `Soll ich eine bestimmte Datei öffnen?`, action: 'read_file', priority: 'medium' },
            ]
        },
        {
            // After any error
            condition: (ctx) => !!ctx.lastError,
            generate: (ctx) => [
                { text: `Soll ich nach einer Lösung für diesen Fehler suchen?`, action: 'web_search', priority: 'high' },
                { text: `Soll ich einen anderen Ansatz versuchen?`, priority: 'medium' },
            ]
        },
        {
            // User asked a question (ends with ?)
            condition: (ctx) => ctx.userMessage.trim().endsWith('?'),
            generate: () => [
                { text: `Soll ich mehr Informationen dazu suchen?`, action: 'web_search', priority: 'low' },
            ]
        },
    ]

// ============================================
// Main API
// ============================================

/**
 * Generate proactive suggestions based on context
 */
export function generateSuggestions(context: SuggestionContext): Suggestion[] {
    const suggestions: Suggestion[] = []

    for (const { condition, generate } of GENERATORS) {
        if (condition(context)) {
            suggestions.push(...generate(context))
        }
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

    // Return max 2 suggestions
    return suggestions.slice(0, 2)
}

/**
 * Format suggestions for display
 */
export function formatSuggestions(suggestions: Suggestion[]): string {
    if (suggestions.length === 0) return ''

    const formatted = suggestions.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
    return `\n\n💡 **Vorschläge:**\n${formatted}`
}

/**
 * Get prompt addition for proactive behavior
 */
export function getProactivePrompt(): string {
    return `

## PROAKTIVES VERHALTEN
Nachdem du eine Aktion abgeschlossen hast:
1. Überlege, was der nächste logische Schritt wäre
2. Biete dem User 1-2 konkrete Vorschläge an
3. Beispiel: "Soll ich das Script jetzt ausführen?" oder "Soll ich die Dependencies installieren?"`
}

export default {
    generateSuggestions,
    formatSuggestions,
    getProactivePrompt,
}
