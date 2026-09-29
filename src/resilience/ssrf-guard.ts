/**
 * Nova — SSRF Guard (Server-Side Request Forgery Protection)
 *
 * Blocks outbound requests to loopback, private, link-local, CGNAT/Tailscale,
 * multicast, reserved and cloud-metadata destinations.
 *
 * - Literal hosts are classified after WHATWG URL normalisation (decimal,
 *   octal and hex IPv4 forms become dotted quads) plus an inet_aton fallback.
 * - IPv6 literals are expanded; IPv4-mapped/-compatible, NAT64, 6to4 and
 *   Teredo forms are blocked or checked through their embedded IPv4 address.
 * - Host names are resolved and EVERY resolved address must be public. The
 *   connection is then pinned to a validated address (no DNS rebinding
 *   between check and connect).
 * - Redirects are followed manually (max 5) and every hop is re-checked.
 *
 * Usage:
 *   import { fetchWithSsrfGuard } from '../resilience/ssrf-guard.js'
 *   const res = await fetchWithSsrfGuard('https://example.com/api')
 */

import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

// ============================================
// Blocked ranges
// ============================================

const BLOCKED_IPV4_CIDRS: Array<[string, number, string]> = [
    ['0.0.0.0', 8, 'this network'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'CGNAT / Tailscale'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local / cloud metadata'],
    ['172.16.0.0', 12, 'private'],
    ['192.0.0.0', 24, 'IETF protocol assignments'],
    ['192.0.2.0', 24, 'documentation'],
    ['192.88.99.0', 24, '6to4 relay'],
    ['192.168.0.0', 16, 'private'],
    ['198.18.0.0', 15, 'benchmarking'],
    ['198.51.100.0', 24, 'documentation'],
    ['203.0.113.0', 24, 'documentation'],
    ['224.0.0.0', 4, 'multicast'],
    ['240.0.0.0', 4, 'reserved / broadcast'],
]

const BLOCKED_HOSTS = [
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'metadata',
    'metadata.google.internal',
    'metadata.azure.com',
    'instance-data',
]

/** Suffixes that only exist on local networks. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa']

// ============================================
// Types
// ============================================

export interface SsrfCheckResult {
    allowed: boolean
    reason?: string
}

export interface ResolvedAddress { address: string; family: number }

export interface SsrfResolvedCheckResult extends SsrfCheckResult {
    hostname?: string
    addresses?: ResolvedAddress[]
}

export interface SsrfGuardOptions {
    /** DNS resolver (defaults to the system resolver, all addresses). */
    lookup?: (hostname: string) => Promise<ResolvedAddress[]>
    /** Explicit operator allowlist of exact IP addresses (default: none). */
    allowedAddresses?: string[]
    /** Maximum redirects to follow (default 5, hard cap 5). */
    maxRedirects?: number
}

// ============================================
// Address classification
// ============================================

function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0) >>> 0
}

function intToIpv4(value: number): string {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

function ipv4Blocked(ip: string): string | null {
    const value = ipv4ToInt(ip)
    for (const [base, bits, label] of BLOCKED_IPV4_CIDRS) {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
        if (((value & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return label
    }
    return null
}

/** inet_aton style parser: 1-4 parts, each decimal, octal (0…) or hex (0x…). */
function parseLegacyIpv4(host: string): string | null {
    if (!/^[0-9a-fx.]+$/i.test(host) || host.startsWith('.') || host.includes('..')) return null
    const parts = host.replace(/\.$/, '').split('.')
    if (parts.length < 1 || parts.length > 4) return null
    const nums: number[] = []
    for (const part of parts) {
        let n: number
        if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16)
        else if (/^0[0-7]*$/.test(part)) n = part.length === 1 ? 0 : parseInt(part.slice(1), 8)
        else if (/^[1-9][0-9]*$/.test(part)) n = parseInt(part, 10)
        else return null
        if (!Number.isFinite(n)) return null
        nums.push(n)
    }
    const last = nums.pop()!
    if (nums.some(n => n > 255)) return null
    if (last >= 256 ** (4 - nums.length)) return null
    let value = last
    nums.forEach((n, i) => { value += n * 256 ** (3 - i) })
    return intToIpv4(value >>> 0)
}

/** Expand an IPv6 literal to 8 hextets; null if unparseable. */
function parseIpv6(input: string): number[] | null {
    let ip = input.toLowerCase()
    const zone = ip.indexOf('%')
    if (zone >= 0) ip = ip.slice(0, zone)
    let tail: number[] = []
    const lastColon = ip.lastIndexOf(':')
    const lastPart = ip.slice(lastColon + 1)
    if (lastPart.includes('.')) {
        if (isIP(lastPart) !== 4) return null
        const v = ipv4ToInt(lastPart)
        tail = [v >>> 16, v & 0xffff]
        ip = ip.slice(0, lastColon + 1) + '0:0'
    }
    const halves = ip.split('::')
    if (halves.length > 2) return null
    const parse = (s: string) => (s ? s.split(':') : []).map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN))
    const head = parse(halves[0])
    const rest = halves.length === 2 ? parse(halves[1]) : []
    if ([...head, ...rest].some(Number.isNaN)) return null
    let groups: number[]
    if (halves.length === 2) {
        const fill = 8 - head.length - rest.length
        if (fill < 0) return null
        groups = [...head, ...new Array(fill).fill(0), ...rest]
    } else groups = head
    if (groups.length !== 8) return null
    if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1] }
    return groups
}

