import { fetchModelList } from './model-list-cache.js'

/** Server metadata for the exact configured alias, not a guess from inventory order.
 * This describes configuration, not the provider chosen by a later failover. */
export async function resolveRuntimeModelIdentity(config: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }) {
    const identity = { provider: config.provider || 'unbekannt', alias: config.model || 'unbekannt', model: null as string | null }
    if (config.provider !== 'local' || !config.baseUrl || !config.model) return identity
    try {
        const base = new URL(config.baseUrl)
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return identity
        const prefix = base.href.replace(/\/$/, '')
        const url = `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/models`
        const response = await fetchModelList(url, { timeoutMs: 2500, maxAgeMs: 0,
            headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} })
        if (!response.ok) return identity
        const data = (await response.json())?.data
        const matches = Array.isArray(data) ? data.filter(entry => entry?.id === config.model) : []
        if (matches.length !== 1) return identity
        const root = matches[0].root
        // Only a model identifier; never expose a host filesystem path or instructions.
        if (typeof root === 'string' && root !== config.model && /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(root) && root.length <= 160) identity.model = root
    } catch { /* Unavailable metadata must not turn a status question into an error. */ }
    return identity
}
