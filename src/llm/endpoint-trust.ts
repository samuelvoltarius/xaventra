/**
 * Endpoint trust helpers.
 *
 * Two rules from the owner:
 *   1. Keys only go to the provider they belong to. OPENAI_API_KEY from the
 *      environment is sent to api.openai.com (or the explicitly configured
 *      OPENAI_BASE_URL host) and nowhere else — never as a generic fallback
 *      bearer for vLLM, LM Studio, mesh nodes or other cloud providers.
 *   2. Local first. A cloud endpoint is never chosen silently as a failover
 *      target; `isLocalEndpoint` decides what counts as local.
 */

function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    } catch {
        return null
    }
}

/** Hosts that may receive OPENAI_API_KEY from the environment. */
function openAIKeyHosts(): Set<string> {
    const hosts = new Set(['api.openai.com'])
    const configured = process.env.OPENAI_BASE_URL
    if (configured) {
        const host = hostOf(configured)
        if (host) hosts.add(host)
    }
    return hosts
}

/**
 * Returns OPENAI_API_KEY only when `endpoint` is OpenAI's own API (or the
 * explicitly configured OPENAI_BASE_URL). Everything else gets undefined.
 */
export function envOpenAIKeyFor(endpoint: string): string | undefined {
    const key = process.env.OPENAI_API_KEY
    if (!key) return undefined
    const host = hostOf(endpoint)
    if (!host) return undefined
    return openAIKeyHosts().has(host) ? key : undefined
}

/**
 * True for loopback, private LAN, Tailscale (100.64.0.0/10), link-local and
 * single-label / local-suffix hostnames. Public hosts count as cloud.
 */
export function isLocalEndpoint(endpoint: string): boolean {
    const host = hostOf(endpoint)
    if (!host) return false
    if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])]
        if (a === 127 || a === 10) return true
        if (a === 192 && b === 168) return true
        if (a === 172 && b >= 16 && b <= 31) return true
        if (a === 169 && b === 254) return true
        if (a === 100 && b >= 64 && b <= 127) return true
        return false
    }
    if (host.includes(':')) {
        // IPv6: unique-local fc00::/7 and link-local fe80::/10
        return /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
    }
    if (!host.includes('.')) return true
    return /\.(local|lan|home|internal|ts\.net|test)$/.test(host)
}
