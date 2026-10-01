/**
 * Knotenprofil (Stufe 1, S1.1/S1.2, 30.09.2026).
 *
 * Every node computes its own profile locally and read-only: hardware, role,
 * native vs. container, read-only root, how the GPU is actually used, how
 * something could be installed here at all, and a small self-check. Workers
 * publish it inside their signed `node.capabilities` envelope, so the Main
 * sees all four nodes without SSH (the Spark service account has no SSH key
 * by design) and without the Main lease that the autonomy loop requires.
 *
 * Nothing here installs, repairs, restarts or reads secrets.
 */
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { arch, cpus, freemem, hostname, loadavg, networkInterfaces, platform, totalmem } from 'node:os'
import { parse as parsePath } from 'node:path'
import { diskLevel, memoryLevel } from './resource-thresholds.js'

export type NodeRuntimeKind = 'native' | 'container' | 'unknown'
export type NodeInstallPath = 'package-manager' | 'host-agent' | 'image' | 'none'
export type SelfCheckStatus = 'ok' | 'warn' | 'crit'
export type VirtualizationKind = 'kvm' | 'container' | 'none' | 'unknown'

/** Where this node runs. `platform: 'proxmox'` only when the configured Proxmox host found this very guest (MAC match). */
export interface VirtualizationInfo {
    kind: VirtualizationKind
    platform?: 'proxmox'
    vmid?: number
    pveNode?: string
    /** Pool guest tagged xaventra-created/xaventra-lab: Xaventra may be root there (never on Spark/ns1/ns2/NAS). */
    ownMachine?: boolean
}

export interface SelfCheckItem { id: string; label: string; status: SelfCheckStatus; detail: string }
export const NODE_SERVICE_TYPES = ['llm', 'vlm', 'tts', 'stt', 'embeddings', 'image'] as const
export interface NodeService { name: string; type: typeof NODE_SERVICE_TYPES[number]; status: 'running' | 'installed' | 'stopped' }

export interface NodeProfile {
    schema: 1
    nodeId: string
    hostname: string
    platform: string
    arch: string
    version: string
    role: 'main' | 'worker'
    runtime: NodeRuntimeKind
    rootReadOnly: boolean | null
    noNewPrivileges: boolean | null
    cpus: number
    ramGB: number
    gpu: { name: string | null; backend: string; viaVllm: boolean }
    /** Local AI services from the AI scanner (Phase 5b). Optional: older peers do not send it. */
    services?: NodeService[]

    /** Phase 6c; older peers send no field (read as kind 'unknown'). */
    virtualization?: VirtualizationInfo
    installPath: NodeInstallPath
    tools: string[]
    selfCheck: { status: SelfCheckStatus; checkedAt: string; items: SelfCheckItem[] }
    collectedAt: string
}

// ---------------------------------------------------------------------------
// Pure detection helpers (tested with fixtures)
// ---------------------------------------------------------------------------

export function detectRuntimeKind(input: { platform: string; dockerenv: boolean; cgroup: string; systemdInvocation: boolean }): NodeRuntimeKind {
    if (input.platform !== 'linux') return 'native'
    if (input.dockerenv || /\b(docker|containerd|kubepods|libpod)\b/.test(input.cgroup)) return 'container'
    return input.systemdInvocation ? 'native' : 'unknown'
}

/**
 * Phase 6c "Wo laufe ich?" — from /sys/class/dmi/id, /sys/hypervisor and the
 * cpuinfo `hypervisor` flag only (no child process). Another hypervisor or
 * nothing readable is 'unknown', never a guess.
 */
