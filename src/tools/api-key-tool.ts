/**
 * API Key Management Tool
 * 
 * Allows Nova to save API keys when user provides them in natural language.
 * Example: "Here's my Tavily key: tvly-xxx..."
 */

export const apiKeyTool = {
    name: 'save_api_key',
    description: 'Speichere einen API Key für Such-Dienste. Nutze dies wenn der User einen API Key gibt (Brave Search, Tavily, etc.)',
    category: 'system' as const,
    parameters: [
        { name: 'provider', type: 'string' as const, description: 'Service-Name: brave, tavily, perplexity', required: true },
        { name: 'key', type: 'string' as const, description: 'Der API Key', required: true },
    ],
    handler: async (params: Record<string, unknown>) => {
        // Defensive: ensure params exist and are strings
        const providerRaw = params?.provider
        const keyRaw = params?.key

        if (typeof providerRaw !== 'string' || typeof keyRaw !== 'string') {
            return {
                success: false,
                error: 'Provider und Key müssen als Strings angegeben werden',
            }
        }

        const provider = providerRaw.toLowerCase().trim()
        const key = keyRaw.trim()

        if (!provider || !key) {
            return {
                success: false,
                error: 'Provider und Key dürfen nicht leer sein',
            }
        }

        try {
            const { getNovaConfig, setNovaConfig } = await import('../core/config.js')
            const config = getNovaConfig()

            // Initialize apis if not exists
            if (!config.apis) {
                (config as any).apis = {}
            }

            // Map provider names to config keys
            const keyMapping: Record<string, string> = {
                'brave': 'brave_search_key',
                'brave_search': 'brave_search_key',
                'bravesearch': 'brave_search_key',
                'tavily': 'tavily_key',
                'perplexity': 'perplexity_key',
            }

            const configKey = keyMapping[provider]
            if (!configKey) {
                return {
                    success: false,
                    error: `Unbekannter Provider: ${provider}`,
                    available: ['brave', 'tavily', 'perplexity'],
                }
            }

            // Save the key
            (config.apis as any)[configKey] = key
            setNovaConfig(config)

            console.log(`[API Key] Saved ${provider} key: ${key.slice(0, 8)}...`)

            return {
                success: true,
                message: `✅ ${provider.charAt(0).toUpperCase() + provider.slice(1)} API Key gespeichert!`,
                provider,
                hint: 'Du kannst jetzt im Internet suchen!',
            }

        } catch (err: any) {
            return {
                success: false,
                error: err.message,
            }
        }
    },
}

export default { apiKeyTool }
