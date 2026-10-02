/**
 * Wächter — selbst abgeleitete Ziele (2.85). Der Owner trägt nichts ein: aus
 * dem, was die vorhandenen Module schon wissen, entsteht nach festen Regeln
 * eine Zielliste. Nur lesende Proben über die vorhandenen Arten (tcp, ping),
 * keine neuen Ports, keine Zugangsdaten, keine Bereiche.
 *
 * Quellen und Regeln (deterministisch, sortiert, höchstens MAX_DERIVED_TARGETS):
 *   - Mesh-Knoten: konfigurierter Peer mit URL → tcp auf genau diesen
 *     Mesh-Port (der Weg, den das Mesh selbst nutzt); sonst eine Registry-IP
 *     aus Tailnet/LAN (100.64/10, 10/8, 192.168/16) → ping. Docker-/Link-local-/
 *     Loopback-Adressen, der eigene Knoten und stillgelegte/gelöschte Knoten
 *     nie. Nur ein Name ohne Adresse: nichts (kein Raten).
 *   - Proxmox (infra.proxmox, eingeschaltet): tcp host:port und das
 *     TLS-Zertifikat (nur das Ablaufdatum, ohne Token).
 *   - Geräte aus der Selbst-Erkennung (devices.json): `gefunden` und
 *     `eingerichtet` → tcp host:port; `abgelehnt`/`aus` (Owner) nie.
 *   - KI-Dienste aus dem letzten KI-Scan: nur `running`; Loopback nur, wenn der
 *     Dienst auf diesem Knoten läuft (ein fremdes `localhost` ist von hier aus
 *     nicht prüfbar — das meldet der Knoten selbst über seine Dienste).
 *   - TLS: Proxmox und Mesh-Peers mit https/wss-URL.
 * Owner-Ziele haben Vorrang (gleicher Host und Port → kein zweites Ziel), vom
 * Owner entfernte abgeleitete Ziele (`targets.json` removedDerived) kommen nie
 * wieder. Passwortmanager werden wie überall nie übernommen.
 */
import { resolveNodeLifecycle } from '../mesh/mesh-node-lifecycle.js'
import { parseProxmoxConfig } from '../infra/proxmox.js'
import { MAX_TARGETS, normalizeWatchTarget, PASSWORD_MANAGER_PATTERN, isValidWatchHost, type WatchTarget, type WatchTlsHost } from './settings.js'

export const MAX_DERIVED_TARGETS = 24
export const MAX_DERIVED_TLS = 8

export interface DerivedMeshNode {
    nodeId: string
    /** Configured peer URL (mesh.direct.peers[].url). */
    url?: string
    /** Address from the mesh registry (mesh.json). */
    ip?: string
    /** Registry lifecycle: retired/tombstoned nodes are never watched. */
    lifecycle?: string
}

export interface DerivedDevice { type: string; name: string; host: string; port: number; status: string }

export interface DerivedAiService {
    name: string
    host: string
    port: number
    status: string
    /** Node that runs the service; empty = this node. */
    nodeId?: string
}

export interface DerivedSources {
    localNodeId: string
    meshNodes: readonly DerivedMeshNode[]
    devices: readonly DerivedDevice[]
    aiServices: readonly DerivedAiService[]
    proxmoxUrl?: string | null
}

export interface DerivedOptions {
    /** Ids the owner removed: never derived again. */
    removed?: readonly string[]
    /** autonomy.watch.includeDevices=false also keeps found devices out. */
    includeDevices?: boolean
}

export interface DerivedResult { targets: WatchTarget[]; tls: WatchTlsHost[] }

export const EMPTY_DERIVED: DerivedResult = Object.freeze({ targets: [], tls: [] }) as unknown as DerivedResult

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i

/** Tailnet (100.64/10), 10/8 and 192.168/16 only; docker (172.16/12), link-local and loopback never. */
export function isWatchableNodeAddress(ip: unknown): ip is string {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? ''))
    if (!match) return false
    const [a, b, c, d] = match.slice(1).map(Number)
    if ([a, b, c, d].some(part => part > 255)) return false
    if (a === 100) return b >= 64 && b <= 127
    if (a === 10) return true
    return a === 192 && b === 168
}

function urlParts(raw: unknown): { host: string; port: number; secure: boolean } | null {
    let url: URL
    try { url = new URL(String(raw ?? '')) } catch { return null }
    if (url.username || url.password) return null
    const secure = url.protocol === 'https:' || url.protocol === 'wss:'
    if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') return null
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = url.port ? Number(url.port) : secure ? 443 : 80
    return isValidWatchHost(host) ? { host, port, secure } : null
}

const sameEndpoint = (a: Pick<WatchTarget, 'host' | 'port' | 'kind'>, b: Pick<WatchTarget, 'host' | 'port' | 'kind'>) =>
    a.host.toLowerCase() === b.host.toLowerCase() && (a.kind === 'ping' || b.kind === 'ping' || a.port === b.port)

/** Id of a derived TLS check (for removal by the owner). */
export const derivedTlsId = (host: string, port: number) => `tls:${host}:${port}`.toLowerCase()