export function detectVirtualization(input: { platform: string; runtime: NodeRuntimeKind; sysVendor: string; productName: string; hypervisorType: string; cpuinfo: string; containerHint: string }): VirtualizationKind {
    if (input.platform !== 'linux') return 'unknown'
    if (input.runtime === 'container' || /\b(lxc|docker|podman|systemd-nspawn|container)/i.test(input.containerHint.trim())) return 'container'
    const vendor = input.sysVendor.trim()
    const product = input.productName.trim()
    if (/^QEMU$/i.test(vendor) || /\b(KVM|QEMU)\b/i.test(product)) return 'kvm'
    const hypervisorFlag = /^flags\s*:.*\bhypervisor\b/m.test(input.cpuinfo)
    if (hypervisorFlag || input.hypervisorType.trim()) return 'unknown'
    if (!input.cpuinfo.trim() && !vendor) return 'unknown'
    return 'none'
}

/**
 * root / passwordless sudo is meant ONLY for own Proxmox guests (pool +
 * tag xaventra-created/xaventra-lab). Spark, ns1, ns2 and the NAS are not
 * such guests and keep their hardening; nothing here relaxes them.
 */
export function privilegedOnOwnMachine(profile: Pick<NodeProfile, 'virtualization'> | null | undefined): boolean {
    const virt = profile?.virtualization
    return virt?.platform === 'proxmox' && Number.isInteger(virt.vmid) && virt.ownMachine === true && (virt.kind === 'kvm' || virt.kind === 'container')
}

/** Per-mount options of "/" from /proc/self/mountinfo. */
export function rootIsReadOnly(mountinfo: string): boolean | null {
    for (const line of mountinfo.split('\n')) {
        const fields = line.split(' ')
        if (fields[4] === '/') return fields[5]?.split(',').includes('ro') ?? null
    }
    return null
}

export function noNewPrivilegesFrom(status: string): boolean | null {
    const match = /^NoNewPrivs:\s*(\d)/m.exec(status)
    return match ? match[1] === '1' : null
}

/** How Stufe 2 could install something on this node — never done here. */
export function installPathFor(input: { runtime: NodeRuntimeKind; rootReadOnly: boolean | null; noNewPrivileges: boolean | null; hasApt: boolean; isRoot: boolean }): NodeInstallPath {
    if (input.runtime === 'container') return 'image'
    if (input.rootReadOnly || input.noNewPrivileges) return 'host-agent'
    if (input.hasApt && input.isRoot) return 'package-manager'
    return 'none'
}

export function isLoopbackOrLocal(endpoint: string, localAddresses: readonly string[]): boolean {
    try {
        const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
        return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host) || localAddresses.includes(host)
    } catch { return false }
}

export function usageStatus(usedPercent: number, warn: number, crit: number): SelfCheckStatus {
    return usedPercent >= crit ? 'crit' : usedPercent >= warn ? 'warn' : 'ok'
}

export function worstStatus(items: readonly { status: SelfCheckStatus }[]): SelfCheckStatus {
    return items.some(item => item.status === 'crit') ? 'crit' : items.some(item => item.status === 'warn') ? 'warn' : 'ok'
}

function diskItem(id: string, label: string, path: string): SelfCheckItem {
    try {
        const stats = statfsSync(path)
        const total = Number(stats.blocks) * Number(stats.bsize)
        const free = Number(stats.bavail) * Number(stats.bsize)
        if (!total) return { id, label, status: 'warn', detail: 'Größe nicht lesbar' }
        const used = Math.round((1 - free / total) * 100)
        // The one threshold definition (core/resource-thresholds.ts), same as L0/L21.
        return { id, label, status: diskLevel(used, free / 1024 ** 3), detail: `${used} % belegt, ${Math.round(free / 1024 ** 3)} GB frei` }
    } catch (error) {
        return { id, label, status: 'warn', detail: `nicht prüfbar: ${String((error as Error)?.message || error).slice(0, 80)}` }
    }
}