function embeddedIpv4(hi: number, lo: number): string {
    return intToIpv4(((hi << 16) >>> 0) + lo)
}

function ipv6Blocked(ip: string): string | null {
    const h = parseIpv6(ip)
    if (!h) return 'unparseable IPv6'
    const zeroPrefix = (n: number) => h.slice(0, n).every(x => x === 0)
    if (h.every(x => x === 0)) return 'unspecified'
    if (zeroPrefix(7) && h[7] === 1) return 'loopback'
    if (zeroPrefix(5) && h[5] === 0xffff) return 'IPv4-mapped IPv6'
    if (zeroPrefix(4) && h[4] === 0xffff && h[5] === 0) return 'IPv4-translated IPv6'
    if (zeroPrefix(6)) return 'IPv4-compatible IPv6'
    if (h[0] === 0x64 && h[1] === 0xff9b) {
        if (h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
            const v4 = ipv4Blocked(embeddedIpv4(h[6], h[7]))
            return v4 ? `NAT64 → ${v4}` : null
        }
        return 'local-use NAT64'
    }
    if (h[0] === 0x2002) {
        const v4 = ipv4Blocked(embeddedIpv4(h[1], h[2]))
        return v4 ? `6to4 → ${v4}` : null
    }
    if (h[0] === 0x2001 && h[1] === 0) return 'Teredo'
    if (h[0] === 0x2001 && h[1] === 0x0db8) return 'documentation'
    if ((h[0] & 0xfe00) === 0xfc00) return 'unique-local (ULA)'
    if ((h[0] & 0xffc0) === 0xfe80) return 'link-local'
    if ((h[0] & 0xffc0) === 0xfec0) return 'site-local'
    if ((h[0] & 0xff00) === 0xff00) return 'multicast'
    return null
}

/** Classify a single IP address literal. */
export function checkAddress(address: string, allowedAddresses: string[] = []): SsrfCheckResult {
    const ip = address.replace(/^\[|\]$/g, '')
    const family = isIP(ip.split('%')[0])
    if (allowedAddresses.includes(ip)) return { allowed: true }
    if (family === 4) {
        const reason = ipv4Blocked(ip)
        return reason ? { allowed: false, reason: `Blocked IP range (${reason}): ${ip}` } : { allowed: true }
    }
    if (family === 6 || ip.includes(':')) {
        const reason = ipv6Blocked(ip)
        return reason ? { allowed: false, reason: `Blocked IP range (${reason}): ${ip}` } : { allowed: true }
    }
    return { allowed: false, reason: `Not an IP address: ${address}` }
}

function normalizeHostname(hostname: string): string {
    return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
}

/** Classify a host (name or literal) without DNS. */
export function checkHost(hostname: string, allowedAddresses: string[] = []): SsrfCheckResult {
    const host = normalizeHostname(hostname)
    if (!host) return { allowed: false, reason: 'Empty host' }
    if (BLOCKED_HOSTS.includes(host) || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
        return { allowed: false, reason: `Blocked host: ${host}` }
    }
    if (isIP(host.split('%')[0]) || host.includes(':')) return checkAddress(host, allowedAddresses)
    const legacy = parseLegacyIpv4(host)
    if (legacy) return checkAddress(legacy, allowedAddresses)
    return { allowed: true }
}

// ============================================
// URL validation
// ============================================

