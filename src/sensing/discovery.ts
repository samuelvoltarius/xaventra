/**
 * Selbst-Erkennung (`/geraete suchen`): nur lesende Suche im eigenen LAN/Tailnet.
 *
 * - Ziele nur aus ./net-scope.ts (eigene private Subnetze, max /24, Tailnet nur
 *   mit eigenem Tailnet-Interface). Jede Adresse — auch aus mDNS — passiert
 *   `scanTargetAllowed` direkt vor dem Verbindungsaufbau.
 * - Feste 19-Port-Liste: SSH/HTTPS/SMB/RDP, IPP/JetDirect, RTSP/MQTT,
 *   Moonraker 7125, OctoPrint 80/5000, PrusaLink 80,
 *   MQTT 8883 (nur TCP-Connect, kein MQTT-Login oder Bambu-Nachweis), Home Assistant 8123;
 *   2.85: n8n 5678, Paperless-ngx 8000, Immich 2283, Jellyfin 8096,
 *   Nextcloud 80 (/status.php) — still gemeldet, nur unter „Verbindungen“.
 * - Erkennung über öffentliche, unauthentifizierte GET-Pfade; keine Logins,
 *   keine API-Keys, keine Schreibzugriffe.
 * - Rate-Limit (Verbindungen/s), begrenzte Parallelität, harte Gesamtzeit.
 * - Runtime übernimmt Funde in die vorhandene Geräte-Datei. Verifizierte
 *   öffentliche Adapter werden nur lesend überwacht; nötige Zugänge einmal
 *   angefragt. Ein unbekannter offener Port bleibt unbestätigte Beobachtung.
 */

import { Socket } from 'node:net'
import { matterTargetAllowed, matterInterfaceNames, localMatterRoutes } from './matter-scope.js'
import { networkInterfaces } from 'node:os'
import { createSocket } from 'node:dgram'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tailscaleStatusCommand } from '../startup/tailscale-status.js'
import { localNeighbors } from './neighbors.js'
import { isPrivateRange, isTailnet, ownSubnets, scanHosts, scanTargetAllowed, type Cidr, type InterfaceMap } from './net-scope.js'
import { DEVICE_LABEL, type DeviceCandidate, type DeviceType } from './device-registry.js'
import { cleanText } from './ports.js'
import type { SsdpDescription } from './ssdp.js'
import { identifyHardware } from './hardware-recognition.js'

export const DISCOVERY_PORTS = Object.freeze([22, 443, 80, 445, 3389, 631, 9100, 554, 1883, 8080, 8443, 7125, 5000, 8883, 8123, 5678, 8000, 2283, 8096])

export interface HttpProbeResult { status: number; server?: string; body: string }

export interface DiscoveryDeps {
    interfaces?: InterfaceMap
    tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
    httpProbe?: (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<HttpProbeResult | null>
    mdnsBrowse?: (timeoutMs: number) => Promise<Array<{ type: DeviceType; host: string; port: number; name?: string; hints?: Record<string, string> }>>
    ssdpBrowse?: (timeoutMs: number) => Promise<SsdpDescription[]>
    tuyaBrowse?: (timeoutMs: number) => Promise<DeviceCandidate[]>
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    tailnetPeers?: () => Promise<string[]>
    tailnetAliases?: () => Record<string, string>
    neighbors?: () => Promise<string[]>
}

export interface DiscoveryOptions {
    deadlineMs: number
    ratePerSec: number
    concurrency: number
    maxHosts: number
    mdns: boolean
    tailnetHosts: string[]
    probeTimeoutMs?: number
    cursor?: DiscoveryCursor
    signal?: AbortSignal
}

export interface DiscoveryCursor { scopeKey: string; hostOffset: number; portIndex: number }

export interface DiscoveryReport {
    candidates: DeviceCandidate[]
    scannedHosts: number
    probes: number
    rejected: Array<{ host: string; reason: string }>
    truncated: boolean
    timedOut: boolean
    durationMs: number
    scope: { subnets: string[]; hasTailnet: boolean }
    cursor?: DiscoveryCursor
    /** Paket L: tailnet address -> LAN address of the same machine (from Tailscale). */
    aliases?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Real probes (never used in tests)
// ---------------------------------------------------------------------------

export function realTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new Socket()
        let done = false
        const finish = (open: boolean) => { if (done) return; done = true; socket.destroy(); resolve(open) }
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
        socket.connect(port, host)
    })
}