/** Fixed rules, no I/O: the same sources always give the same list. */
export function deriveWatchTargets(sources: DerivedSources, options: DerivedOptions = {}): DerivedResult {
    const removed = new Set((options.removed ?? []).map(id => String(id).toLowerCase()))
    const targets: WatchTarget[] = []
    const tls: WatchTlsHost[] = []
    const push = (raw: { name: string; host: string; kind: 'tcp' | 'ping'; port?: number }) => {
        const target = normalizeWatchTarget(raw, 'selbst')
        if (typeof target === 'string') return
        if (removed.has(target.id) || targets.some(existing => existing.id === target.id || sameEndpoint(existing, target))) return
        targets.push(target)
    }
    const pushTls = (name: string, host: string, port: number) => {
        if (PASSWORD_MANAGER_PATTERN.test(`${name} ${host}`) || !isValidWatchHost(host)) return
        if (removed.has(derivedTlsId(host, port)) || tls.some(item => item.host === host && item.port === port)) return
        tls.push({ name, host, port })
    }

    const local = String(sources.localNodeId || '')
    for (const node of [...sources.meshNodes].sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)))) {
        const nodeId = String(node.nodeId || '').trim()
        if (!nodeId || nodeId === local) continue
        if (node.lifecycle === 'retired' || node.lifecycle === 'tombstoned') continue
        const name = `Knoten ${nodeId}`.slice(0, 60)
        const peer = urlParts(node.url)
        if (peer) {
            push({ name, host: peer.host, kind: 'tcp', port: peer.port })
            if (peer.secure) pushTls(name, peer.host, peer.port)
        } else if (isWatchableNodeAddress(node.ip)) {
            push({ name, host: node.ip, kind: 'ping' })
        }
    }

    const pve = sources.proxmoxUrl ? urlParts(sources.proxmoxUrl) : null
    if (pve) {
        push({ name: 'Proxmox', host: pve.host, kind: 'tcp', port: pve.port })
        if (pve.secure) pushTls('Proxmox', pve.host, pve.port)
    }

    if (options.includeDevices !== false) {
        const devices = [...sources.devices].sort((a, b) => `${a.type}|${a.host}|${a.port}`.localeCompare(`${b.type}|${b.host}|${b.port}`))
        for (const device of devices) {
            if (device.status !== 'gefunden' && device.status !== 'eingerichtet') continue
            if (!Number.isInteger(device.port)) continue
            push({ name: String(device.name || device.host).slice(0, 60), host: device.host, kind: 'tcp', port: device.port })
        }
    }

    for (const service of [...sources.aiServices].sort((a, b) => `${a.host}|${a.port}|${a.name}`.localeCompare(`${b.host}|${b.port}|${b.name}`))) {
        if (service.status !== 'running' || !Number.isInteger(service.port)) continue
        const foreign = Boolean(service.nodeId) && service.nodeId !== local
        const loopback = LOOPBACK.test(String(service.host))
        if (foreign && loopback) continue
        push({ name: `KI-Dienst ${service.name}${foreign ? ` auf ${service.nodeId}` : ''}`.slice(0, 60), host: loopback ? '127.0.0.1' : service.host, kind: 'tcp', port: service.port })
    }

    return { targets: targets.slice(0, Math.min(MAX_DERIVED_TARGETS, MAX_TARGETS)), tls: tls.slice(0, MAX_DERIVED_TLS) }
}

/**
 * Owner-Ziele zuerst: ein abgeleitetes Ziel auf demselben Host und Port wie
 * ein vorhandenes (Config, /monitor, eingerichtetes Gerät) entfällt.
 */
export function withoutOwnerDuplicates(derived: readonly WatchTarget[], existing: readonly WatchTarget[]): WatchTarget[] {
    return derived.filter(target => !existing.some(owner => owner.id === target.id || sameEndpoint(owner, target)))
}

/**
 * The raw module data → sources (pure). `config` is the parsed main config
 * (mesh.direct.peers, infra.proxmox), `registryNodes` the mesh registry
 * (mesh.json), `scanServices` the last AI scan (ai-scanner getLastScanResult).
 */
export function derivedSourcesFrom(input: {
    localNodeId: string
    config?: any
    registryNodes?: ReadonlyArray<{ node_id?: string; ip?: string; last_heartbeat?: string; lifecycle_state?: string }>
    devices?: readonly DerivedDevice[]
    scanServices?: ReadonlyArray<{ name?: string; host?: string; port?: number; status?: string; sourceNode?: string; metadata?: Record<string, unknown> }>
    now?: number
}): DerivedSources {
    const now = input.now ?? Date.now()
    const byId = new Map<string, DerivedMeshNode>()
    const peers = Array.isArray(input.config?.mesh?.direct?.peers) ? input.config.mesh.direct.peers : []
    for (const peer of peers.slice(0, 32)) {
        const nodeId = String(peer?.nodeId || peer?.name || '').trim().slice(0, 80)
        if (nodeId) byId.set(nodeId, { nodeId, ...(peer?.url ? { url: String(peer.url) } : {}) })
    }
    for (const node of (input.registryNodes ?? []).slice(0, 64)) {
        const nodeId = String(node?.node_id || '').trim().slice(0, 80)
        if (!nodeId) continue
        const lifecycle = resolveNodeLifecycle({ lastHeartbeat: node.last_heartbeat, lifecycleState: node.lifecycle_state }, now)
        const known = byId.get(nodeId)
        byId.set(nodeId, { ...known, nodeId, ...(node.ip ? { ip: String(node.ip) } : {}), lifecycle })
    }
    const pveRaw = input.config?.infra?.proxmox
    const pve = pveRaw ? parseProxmoxConfig(pveRaw) : null
    return {
        localNodeId: input.localNodeId,
        meshNodes: [...byId.values()],
        devices: (input.devices ?? []).slice(0, 200),
        aiServices: (input.scanServices ?? []).slice(0, 200).map(service => ({
            name: String(service?.name || '?').slice(0, 40),
            host: String(service?.host || ''),
            port: Number(service?.port),
            status: String(service?.status || ''),
            // The scanner marks own services with sourceNode 'local'.
            nodeId: String(service?.metadata?.nodeId || (service?.sourceNode === 'local' ? '' : service?.sourceNode) || '') || undefined,
        })),
        proxmoxUrl: pve?.enabled ? pve.url : null,
    }
}
