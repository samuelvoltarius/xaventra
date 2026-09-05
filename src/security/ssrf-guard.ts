/**
 * SSRF Guard — Network-Level Sandboxing
 * 
 * Prevents Server-Side Request Forgery attacks.
 * Skills/Tools can only access explicitly allowed local IPs.
 * All other local network requests are blocked.
 * 
 * This protects the local network from Nova scanning NAS, routers, etc.
 */

import { URL } from 'node:url'

// ============================================
// Configuration
// ============================================

// Explicitly allowed local addresses (add your devices here)
const LOCAL_ALLOWLIST: string[] = [
    '127.0.0.1',
    'localhost',
    // Ollama instances
    '100.64.0.21',    // Pi5 (Tailscale)
    '100.64.0.22',   // Jetson (Tailscale)
]

// Private IP ranges that are BLOCKED by default
const PRIVATE_RANGES = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,  // CGNAT / Tailscale
    /^169\.254\./,        // Link-local
    /^fc00:/,             // IPv6 private
    /^fd[0-9a-f]{2}:/i,  // IPv6 ULA
    /^fe80:/,             // IPv6 link-local
]

// Always blocked domains
const BLOCKED_DOMAINS = [
    'metadata.google.internal',
    '169.254.169.254',       // Cloud metadata
    'metadata.internal',
]

// ============================================
// Core Logic
// ============================================

export interface SSRFCheckResult {
    allowed: boolean
    reason?: string
    url: string
    host: string
    isLocal: boolean
}

/**
 * Check if a URL is safe to fetch.
 * Blocks access to local network unless explicitly allowed.
 */
export function checkSSRF(urlString: string): SSRFCheckResult {
    let parsed: URL
    try {
        parsed = new URL(urlString)
    } catch {
        return { allowed: false, reason: 'Invalid URL', url: urlString, host: '', isLocal: false }
    }

    const host = parsed.hostname.toLowerCase()

    // Always block cloud metadata endpoints
    if (BLOCKED_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) {
        return {
            allowed: false,
            reason: `🚨 Cloud Metadata Endpoint blockiert: ${host}`,
            url: urlString,
            host,
            isLocal: true,
        }
    }

    // Check if it's a private/local IP
    const isLocal = isLocalAddress(host)

    if (isLocal) {
        // Check allowlist
        if (LOCAL_ALLOWLIST.includes(host)) {
            return { allowed: true, url: urlString, host, isLocal: true }
        }

        return {
            allowed: false,
            reason: `🛡️ Lokale Netzwerk-Adresse blockiert: ${host} (nicht in Allowlist)`,
            url: urlString,
            host,
            isLocal: true,
        }
    }

    // External URLs are allowed
    return { allowed: true, url: urlString, host, isLocal: false }
}

/**
 * Check if a hostname resolves to a local/private address
 */
function isLocalAddress(host: string): boolean {
    // Direct IP check
    if (PRIVATE_RANGES.some(r => r.test(host))) return true

    // Localhost variants
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    if (host.endsWith('.local') || host.endsWith('.internal')) return true

    // 0.0.0.0
    if (host === '0.0.0.0') return true

    return false
}

/**
 * Add a host to the allowlist at runtime
 */
export function allowLocalHost(host: string): void {
    if (!LOCAL_ALLOWLIST.includes(host)) {
        LOCAL_ALLOWLIST.push(host)
        console.log(`[SSRF Guard] ✅ Added to allowlist: ${host}`)
    }
}

/**
 * Get current allowlist
 */
export function getAllowlist(): string[] {
    return [...LOCAL_ALLOWLIST]
}

/**
 * Wrap fetch with SSRF protection
 */
export async function safeFetch(url: string, options?: RequestInit): Promise<Response> {
    const check = checkSSRF(url)
    if (!check.allowed) {
        console.log(`[SSRF Guard] 🚨 BLOCKED: ${check.reason}`)
        throw new Error(`SSRF Guard: ${check.reason}`)
    }
    return fetch(url, options)
}

export function initSSRFGuard(): void {
    console.log(`[SSRF Guard] ✅ Initialized — ${LOCAL_ALLOWLIST.length} hosts in allowlist`)
}