export async function realHttpProbe(url: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpProbeResult | null> {
    try {
        const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json, application/xml, text/html' } })
        const reader = res.body?.getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        if (reader) {
            try {
                while (length < 8192) {
                    const item = await reader.read()
                    if (item.done) break
                    const bytes = item.value.subarray(0, 8192 - length)
                    chunks.push(bytes); length += bytes.length
                }
            } finally { await reader.cancel().catch(() => undefined) }
        }
        const text = Buffer.concat(chunks).toString('utf8')
        return { status: res.status, server: res.headers.get('server') || undefined, body: text }
    } catch { return null }
}

// ---------------------------------------------------------------------------
// Fingerprints (pure)
// ---------------------------------------------------------------------------

export function identifyHttp(port: number, path: string, result: HttpProbeResult | null): DeviceType | null {
    if (!result) return null
    const body = result.body || ''
    if (port === 7125 && path === '/server/info' && result.status === 200 && /"klippy_(state|connected)"|moonraker/i.test(body)) return 'moonraker'
    if (port === 8123 && path === '/manifest.json' && result.status === 200 && /"name"\s*:\s*"Home Assistant"/i.test(body)) return 'homeassistant'
    if ((port === 80 || port === 5000) && path === '/' && /<title>\s*OctoPrint/i.test(body)) return 'octoprint'
    if (port === 80 && path === '/api/version' && (/prusalink/i.test(body) || /prusalink/i.test(result.server || ''))) return 'prusalink'
    // 2.85: self-hosted services, public unauthenticated markers only.
    if (result.status !== 200) return null
    if (port === 5678 && path === '/' && /<title>[^<]*n8n/i.test(body)) return 'n8n'
    if (port === 8000 && path === '/accounts/login/' && /<title>[^<]*Paperless-ngx/i.test(body)) return 'paperless'
    if (port === 2283 && (path === '/api/server/ping' || path === '/api/server-info/ping') && /"res"\s*:\s*"pong"/.test(body)) return 'immich'
    if (port === 8096 && path === '/System/Info/Public' && /"ProductName"\s*:\s*"Jellyfin Server"/.test(body)) return 'jellyfin'
    if (port === 80 && path === '/status.php' && /"productname"\s*:\s*"Nextcloud"/i.test(body)) return 'nextcloud'
    return null
}

/**
 * 2.86.1 (c): Home Assistant's unauthenticated, read-only `/api/discovery_info`
 * names the instance (uuid, location name, version). Two addresses with the same
 * instance are ONE device — without relying on Tailscale reporting LAN endpoints.
 * Only these three bounded fields are kept.
 */
export function parseHaDiscoveryInfo(result: HttpProbeResult | null | undefined): { uuid?: string; location_name?: string; version?: string } {
    if (!result || result.status !== 200 || typeof result.body !== 'string' || result.body.length > 4096) return {}
    try {
        const data = JSON.parse(result.body)
        const out: { uuid?: string; location_name?: string; version?: string } = {}
        if (typeof data?.uuid === 'string' && /^[a-f0-9-]{8,64}$/i.test(data.uuid)) out.uuid = data.uuid.toLowerCase()
        if (typeof data?.version === 'string' && /^\d{4}\.\d{1,2}\.\d{1,3}[a-z0-9.]*$/i.test(data.version)) out.version = data.version
        if (typeof data?.location_name === 'string' && data.location_name.trim() && (out.uuid || out.version)) out.location_name = cleanText(data.location_name, 60)
        return out.uuid || out.version ? out : {}
    } catch { return {} }
}

const HTTP_CHECKS: Record<number, Array<{ path: string }>> = {
    7125: [{ path: '/server/info' }],
    8123: [{ path: '/manifest.json' }],
    5000: [{ path: '/' }],
    80: [{ path: '/' }, { path: '/api/version' }, { path: '/status.php' }],
    5678: [{ path: '/' }],
    8000: [{ path: '/accounts/login/' }],
    2283: [{ path: '/api/server/ping' }, { path: '/api/server-info/ping' }],
    8096: [{ path: '/System/Info/Public' }],
}

// ---------------------------------------------------------------------------
// Rate limiter: at most `ratePerSec` connection starts per second, `concurrency`
// in flight, nothing new after the deadline.
// ---------------------------------------------------------------------------

export class ProbeLimiter {
    private nextSlot = 0
    private inFlight = 0
    private readonly waiters: Array<() => void> = []
    maxInFlight = 0
    started = 0
    constructor(private readonly ratePerSec: number, private readonly concurrency: number, private readonly deadline: number,
        private readonly now: () => number, private readonly sleep: (ms: number) => Promise<void>, private readonly signal?: AbortSignal) {}

    expired(): boolean { return this.signal?.aborted === true || this.now() >= this.deadline }

    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
        if (this.expired()) return undefined
        if (this.inFlight >= this.concurrency) await new Promise<void>(resolve => this.waiters.push(resolve))
        this.inFlight++
        try {
            const spacing = 1000 / this.ratePerSec
            const slot = Math.max(this.now(), this.nextSlot)
            this.nextSlot = slot + spacing
            const wait = slot - this.now()
            if (wait > 0) await this.sleep(wait)
            if (this.expired()) return undefined
            this.started++
            this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
            return await task()
        } finally {
            this.inFlight--
            this.waiters.shift()?.()
        }
    }
}

