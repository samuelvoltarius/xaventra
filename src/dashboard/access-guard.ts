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

/** Owner-only: loopback peer, loopback Host header, and (if sent) a loopback Origin. */
export function isDashboardOwnerRequest(request: DashboardRequestLike): boolean {
    if (!isLoopbackAddress(request.remoteAddress)) return false
    if (!isLoopbackHostHeader(request.host)) return false
    if (request.origin !== undefined && request.origin !== '') {
        try {
            if (!isLoopbackHostHeader(new URL(request.origin).host)) return false
        } catch {
            return false
        }
    }
    return true
}

export function isDashboardOwnerOnlyPath(path: string): boolean {
    return DASHBOARD_OWNER_ONLY_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))
}
