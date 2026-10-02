/**
 * Access guard for the browser path of the one UI (and the Desktop-Direkt
 * gateway): loopback detection, DNS-rebinding Host check, same-origin check
 * and the constant-time token comparison. Owner data itself is decided by the
 * Desktop API (desktop-api.ts, NOVA_DESKTOP_API_TOKEN).
 */

import { timingSafeEqual } from 'node:crypto'

export function isLoopbackAddress(address: string | undefined | null): boolean {
    const ip = String(address || '').trim().toLowerCase()
    if (!ip) return false
    if (ip === '::1') return true
    const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

function hostnameOf(value: string | undefined): string {
    const raw = String(value || '').trim().toLowerCase()
    if (!raw) return ''
    if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') > 0 ? raw.indexOf(']') : undefined)
    const colon = raw.lastIndexOf(':')
    return colon > 0 && raw.indexOf(':') === colon ? raw.slice(0, colon) : raw
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
    const name = hostnameOf(host)
    return name === 'localhost' || name === '::1' || isLoopbackAddress(name)
}

/**
 * C-1: a browser Origin, when sent, must be this dashboard itself (same
 * scheme-less host:port as the Host header). Another local web app on a
 * different port (http://localhost:5173) is a different origin.
 */
export function isSameOriginRequest(host: string | undefined, origin: string | undefined): boolean {
    if (origin === undefined || origin === '') return true
    try {
        const own = String(host || '').trim().toLowerCase()
        return Boolean(own) && new URL(origin).host.toLowerCase() === own
    } catch {
        return false
    }
}

/**
 * H-1 (DNS rebinding): only loopback Host names or the explicitly configured
 * bind host are served. A rebound attacker domain never matches.
 */
export function isAllowedDashboardHost(host: string | undefined, configuredHosts: Iterable<string> = []): boolean {
    if (isLoopbackHostHeader(host)) return true
    const name = hostnameOf(host)
    if (!name) return false
    for (const configured of configuredHosts) {
        if (hostnameOf(configured) === name) return true
    }
    return false
}

type HeaderBag = Record<string, string | string[] | undefined>

/** Token from `Authorization: Bearer` or `x-nova-dashboard-token` (no cookie: the UI sends it per request). */
export function dashboardTokenFromHeaders(headers: HeaderBag): string {
    const auth = typeof headers.authorization === 'string' ? headers.authorization.trim() : ''
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
    const header = headers['x-nova-dashboard-token']
    if (typeof header === 'string' && header.trim()) return header.trim()
    return ''
}

/** Constant-time comparison; an empty or short expected token never matches (fail-closed). */
export function isValidDashboardToken(supplied: unknown, expected: string | undefined): boolean {
    if (typeof supplied !== 'string' || !expected || expected.length < 32) return false
    const a = Buffer.from(supplied)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