const cidrText = (cidr: Cidr) => `${[cidr.base >>> 24, (cidr.base >>> 16) & 255, (cidr.base >>> 8) & 255, cidr.base & 255].join('.')}/${cidr.bits}`

/** Read only local Tailscale state; names and keys never enter the inventory. */
export function tailnetPeerAddresses(value: unknown): string[] {
    const peers = (value as { Peer?: unknown })?.Peer
    if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return []
    return [...new Set(Object.values(peers).flatMap((peer: any) => Array.isArray(peer?.TailscaleIPs)
        ? peer.TailscaleIPs.filter((ip: unknown) => typeof ip === 'string' && /^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(ip)) : []))].slice(0, 256).sort() as string[]
}

/**
 * Paket L: Tailscale reports the endpoints of each peer; a private LAN endpoint
 * proves that the tailnet address and that LAN address are the same machine
 * (Home Assistant reached over LAN and over the tailnet = one device).
 */
export function tailnetPeerLanAliases(value: unknown, isLan: (ip: string) => boolean = isPrivateRange, isTail: (ip: string) => boolean = isTailnet): Record<string, string> {
    const peers = (value as { Peer?: unknown })?.Peer
    if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return {}
    const out: Record<string, string> = {}
    for (const peer of Object.values(peers).slice(0, 256) as any[]) {
        const tailnet = (Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs : []).find((ip: unknown) => typeof ip === 'string' && isTail(ip))
        if (!tailnet) continue
        const endpoints = [...(Array.isArray(peer?.Addrs) ? peer.Addrs : []), peer?.CurAddr].filter((item: unknown) => typeof item === 'string')
        const lan = [...new Set(endpoints.map((item: string) => item.replace(/:\d{1,5}$/, '')).filter((ip: string) => isLan(ip)))]
        if (lan.length === 1) out[tailnet] = lan[0] as string
    }
    return out
}

let lastTailnetAliases: Record<string, string> = {}
/** Aliases seen by the last real tailnet status read (no extra process start). */
export function lastSeenTailnetAliases(): Record<string, string> { return { ...lastTailnetAliases } }