function parseHttpUrl(url: string): { parsed?: URL; result?: SsrfCheckResult } {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return { result: { allowed: false, reason: `Invalid URL: ${url}` } }
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { result: { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` } }
    }
    return { parsed }
}

/** Synchronous literal check (no DNS). Use checkUrlResolved before connecting. */
export const checkUrl = (url: string): SsrfCheckResult => {
    const { parsed, result } = parseHttpUrl(url)
    if (!parsed) return result!
    return checkHost(parsed.hostname)
}

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
    return dnsLookup(hostname, { all: true, verbatim: true })
}

/** Literal check plus DNS resolution; every resolved address must be allowed. */
export async function checkUrlResolved(url: string, options: SsrfGuardOptions = {}): Promise<SsrfResolvedCheckResult> {
    const allowedAddresses = options.allowedAddresses ?? []
    const { parsed, result } = parseHttpUrl(url)
    if (!parsed) return result!
    const hostname = normalizeHostname(parsed.hostname)
    const literal = checkHost(parsed.hostname, allowedAddresses)
    if (!literal.allowed) return { ...literal, hostname }
    const family = isIP(hostname)
    if (family) return { allowed: true, hostname, addresses: [{ address: hostname, family }] }
    const legacy = parseLegacyIpv4(hostname)
    if (legacy) return { allowed: true, hostname, addresses: [{ address: legacy, family: 4 }] }

    let addresses: ResolvedAddress[]
    try {
        addresses = await (options.lookup ?? systemLookup)(hostname)
    } catch (error) {
        return { allowed: false, hostname, reason: `DNS resolution failed for ${hostname}: ${String(error)}` }
    }
    if (!addresses?.length) return { allowed: false, hostname, reason: `No addresses for ${hostname}` }
    for (const entry of addresses) {
        const check = checkAddress(entry.address, allowedAddresses)
        if (!check.allowed) return { allowed: false, hostname, reason: `${hostname} resolves to a blocked address — ${check.reason}` }
    }
    return { allowed: true, hostname, addresses }
}

// ============================================
// Protected fetch()
// ============================================

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])
const MAX_REDIRECTS = 5

function requestBody(body: RequestInit['body']): string | Uint8Array | undefined {
    if (body === undefined || body === null) return undefined
    if (typeof body === 'string') return body
    if (body instanceof Uint8Array) return body
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (body instanceof URLSearchParams) return body.toString()
    throw new Error('[SSRF] Unsupported request body type for guarded fetch')
}

function toResponse(res: IncomingMessage, url: string): Response {
    const headers = new Headers()
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
        try { headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]) } catch { /* skip invalid header */ }
    }
    const status = res.statusCode || 502
    if (NULL_BODY_STATUSES.has(status)) {
        res.resume()
        return new Response(null, { status, statusText: res.statusMessage, headers })
    }
    let stream: NodeJS.ReadableStream = res
    const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
    const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
        : encoding === 'deflate' ? createInflate()
            : encoding === 'br' ? createBrotliDecompress() : null
    if (decoder) {
        stream = res.pipe(decoder)
        res.on('error', error => decoder.destroy(error))
        headers.delete('content-encoding')
        headers.delete('content-length')
    }
    const response = new Response(Readable.toWeb(stream as Readable) as ReadableStream, { status, statusText: res.statusMessage, headers })
    Object.defineProperty(response, 'url', { value: url })
    return response
}

function pinnedRequest(url: URL, address: ResolvedAddress, init: { method: string; headers: Headers; body?: string | Uint8Array; signal?: AbortSignal }): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {}
        init.headers.forEach((value, key) => { headers[key] = value })
        if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br'
        if (init.body !== undefined && !headers['content-length']) headers['content-length'] = String(Buffer.byteLength(init.body))
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            method: init.method,
            headers,
            signal: init.signal,
            // Connect only to the address that was validated above.
            lookup: ((_hostname: string, options: any, callback: any) => {
                const cb = typeof options === 'function' ? options : callback
                if (options && typeof options === 'object' && options.all) cb(null, [{ address: address.address, family: address.family }])
                else cb(null, address.address, address.family)
            }) as any,
        }, resolve)
        request.on('error', reject)
        if (init.body !== undefined) request.write(init.body)
        request.end()
    })
}

export const fetchWithSsrfGuard = async (
    url: string,
    options?: RequestInit,
    guard: SsrfGuardOptions = {},
): Promise<Response> => {
    const maxRedirects = Math.min(guard.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS)
    let method = String(options?.method || 'GET').toUpperCase()
    let body = requestBody(options?.body)
    const headers = new Headers(options?.headers)
    const redirectMode = options?.redirect ?? 'follow'
    let current = url

    for (let hop = 0; ; hop++) {
        const check = await checkUrlResolved(current, guard)
        if (!check.allowed) throw new Error(`[SSRF] Request blocked: ${check.reason}`)
        const target = new URL(current)
        const res = await pinnedRequest(target, check.addresses![0], { method, headers, body, signal: options?.signal ?? undefined })
        const status = res.statusCode || 0
        const location = res.headers.location
        if (!REDIRECT_STATUSES.has(status) || !location || redirectMode === 'manual') return toResponse(res, current)
        res.resume()
        if (redirectMode === 'error') throw new Error(`[SSRF] Redirect not allowed: ${status} → ${location}`)
        if (hop >= maxRedirects) throw new Error(`[SSRF] Too many redirects (max ${maxRedirects})`)
        const next = new URL(location, current)
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
            method = method === 'HEAD' ? 'HEAD' : 'GET'
            body = undefined
            headers.delete('content-type')
            headers.delete('content-length')
        }
        // Never forward credentials to another origin.
        if (next.origin !== target.origin) {
            headers.delete('authorization')
            headers.delete('cookie')
            headers.delete('proxy-authorization')
        }
        current = next.href
    }
}

/**
 * Middleware-style wrapper for multiple URLs (e.g. webhook delivery).
 * Literal check only — deliver through fetchWithSsrfGuard for DNS checks.
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
