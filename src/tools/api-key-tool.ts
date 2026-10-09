/**
 * API Key Management Tool
 *
 * Allows Nova to save API keys when user provides them in natural language.
 * Example: "Here's my Tavily key: tvly-xxx..."
 *
 * 2.89.4: same store as the chat-key intake — Tresor 0600 + redaction + env
 * activation. Never a clear value in xaventra.config.json, never a log excerpt.
 */

const PROVIDER_ALIASES: Record<string, string> = {
    brave: 'brave',
    brave_search: 'brave',
    bravesearch: 'brave',
    tavily: 'tavily',
    perplexity: 'perplexity',
}

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

        const serviceId = PROVIDER_ALIASES[provider]
        if (!serviceId) {
            return {
                success: false,
                error: `Unbekannter Provider: ${provider}`,
                available: ['brave', 'tavily', 'perplexity'],
            }
        }

        try {
            const { storeServiceApiKey } = await import('../secrets/service-keys.js')
            const { getUserPermission } = await import('../users/multi-user-middleware.js')
            const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
            const ctx = getExecutionPolicyContext()
            const owner = ctx.authUserId && getUserPermission(ctx.authUserId, ctx.channel) === 'owner'
            if (!owner) {
                return {
                    success: false,
                    error: 'API-Schlüssel speichere ich nur für den Owner (Direktchat) — Wert nicht gespeichert.',
                }
            }
            const stored = await storeServiceApiKey(serviceId, key, { context: `save_api_key:${serviceId}` })
            if (!stored.ok) {
                return { success: false, error: stored.message }
            }
            console.log(`[API Key] ${serviceId} im Tresor (${stored.id}) — Wert maskiert`)
            return {
                success: true,
                message: `✅ ${serviceId.charAt(0).toUpperCase() + serviceId.slice(1)} API Key ${stored.message}.`,
                provider: serviceId,
                hint: 'Du kannst jetzt im Internet suchen!',
            }
        } catch (err: any) {
            return {
                success: false,
                // Never echo a value that may sit in the error text.
                error: String(err?.message || err).slice(0, 160),
            }
        }
    },
}

export default { apiKeyTool }