async function localTailnetPeers(timeoutMs = 2000): Promise<string[]> {
    try {
        const { locateProgram } = await import('../startup/environment-scanner.js')
        const binary = locateProgram('tailscale', ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'])
        if (!binary) return []
        const command = tailscaleStatusCommand(binary)
        const { stdout } = await promisify(execFile)(command.binary, command.args, { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true })
        const status = JSON.parse(stdout)
        if (status?.BackendState !== 'Running') return []
        lastTailnetAliases = tailnetPeerLanAliases(status)
        return tailnetPeerAddresses(status)
    } catch { return [] }
}

export async function discoverDevices(options: DiscoveryOptions, deps: DiscoveryDeps = {}): Promise<DiscoveryReport> {
    const now = deps.now || Date.now
    const sleep = deps.sleep || ((ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.() }))
    const tcpProbe = deps.tcpProbe || realTcpProbe
    const httpProbe = deps.httpProbe || realHttpProbe
    const startedAt = now()
    const deadline = startedAt + options.deadlineMs
    const probeTimeout = Math.max(100, Math.min(options.probeTimeoutMs ?? 800, options.deadlineMs))
    const scope = ownSubnets(deps.interfaces)
    const matterRoutes = options.mdns ? await localMatterRoutes(deps.interfaces) : []
    const neighbors = await (deps.neighbors || (() => localNeighbors(Math.max(100, Math.min(1500, options.deadlineMs / 8)))))().catch(() => [])
    const peers = scope.hasTailnet ? await (deps.tailnetPeers || (() => localTailnetPeers(Math.max(100, Math.min(2000, options.deadlineMs / 4)))))().catch(() => []) : []
    const tailnetHosts = [...new Set([...options.tailnetHosts, ...peers])].sort()
    const scopeKey = createHash('sha256').update(JSON.stringify({ subnets: scope.subnets, tailnet: scope.hasTailnet, extra: tailnetHosts, ports: DISCOVERY_PORTS })).digest('hex')
    const saved = options.cursor
    const validCursor = saved?.scopeKey === scopeKey && Number.isSafeInteger(saved.hostOffset) && saved.hostOffset >= 0
        && Number.isInteger(saved.portIndex) && saved.portIndex >= 0 && saved.portIndex < DISCOVERY_PORTS.length
    let hostOffset = validCursor ? saved.hostOffset : 0
    // Preserve the stable address plan: changing ARP caches must not reset the cursor.
    let plan = scanHosts(scope, tailnetHosts, options.maxHosts, hostOffset)
    if (hostOffset >= plan.totalHosts) { hostOffset = 0; plan = scanHosts(scope, tailnetHosts, options.maxHosts) }
    const limiter = new ProbeLimiter(options.ratePerSec, options.concurrency, deadline, now, sleep, options.signal)
    const candidates: DeviceCandidate[] = []
    const rejected = [...plan.rejected]
    const seen = new Set<string>()
    const add = (candidate: DeviceCandidate) => {
        const key = `${candidate.type}|${candidate.host}|${candidate.port}`
        if (seen.has(key)) {
            const existing = candidates.find(c => `${c.type}|${c.host}|${c.port}` === key)
            if (existing && candidate.via === 'http') Object.assign(existing, candidate, { name: candidate.name || existing.name })
            return
        }
        seen.add(key)
        candidates.push(candidate)
    }
    for (const host of neighbors.slice(0, 512)) {
        if (scanTargetAllowed(host, scope).allowed) add({ type: 'networkdevice', host, port: 0, via: 'neighbor', evidence: { quelle: 'OS-Nachbartabelle', hinweis: 'Bekannte LAN-Adresse; Cache ist kein Online- oder Steuerungsbeleg' } })
    }

    // mDNS first (cheap, one multicast query); every answer is re-checked.
    if (options.mdns && deps.mdnsBrowse !== undefined) {
        try {
            const found = await deps.mdnsBrowse(Math.min(2000, options.deadlineMs / 4))
            for (const item of found) {
                const matterService = ['_matter._tcp.local', '_matterc._udp.local', '_meshcop._udp.local'].includes(item.hints?.service)
                const decision = matterService && matterTargetAllowed(item.host, deps.interfaces, matterRoutes) ? { allowed: true, reason: 'eigener Matter-IPv4/IPv6-Bereich' } : scanTargetAllowed(item.host, scope)
                if (!decision.allowed) { rejected.push({ host: item.host, reason: `mDNS: ${decision.reason}` }); continue }
                const esphome = item.hints?.service === '_esphomelib._tcp.local' && /^[a-zA-Z0-9_-]{1,63}$/.test(item.name || '') && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535
                const matterId = item.hints?.dnsHost?.replace(/\.local$/i, '') || item.name
                const matter = ['_matter._tcp.local', '_matterc._udp.local'].includes(item.hints?.service) && /^[a-zA-Z0-9_-]{1,80}$/.test(matterId || '') && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535
                add({ type: item.type, host: item.host, port: item.port, via: 'mdns', name: item.name,
                    ...(esphome ? { hardware: { kind: 'unknown' as const, label: 'ESPHome-Endpunkt (Gerätetyp und Zugang noch ungeprüft)', certainty: 'probable' as const, identity: item.name, ecosystem: 'esphome' as const, connector: 'esphome-native' as const, observedAt: new Date(now()).toISOString() } } : matter ? { hardware: { kind: 'unknown' as const, label: 'Matter-Endpunkt (Hersteller, Gerätetyp und Zugang noch ungeprüft)', certainty: 'probable' as const, identity: matterId, ecosystem: 'matter' as const, connector: 'matter-ip' as const, observedAt: new Date(now()).toISOString() } } : {}), evidence: { quelle: 'mDNS', port: item.port,
                    ...Object.fromEntries(Object.entries(item.hints || {}).filter(([key]) => ['service', 'model', 'manufacturer', 'md', 'ty', 'fn', 'vp', 'dt', 'cm', 'd', 'nn', 'mn', 'rv', 'uuid', 'bridgeid', 'modelid', 'location_name', 'version'].includes(key)).slice(0, 16).map(([key, value]) => [key, cleanText(value, 80)])) } })
            }
        } catch { /* mDNS optional */ }
    }

    const progress = new Map<number, number>()
    if (options.mdns && deps.tuyaBrowse && !limiter.expired() && !options.signal?.aborted) {
        const found = await deps.tuyaBrowse(Math.min(3000, Math.max(100, deadline - now()))).catch(() => [])
        for (const device of found.slice(0, 32)) {
            if (!options.signal?.aborted && scanTargetAllowed(device.host, scope).allowed && device.via === 'udp' && device.hardware?.ecosystem === 'tuya') add(device)
        }
    }
    // Alongside mDNS, validate device-description identity on the responder's
    // own address. ProbeLimiter owns the same rate and total deadline.
    if (options.mdns && deps.ssdpBrowse && !limiter.expired() && !options.signal?.aborted) {
        const descriptors = await deps.ssdpBrowse(Math.min(1500, options.deadlineMs / 8)).catch(() => [])
        for (const d of descriptors.slice(0, 8)) {
            if (!scanTargetAllowed(d.host, scope).allowed || !/^\/[a-z0-9_./-]{1,150}\.xml$/i.test(d.path) || d.path.includes('..') || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535) continue
            const result = await limiter.run(() => httpProbe(`http://${d.host}:${d.port}${d.path}`, probeTimeout, options.signal))
            const hardware = identifyHardware(result ?? null, 'upnp-description')
            if (hardware?.identity && d.usn.split('::')[0].toLowerCase() === hardware.identity.toLowerCase()) {
                add({ type: 'networkservice', host: d.host, port: d.port, via: 'http', name: hardware.label, hardware, evidence: { quelle: 'SSDP + öffentliche UPnP-Gerätebeschreibung', geraetekennung: hardware.identity } })
            }
        }
    }
    const probeHost = async (host: string, hostIndex: number): Promise<void> => {
        const firstPort = hostIndex === 0 && validCursor && hostOffset === saved.hostOffset ? saved.portIndex : 0
        progress.set(hostIndex, firstPort)
        for (let portIndex = firstPort; portIndex < DISCOVERY_PORTS.length; portIndex++) {
            const port = DISCOVERY_PORTS[portIndex]
            if (limiter.expired()) return
            // Gate directly before every connect.
            if (!scanTargetAllowed(host, scope).allowed) return
            const open = await limiter.run(() => tcpProbe(host, port, probeTimeout))
            if (open === undefined) return
            if (!open) { progress.set(hostIndex, portIndex + 1); continue }
            if (port === 8883) {
                add({ type: 'networkservice', host, port, via: 'tcp', evidence: { quelle: 'TCP-Connect', port, hinweis: 'TLS/MQTT-Port offen; kein Beleg für einen Bambu-Drucker' } })
                progress.set(hostIndex, portIndex + 1)
                continue
            }
            let identified = false
            let publicHints: Record<string, unknown> = {}
            for (const check of HTTP_CHECKS[port] || []) {
                const result = await limiter.run(() => httpProbe(`http://${host}:${port}${check.path}`, probeTimeout))
                if (result === undefined) return
                const type = identifyHttp(port, check.path, result ?? null)
                if (result?.status === 200 && check.path === '/') {
                    const title = result.body.match(/<title[^>]*>([^<]{1,160})<\/title>/i)?.[1]
                    publicHints = { ...(title ? { pageTitle: cleanText(title, 80) } : {}), ...(result.server ? { server: cleanText(result.server, 80) } : {}) }
                }
                if (type) {
                    // 2.86.1 (c): the instance id of a Home Assistant (read only, no login).
                    const instanz = type === 'homeassistant' && !limiter.expired()
                        ? parseHaDiscoveryInfo(await limiter.run(() => httpProbe(`http://${host}:${port}/api/discovery_info`, probeTimeout)) ?? null) : {}
                    add({ type, host, port, via: 'http', evidence: { quelle: `GET ${check.path}`, port, http: result?.status ?? null, ...instanz } })
                    identified = true
                    break
                }
            }
            if (!identified) add({ type: 'networkservice', host, port, via: 'tcp', evidence: { quelle: 'TCP-Connect', port, ...publicHints, hinweis: 'Erreichbar, keine bestätigte Dienstkennung oder Steuerfreigabe' } })
            progress.set(hostIndex, portIndex + 1)
        }
    }

    let index = 0
    const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, plan.hosts.length)) }, async () => {
        while (index < plan.hosts.length && !limiter.expired()) {
            const hostIndex = index++
            await probeHost(plan.hosts[hostIndex], hostIndex)
        }
    })
    await Promise.all(workers)

    let completedPrefix = 0
    while (progress.get(completedPrefix) === DISCOVERY_PORTS.length) completedPrefix++
    const nextOffset = hostOffset + completedPrefix
    const remaining = nextOffset < plan.totalHosts

    return {
        candidates,
        scannedHosts: Math.min(index, plan.hosts.length),
        probes: limiter.started,
        rejected,
        truncated: remaining,
        timedOut: limiter.expired() && completedPrefix < plan.hosts.length,
        durationMs: now() - startedAt,
        scope: { subnets: scope.subnets.map(cidrText), hasTailnet: scope.hasTailnet },
        cursor: { scopeKey, hostOffset: remaining ? nextOffset : 0, portIndex: remaining ? (progress.get(completedPrefix) ?? 0) : 0 },
        aliases: scope.hasTailnet ? (deps.tailnetAliases || (deps.tailnetPeers ? () => ({}) : lastSeenTailnetAliases))() : {},
    }
}