/** Local, read-only self-check. No network, no child process. */
export function runLocalSelfCheck(dataDir: string, now = new Date()): NodeProfile['selfCheck'] {
    const root = platform() === 'win32' ? parsePath(process.cwd()).root : '/'
    const items: SelfCheckItem[] = [diskItem('disk-root', 'Systemplatte', root)]
    if (existsSync(dataDir)) {
        const data = diskItem('disk-data', 'Datenplatte', dataDir)
        if (data.detail !== items[0].detail) items.push(data)
    }
    const memoryFree = Math.round(freemem() / Math.max(1, totalmem()) * 100)
    items.push({ id: 'memory', label: 'Arbeitsspeicher', status: memoryLevel(100 - memoryFree), detail: `${memoryFree} % frei` })
    const cores = Math.max(1, cpus().length)
    const load = platform() === 'win32' ? null : loadavg()[0] / cores
    if (load !== null) items.push({ id: 'load', label: 'Last', status: load > 4 ? 'crit' : load > 2 ? 'warn' : 'ok', detail: `${load.toFixed(2)} je Kern` })
    return { status: worstStatus(items), checkedAt: now.toISOString(), items }
}

// ---------------------------------------------------------------------------
// Collection (cached; called by the 30 s mesh data plane)
// ---------------------------------------------------------------------------

function readText(path: string): string { try { return readFileSync(path, 'utf8') } catch { return '' } }

function localAddresses(): string[] {
    return Object.values(networkInterfaces()).flatMap(list => (list || []).map(entry => entry.address))
}

function packageVersion(): string {
    try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
}

let cached: { at: number; profile: NodeProfile } | null = null
const PROFILE_TTL_MS = 10 * 60_000

export async function collectNodeProfile(options: { force?: boolean; now?: Date } = {}): Promise<NodeProfile> {
    const now = options.now || new Date()
    if (!options.force && cached && now.getTime() - cached.at < PROFILE_TTL_MS) {
        // Hardware and runtime change rarely; the self-check stays fresh.
        const { getNovaDataDir } = await import('./data-root.js')
        return { ...cached.profile, selfCheck: runLocalSelfCheck(getNovaDataDir(), now), collectedAt: now.toISOString() }
    }
    const { getNovaDataDir } = await import('./data-root.js')
    const os = platform()
    const runtime = detectRuntimeKind({
        platform: os, dockerenv: existsSync('/.dockerenv'), cgroup: readText('/proc/1/cgroup'),
        systemdInvocation: Boolean(process.env.INVOCATION_ID),
    })
    const rootReadOnly = os === 'linux' ? rootIsReadOnly(readText('/proc/self/mountinfo')) : null
    const virtualization: VirtualizationInfo = {
        kind: detectVirtualization({
            platform: os, runtime, sysVendor: readText('/sys/class/dmi/id/sys_vendor'), productName: readText('/sys/class/dmi/id/product_name'),
            hypervisorType: readText('/sys/hypervisor/type'), cpuinfo: os === 'linux' ? readText('/proc/cpuinfo').slice(0, 64 * 1024) : '',
            containerHint: readText('/run/systemd/container'),
        }),
    }
    if (virtualization.kind === 'kvm' || virtualization.kind === 'container') {
        try {
            // Read only, bounded; null when infra.proxmox is off or the guest is not found.
            const { locateSelfOnProxmox, localMacAddresses } = await import('../infra/proxmox.js')
            const found = await locateSelfOnProxmox(localMacAddresses(networkInterfaces() as any))
            if (found) Object.assign(virtualization, { platform: 'proxmox', vmid: found.vmid, pveNode: found.node, ownMachine: found.ownMachine })
        } catch { /* Proxmox optional */ }
    }
    const noNewPrivileges = os === 'linux' ? noNewPrivilegesFrom(readText('/proc/self/status')) : null

    let gpuName: string | null = null, backend = 'cpu'
    try {
        const { probeGpuRuntime } = await import('../doctor/gpu-runtime.js')
        const gpu = await probeGpuRuntime()
        gpuName = gpu.name; backend = gpu.activeBackend
    } catch { /* GPU probe optional */ }

    let viaVllm = false
    let services: NodeService[] = []
    try {
        const { getLocalNodeSnapshot } = await import('../mesh/mesh-registry.js')
        const addresses = localAddresses()
        const advertised = getLocalNodeSnapshot()?.software?.ai_services || []
        viaVllm = advertised
            .some(service => service.type === 'vllm' && service.status === 'running' && isLoopbackOrLocal(service.endpoint, addresses))
        // Running services only when they answer on this node; installed/stopped ones are local binaries.
        services = sanitizeNodeServices(advertised.filter(service => service.status !== 'running' || isLoopbackOrLocal(service.endpoint, addresses)))
    } catch { /* registry optional */ }

    let tools: string[] = []
    try {
        const { scanEnvironment } = await import('../startup/environment-scanner.js')
        const env = await scanEnvironment()
        tools = Object.entries(env).filter(([, value]) => typeof value === 'string' && value).map(([name]) => name).sort()
    } catch { /* env scan optional */ }

    const profile: NodeProfile = {
        schema: 1,
        nodeId: process.env.NOVA_NODE_ID || hostname(),
        hostname: hostname(),
        platform: os,
        arch: arch(),
        version: packageVersion(),
        role: process.env.NOVA_NODE_ONLY === 'true' ? 'worker' : 'main',
        runtime,
        rootReadOnly,
        noNewPrivileges,
        cpus: cpus().length,
        ramGB: Math.round(totalmem() / 1024 ** 3),
        gpu: { name: gpuName, backend, viaVllm },
        services,
        virtualization,
        installPath: installPathFor({ runtime, rootReadOnly, noNewPrivileges, hasApt: tools.includes('apt'), isRoot: process.getuid?.() === 0 }),
        tools,
        selfCheck: runLocalSelfCheck(getNovaDataDir(), now),
        collectedAt: now.toISOString(),
    }
    cached = { at: now.getTime(), profile }
    return profile
}

