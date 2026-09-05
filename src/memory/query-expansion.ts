/**
 * Query Expansion — LLM-Enhanced Memory Queries
 *
 * Uses the LLM to expand ambiguous queries before searching memory.
 * "what was that IP?" → "IP address server network configuration device"
 */

// ============================================
// Types
// ============================================

export interface QueryExpansionConfig {
    /** Enable/disable query expansion. Default: true */
    enabled: boolean
    /** Max tokens for expansion prompt. Default: 50 */
    maxTokens: number
}

export const DEFAULT_EXPANSION_CONFIG: QueryExpansionConfig = {
    enabled: true,
    maxTokens: 50,
}

// ============================================
// Expansion Logic
// ============================================

/**
 * Expand a query using the LLM to add related terms.
 * Falls back to original query if LLM is unavailable.
 */
export async function expandQuery(
    query: string,
    config: Partial<QueryExpansionConfig> = {},
    llmComplete?: (prompt: string) => Promise<string>
): Promise<string> {
    const fullConfig = { ...DEFAULT_EXPANSION_CONFIG, ...config }

    if (!fullConfig.enabled || !llmComplete) return query
    if (query.length > 200) return query // Long queries don't need expansion

    try {
        const prompt = `You are a search query expander. Given a short user query, add 3-5 related keywords that would improve semantic search recall. Return ONLY the expanded query, no explanation.

User query: "${query}"

Expanded query:`

        const expanded = await llmComplete(prompt)

        if (expanded && expanded.length > 0 && expanded.length < 500) {
            // Combine original + expansion for best results
            return `${query} ${expanded.trim()}`
        }
    } catch {
        // LLM unavailable, use original query
    }

    return query
}

/**
 * Simple rule-based expansion for common patterns.
 * Used as a fallback when LLM is unavailable.
 */
export function expandQueryRuleBased(query: string): string {
    const lowerQuery = query.toLowerCase()
    const additions: string[] = []

    // IP-related
    if (lowerQuery.includes('ip') || lowerQuery.includes('adresse')) {
        additions.push('IP-Adresse', 'Server', 'Netzwerk', 'Konfiguration')
    }

    // Password/Auth
    if (lowerQuery.includes('passwort') || lowerQuery.includes('password') || lowerQuery.includes('login')) {
        additions.push('Zugangsdaten', 'Authentifizierung', 'Credentials', 'Token')
    }

    // Error/Bug
    if (lowerQuery.includes('fehler') || lowerQuery.includes('error') || lowerQuery.includes('bug')) {
        additions.push('Lösung', 'Fix', 'Fehlerbehebung', 'Workaround')
    }

    // Deploy/Server
    if (lowerQuery.includes('deploy') || lowerQuery.includes('server')) {
        additions.push('Deployment', 'Hosting', 'Infrastruktur', 'SSH')
    }

    // API
    if (lowerQuery.includes('api')) {
        additions.push('Endpoint', 'Route', 'Key', 'Schnittstelle')
    }

    if (additions.length > 0) {
        return `${query} ${additions.join(' ')}`
    }

    return query
}

export default { expandQuery, expandQueryRuleBased, DEFAULT_EXPANSION_CONFIG }