export function candidateThoughtText(candidate: DeviceCandidate): { title: string; summary: string; proposal: string } {
    const label = DEVICE_LABEL[candidate.type]
    const needsKey = candidate.type === 'octoprint' || candidate.type === 'prusalink' || candidate.type === 'homeassistant'
    const bambu = candidate.type === 'bambu'
    return {
        title: `Gerät gefunden: ${label} (${candidate.host})`,
        summary: `${label} gefunden (${candidate.host}:${candidate.port}, über ${candidate.via === 'mdns' ? 'mDNS' : candidate.via === 'http' ? 'HTTP-Kennung' : 'TCP-Connect'}). Überwachen?`,
        proposal: bambu
            ? 'Nur merken: Bambu braucht den Zugangscode aus dem Gerät (Owner-Schritt), bis dahin keine Überwachung.'
            : needsKey
                ? 'Lesend überwachen? Den API-Schlüssel trägt der Owner selbst in die Config ein.'
                : 'Lesend überwachen (Fortschritt, fertig, Fehler, pausiert)?',
    }
}

// ---------------------------------------------------------------------------
// mDNS (legacy unicast query from an ephemeral port, RFC 6762 §6.7)
// ---------------------------------------------------------------------------

export const MDNS_SERVICES: Readonly<Record<string, DeviceType>> = Object.freeze({
    '_moonraker._tcp.local': 'moonraker',
    '_octoprint._tcp.local': 'octoprint',
    '_home-assistant._tcp.local': 'homeassistant',
    '_ssh._tcp.local': 'networkservice',
    '_smb._tcp.local': 'networkservice',
    '_http._tcp.local': 'networkservice',
    '_https._tcp.local': 'networkservice',
    '_ipp._tcp.local': 'networkservice',
    '_ipps._tcp.local': 'networkservice',
    '_airplay._tcp.local': 'networkservice',
    '_googlecast._tcp.local': 'networkservice',
    '_hue._tcp.local': 'networkservice',
    '_esphomelib._tcp.local': 'networkservice',
    '_hap._tcp.local': 'networkservice',
    '_matter._tcp.local': 'networkservice',
    '_matterc._udp.local': 'networkservice',
    '_meshcop._udp.local': 'networkservice',
})