// ---------------------------------------------------------------------------
// When to publish (Alfred 30.09.2026: "beim Start und wenn sich was ändert")
// ---------------------------------------------------------------------------

/** What counts as a change: static facts and each check's status. Free GB,
 * load and timestamps drift constantly and would resend every 30 s. */
export function profileFingerprint(profile: NodeProfile): string {
    const { collectedAt: _collected, selfCheck, ...facts } = profile
    return JSON.stringify([facts, selfCheck.status, selfCheck.items.map(item => [item.id, item.status])])
}

/** Liveness comes from the 30 s heartbeat. The profile goes out on start, on
 * change, and as a safety copy every 6 h (broadcasts are not acknowledged, a
 * Main that was offline would otherwise never learn the current state). */
export const PROFILE_SAFETY_RESEND_MS = 6 * 60 * 60_000
export function shouldPublishProfile(fingerprint: string, last: { fingerprint: string; sentAt: number } | null, now: number): boolean {
    return !last || last.fingerprint !== fingerprint || now - last.sentAt >= PROFILE_SAFETY_RESEND_MS
}

// Hotfix 2.80.1 (live 01.10.2026): a Main restarted after its workers held no
// profile for up to 6 h. Every heartbeat now carries the sender's boot id and
// the peers whose profile it holds; a node that sees a new boot id, or is not
// in that list, sends its profile once more. Bounded, never every 30 s.
export const PROFILE_PEER_RESEND_MIN_MS = 5 * 60_000
const MAX_PROFILES_HELD = 64

export function heartbeatProfileFields(bootId: string, peers: Record<string, { profile?: unknown } | undefined>): { bootId: string; profilesHeld: string[] } {
    const profilesHeld = Object.entries(peers)
        .filter(([nodeId, state]) => nodeId && state?.profile)
        .map(([nodeId]) => nodeId.slice(0, 80))
        .slice(0, MAX_PROFILES_HELD)
    return { bootId, profilesHeld }
}

/** Peers older than 2.80.1 send neither field and never trigger a resend. */
export function peerWantsProfile(localNodeId: string, previousBootId: string | undefined, heartbeat: unknown): boolean {
    const value = (heartbeat && typeof heartbeat === 'object' ? heartbeat : {}) as { bootId?: unknown; profilesHeld?: unknown }
    const bootId = typeof value.bootId === 'string' ? value.bootId.slice(0, 80) : undefined
    if (bootId && previousBootId && bootId !== previousBootId) return true
    if (Array.isArray(value.profilesHeld)) return !value.profilesHeld.slice(0, MAX_PROFILES_HELD).includes(localNodeId)
    return false
}

