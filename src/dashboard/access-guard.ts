/**
 * Dashboard access guard (INT-10).
 *
 * The dashboard has no login. Its only owner guarantee is that it is used from
 * the machine it runs on. The bind host is configurable (dashboard.host), so
 * the guarantee is enforced per request for everything that exposes memory,
 * conversations or configuration: the peer address must be loopback AND the
 * Host header must name a loopback host (defeats DNS rebinding, where a
 * foreign web page reaches 127.0.0.1 under its own host name). WebSocket
 * upgrades additionally reject foreign browser origins (cross-site WebSocket
 * hijacking).
 */

import { timingSafeEqual } from 'node:crypto'

/** Routes that expose memory, conversations, knowledge or configuration. */
export const DASHBOARD_OWNER_ONLY_PREFIXES: readonly string[] = Object.freeze([
    '/api/memory', '/api/core-facts', '/api/graph', '/api/journal', '/api/sessions',
    '/api/chat', '/api/summaries', '/api/config', '/api/logs', '/api/cold-storage',
])

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

export interface DashboardRequestLike {
    remoteAddress?: string | null
    host?: string
    origin?: string
}

/** Owner-only: loopback peer, loopback Host header, and (if sent) an Origin equal to that Host. */
export function isDashboardOwnerRequest(request: DashboardRequestLike): boolean {
    if (!isLoopbackAddress(request.remoteAddress)) return false
    if (!isLoopbackHostHeader(request.host)) return false
    return isSameOriginRequest(request.host, request.origin)
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

/** Cookie set by `/?token=…`; HttpOnly + SameSite=Strict, so foreign sites never send it. */
export const DASHBOARD_TOKEN_COOKIE = 'nova_dashboard_token'

type HeaderBag = Record<string, string | string[] | undefined>

/** Token from `Authorization: Bearer`, `x-nova-dashboard-token` or the dashboard cookie. */
export function dashboardTokenFromHeaders(headers: HeaderBag): string {
    const auth = typeof headers.authorization === 'string' ? headers.authorization.trim() : ''
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
    const header = headers['x-nova-dashboard-token']
    if (typeof header === 'string' && header.trim()) return header.trim()
    const cookie = typeof headers.cookie === 'string' ? headers.cookie : ''
    for (const part of cookie.split(';')) {
        const index = part.indexOf('=')
        if (index < 0 || part.slice(0, index).trim() !== DASHBOARD_TOKEN_COOKIE) continue
        try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return '' }
    }
    return ''
}

/** Constant-time comparison; an empty or short expected token never matches (fail-closed). */
export function isValidDashboardToken(supplied: unknown, expected: string | undefined): boolean {
    if (typeof supplied !== 'string' || !expected || expected.length < 32) return false
    const a = Buffer.from(supplied)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

export function isDashboardOwnerOnlyPath(path: string): boolean {
    return DASHBOARD_OWNER_ONLY_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))
}