function encodeName(name: string): Buffer {
    const parts = name.split('.').filter(Boolean).map(label => { const b = Buffer.from(label, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]) })
    return Buffer.concat([...parts, Buffer.from([0])])
}

export function buildMdnsQuery(names: string[], unicast = false): Buffer {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(names.length, 4)
    const questions = names.map(name => Buffer.concat([encodeName(name), Buffer.from([0x00, 0x0c, unicast ? 0x80 : 0x00, 0x01])]))
    return Buffer.concat([header, ...questions])
}

function readName(buf: Buffer, offset: number, depth = 0): { name: string; next: number } {
    const labels: string[] = []
    let pos = offset
    let next = -1
    while (pos < buf.length) {
        const len = buf[pos]
        if (len === 0) { pos++; break }
        if ((len & 0xc0) === 0xc0) {
            if (depth > 8 || pos + 1 >= buf.length) throw new Error('mDNS: Zeigerschleife')
            const pointer = ((len & 0x3f) << 8) | buf[pos + 1]
            if (next < 0) next = pos + 2
            const inner = readName(buf, pointer, depth + 1)
            labels.push(inner.name)
            pos = -1
            break
        }
        if (len > 63 || pos + 1 + len > buf.length) throw new Error('mDNS: ungültiger Name')
        labels.push(buf.toString('utf8', pos + 1, pos + 1 + len))
        pos += 1 + len
    }
    return { name: labels.filter(Boolean).join('.'), next: next >= 0 ? next : pos }
}