export interface ProfilePublishState {
    last: { fingerprint: string; sentAt: number } | null
    /** Set by a peer heartbeat that showed a restart or a missing profile. */
    resendWanted: boolean
    lastForcedAt: number | null
}

export function decideProfilePublish(state: ProfilePublishState, fingerprint: string, now: number): { publish: boolean; next: ProfilePublishState } {
    if (shouldPublishProfile(fingerprint, state.last, now)) {
        return { publish: true, next: { last: { fingerprint, sentAt: now }, resendWanted: false, lastForcedAt: state.lastForcedAt } }
    }
    if (state.resendWanted && (state.lastForcedAt === null || now - state.lastForcedAt >= PROFILE_PEER_RESEND_MIN_MS)) {
        return { publish: true, next: { last: { fingerprint, sentAt: now }, resendWanted: false, lastForcedAt: now } }
    }
    return { publish: false, next: { ...state, resendWanted: false } }
}

// ---------------------------------------------------------------------------
// Receiving side: a peer's profile is signed mesh data, still bounded here
// ---------------------------------------------------------------------------

const str = (value: unknown, max = 120): string => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max)
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback
const boolOrNull = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null
const num = (value: unknown): number => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1e6, Number(value))) : 0

export function sanitizeNodeServices(raw: unknown): NodeService[] {
    if (!Array.isArray(raw)) return []
    const out = raw.slice(0, 20).flatMap((item: any): NodeService[] => {
        const type = item?.type === 'vllm' ? 'llm' : item?.type
        if (!NODE_SERVICE_TYPES.includes(type)) return []
        return [{ name: str(item?.name, 40), type, status: oneOf(item?.status, ['running', 'installed', 'stopped'] as const, 'stopped') }]
    })
    return [...new Map(out.map(item => [`${item.name}|${item.type}|${item.status}`, item])).values()]
        .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.status.localeCompare(b.status))
}

function sanitizeVirtualization(raw: any): VirtualizationInfo {
    const kind = oneOf(raw?.kind, ['kvm', 'container', 'none', 'unknown'] as const, 'unknown')
    if (raw?.platform !== 'proxmox') return { kind }
    const vmid = Number(raw.vmid)
    const pveNode = String(raw.pveNode ?? '')
    if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999 || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(pveNode)) return { kind }
    return { kind, platform: 'proxmox', vmid, pveNode, ownMachine: raw.ownMachine === true }
}

export function sanitizeNodeProfile(raw: unknown): NodeProfile | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, any>
    if (value.schema !== 1) return null
    const statuses = ['ok', 'warn', 'crit'] as const
    return {
        schema: 1,
        nodeId: str(value.nodeId, 80), hostname: str(value.hostname, 80), platform: str(value.platform, 20), arch: str(value.arch, 20),
        version: str(value.version, 30),
        role: oneOf(value.role, ['main', 'worker'] as const, 'worker'),
        runtime: oneOf(value.runtime, ['native', 'container', 'unknown'] as const, 'unknown'),
        rootReadOnly: boolOrNull(value.rootReadOnly), noNewPrivileges: boolOrNull(value.noNewPrivileges),
        cpus: num(value.cpus), ramGB: num(value.ramGB),
        gpu: { name: value.gpu?.name == null ? null : str(value.gpu.name, 120), backend: str(value.gpu?.backend, 20), viaVllm: value.gpu?.viaVllm === true },
        ...(Array.isArray(value.services) ? { services: sanitizeNodeServices(value.services) } : {}),
        virtualization: sanitizeVirtualization(value.virtualization),
        installPath: oneOf(value.installPath, ['package-manager', 'host-agent', 'image', 'none'] as const, 'none'),
        tools: Array.isArray(value.tools) ? value.tools.slice(0, 60).map((tool: unknown) => str(tool, 40)) : [],
        selfCheck: {
            status: oneOf(value.selfCheck?.status, statuses, 'warn'),
            checkedAt: str(value.selfCheck?.checkedAt, 40),
            items: Array.isArray(value.selfCheck?.items) ? value.selfCheck.items.slice(0, 12).map((item: any) => ({
                id: str(item?.id, 40), label: str(item?.label, 60), status: oneOf(item?.status, statuses, 'warn'), detail: str(item?.detail, 160),
            })) : [],
        },
        collectedAt: str(value.collectedAt, 40),
    }
}

