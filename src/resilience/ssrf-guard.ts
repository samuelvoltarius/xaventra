/**
 * Nova — SSRF Guard (Server-Side Request Forgery Protection)
 *
 * Blocks outbound fetch() calls to private/metadata IP ranges.
 * Based on OpenClaw v2026.2.19 SSRF protection pattern.
 *
 * Usage:
 *   import { fetchWithSsrfGuard } from '../resilience/ssrf-guard.js'
 *   const res = await fetchWithSsrfGuard('https://example.com/api')
 */

import { createConnection } from 'node:net'

// ============================================
// Blocked IP Ranges
// ============================================

const BLOCKED_CIDRS = [
    // Loopback
    /^127\./,
    /^::1$/,
    // Link-local
    /^169\.254\./,
    /^fe80:/i,
    // Private RFC 1918
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    // Cloud metadata endpoints
    /^100\.64\./,       // Shared address space (RFC 6598)
    /^0\./,             // This network
    /^::ffff:0a/i,      // IPv4-mapped private
    /^::ffff:7f/i,      // IPv4-mapped loopback
    /^::ffff:a9fe/i,    // IPv4-mapped link-local
]

const BLOCKED_HOSTS = [
    'metadata.google.internal',
    '169.254.169.254',          // AWS/GCP/Azure metadata
    'fd00::ec2:254',            // AWS IPv6 metadata
    'metadata.azure.com',
]

// ============================================
// Validation
// ============================================

export interface SsrfCheckResult {
    allowed: boolean
    reason?: string
}

export const checkUrl = (url: string): SsrfCheckResult => {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return { allowed: false, reason: `Invalid URL: ${url}` }
    }

    const hostname = parsed.hostname.toLowerCase()

    // Block known dangerous hostnames
    if (BLOCKED_HOSTS.some(h => hostname === h || hostname.endsWith(`.${h}`))) {
        return { allowed: false, reason: `Blocked host: ${hostname}` }
    }

    // Block private/loopback IPs
    for (const pattern of BLOCKED_CIDRS) {
        if (pattern.test(hostname)) {
            return { allowed: false, reason: `Blocked IP range: ${hostname}` }
        }
    }

    // Block non-http(s) schemes
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` }
    }

    return { allowed: true }
}

// ============================================
// Protected fetch()
// ============================================

export const fetchWithSsrfGuard = async (
    url: string,
    options?: RequestInit
): Promise<Response> => {
    const check = checkUrl(url)
    if (!check.allowed) {
        throw new Error(`[SSRF] Request blocked: ${check.reason}`)
    }
    return fetch(url, options)
}

/**
 * Middleware-style wrapper for multiple URLs (e.g. webhook delivery)
 */
export const validateWebhookUrl = (url: string): void => {
    const check = checkUrl(url)
    if (!check.allowed) {
        throw new Error(`[SSRF] Webhook URL rejected: ${check.reason}`)
    }
}

/**
 * Filter a list of URLs, returning only allowed ones with reasons for blocked
 */
export const filterUrls = (urls: string[]): {
    allowed: string[]
    blocked: Array<{ url: string; reason: string }>
} => {
    const allowed: string[] = []
    const blocked: Array<{ url: string; reason: string }> = []

    for (const url of urls) {
        const check = checkUrl(url)
        if (check.allowed) {
            allowed.push(url)
        } else {
            blocked.push({ url, reason: check.reason || 'Unknown reason' })
        }
    }

    return { allowed, blocked }
}