export interface MdnsRecord { name: string; type: number; data: { ptr?: string; target?: string; port?: number; a?: string; aaaa?: string; txt?: Record<string, string> } }

export function parseMdnsResponse(buf: Buffer): MdnsRecord[] {
    if (buf.length < 12 || buf.length > 9000) return []
    const qd = buf.readUInt16BE(4)
    const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)
    if (qd > 64 || total > 256) return []
    let pos = 12
    for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4
    const records: MdnsRecord[] = []
    for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
        const { name, next } = readName(buf, pos)
        if (next < 0 || next + 10 > buf.length) break
        const type = buf.readUInt16BE(next)
        const rdlen = buf.readUInt16BE(next + 8)
        const rd = next + 10
        if (rd + rdlen > buf.length) break
        const data: MdnsRecord['data'] = {}
        if (type === 12) data.ptr = readName(buf, rd).name
        else if (type === 33 && rdlen >= 7) { data.port = buf.readUInt16BE(rd + 4); data.target = readName(buf, rd + 6).name }
        else if (type === 1 && rdlen === 4) data.a = [buf[rd], buf[rd + 1], buf[rd + 2], buf[rd + 3]].join('.')
        else if (type === 28 && rdlen === 16) data.aaaa = Array.from({ length: 8 }, (_, i) => buf.readUInt16BE(rd + i * 2).toString(16)).join(':')
        else if (type === 16) {
            data.txt = {}; let at = rd
            while (at < rd + rdlen && Object.keys(data.txt).length < 8) {
                const length = buf[at++]; if (at + length > rd + rdlen) break
                const value = buf.toString('utf8', at, at + length); at += length
                const match = /^(model|manufacturer|md|ty|fn|vp|dt|cm|d|nn|mn|rv|uuid|bridgeid|modelid)=(.*)$/i.exec(value)
                if (match) data.txt[match[1].toLowerCase()] = cleanText(match[2], 80)
            }
        }
        records.push({ name, type, data })
        pos = rd + rdlen
    }
    return records
}