// ---------------------------------------------------------------------------
// Overview (S1.4): suggestions come from fixed rules, never from web research
// ---------------------------------------------------------------------------

export function suggestionsFor(profile: NodeProfile): string[] {
    const out: string[] = []
    for (const item of profile.selfCheck.items) if (item.status !== 'ok') out.push(`${item.label}: ${item.detail}`)
    if (profile.gpu.backend === 'cpu' && profile.gpu.viaVllm) out.push('GPU wird über vLLM genutzt; lokale GGUF-Modelle liefen hier auf der CPU.')
    else if (profile.gpu.name && profile.gpu.backend === 'cpu') out.push(`GPU ${profile.gpu.name} erkannt, aber ungenutzt (lokal nur CPU).`)
    if (profile.installPath === 'image') out.push('Container: Pakete nur über ein neues Image beim nächsten Tausch.')
    else if (profile.installPath === 'host-agent') out.push('Gehärteter Dienst: Installation nur über den Host-Agenten (Stufe 2).')
    return out
}

const STATUS_ICON: Record<SelfCheckStatus, string> = { ok: '✅', warn: '⚠️', crit: '❌' }
const RUNTIME_LABEL: Record<NodeRuntimeKind, string> = { native: 'nativ', container: 'Container', unknown: 'unbekannt' }

export function formatNodeOverview(entries: Array<{ profile: NodeProfile | null; nodeId: string; lastSeen?: number; local?: boolean }>, now = Date.now()): string {
    const lines = ['*Knoten-Übersicht* (nur lesend, keine Änderung)']
    for (const entry of entries) {
        const profile = entry.profile
        const age = entry.local ? 'lokal' : entry.lastSeen ? `vor ${Math.max(0, Math.round((now - entry.lastSeen) / 60_000))} min` : 'nie gemeldet'
        const stale = !entry.local && (!entry.lastSeen || now - entry.lastSeen > 5 * 60_000)
        if (!profile) {
            lines.push('', `${stale ? '❔' : '•'} *${entry.nodeId}* — kein Profil (${age}; ältere Version oder offline)`)
            continue
        }
        const gpu = profile.gpu.name ? `${profile.gpu.name} (${profile.gpu.viaVllm ? 'via vLLM' : profile.gpu.backend})` : 'keine GPU'
        lines.push('',
            `${stale ? '❔' : STATUS_ICON[profile.selfCheck.status]} *${profile.nodeId}* — ${profile.role === 'main' ? 'Main' : 'Worker'}, ${RUNTIME_LABEL[profile.runtime]}${profile.rootReadOnly ? ', System schreibgeschützt' : ''}, v${profile.version} (${age}${stale ? ', veraltet' : ''})`,
            `  ${profile.cpus} Kerne, ${profile.ramGB} GB RAM, ${gpu}`)
        const virt = profile.virtualization
        if (virt?.platform === 'proxmox') lines.push(`  Proxmox-VM ${virt.vmid} auf ${virt.pveNode}${virt.ownMachine ? ' (eigene Maschine)' : ''}`)
        else if (virt?.kind === 'kvm') lines.push('  läuft in einer KVM-VM (Proxmox-Zuordnung unbekannt)')
        for (const suggestion of suggestionsFor(profile)) lines.push(`  → ${suggestion}`)
    }
    return lines.join('\n')
}