export function mdnsCandidates(records: MdnsRecord[]): Array<{ type: DeviceType; host: string; port: number; name?: string; hints?: Record<string, string> }> {
    const out: Array<{ type: DeviceType; host: string; port: number; name?: string; hints?: Record<string, string> }> = []
    const addr = new Map<string, string[]>()
    for (const r of records) {
        const address = r.type === 1 ? r.data.a : r.type === 28 ? r.data.aaaa : undefined
        if (!address) continue
        const key = r.name.toLowerCase(), values = addr.get(key) || []
        if (!values.includes(address)) values.push(address)
        addr.set(key, values)
    }
    for (const ptr of records.filter(r => r.type === 12 && r.data.ptr)) {
        const type = MDNS_SERVICES[ptr.name.toLowerCase()]
        if (!type) continue
        const srv = records.find(r => r.type === 33 && r.name.toLowerCase() === ptr.data.ptr!.toLowerCase())
        if (!srv?.data.target || !srv.data.port) continue
        const hosts = addr.get(srv.data.target.toLowerCase()) || []
        const txt = records.find(r => r.type === 16 && r.name.toLowerCase() === ptr.data.ptr!.toLowerCase())?.data.txt || {}
        for (const host of hosts) out.push({ type, host, port: srv.data.port, name: ptr.data.ptr!.split('.')[0], hints: { service: ptr.name.toLowerCase(), ...(['_matter._tcp.local', '_matterc._udp.local'].includes(ptr.name.toLowerCase()) ? { dnsHost: cleanText(srv.data.target, 80) } : {}), ...txt } })
    }
    return out
}

export function realMdnsBrowse(timeoutMs: number): Promise<Array<{ type: DeviceType; host: string; port: number; name?: string; hints?: Record<string, string> }>> {
    return new Promise(resolve => {
        const interfaces = networkInterfaces(), names = matterInterfaceNames(interfaces as any)
        const sockets: ReturnType<typeof createSocket>[] = []
        const records: MdnsRecord[] = []
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(timer); for (const socket of sockets) try { socket.close() } catch { /* closed */ } resolve(mdnsCandidates(records)) }
        const timer = setTimeout(finish, timeoutMs)
        timer.unref?.()
        const open = (type: 'udp4' | 'udp6', address: string, zone?: string) => {
            const socket = createSocket({ type, reuseAddr: true }); sockets.push(socket)
            socket.on('message', message => {
                if (done || records.length >= 2048) return
                try {
                    const parsed = parseMdnsResponse(message).slice(0, 2048 - records.length)
                    const scope = zone || (names.length === 1 ? names[0] : undefined)
                    for (const record of parsed) if (record.data.aaaa?.startsWith('fe80:') && scope) record.data.aaaa += '%' + scope
                    records.push(...parsed)
                } catch { /* malformed advertisements never become authority */ }
            })
            socket.on('error', () => { try { socket.close() } catch {} })
            socket.bind(0, () => { if (done) return; socket.send(buildMdnsQuery(Object.keys(MDNS_SERVICES), true), 5353, address, () => {}) })
        }
        open('udp4', '224.0.0.251')
        for (const name of names.slice(0, 8)) {
            const entry = interfaces[name]?.find(entry => !entry.internal && entry.family === 'IPv6')
            if (!entry) continue
            const zone = process.platform === 'win32' ? String(entry.scopeid) : name
            if (zone && zone !== 'undefined') open('udp6', 'ff02::fb%' + zone, zone)
        }
    })
}
