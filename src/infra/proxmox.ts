/**
 * Proxmox-Adapter (Autonomie-Plan Phase 6c, 01.10.2026).
 *
 * Xaventra sees the guests on Alfred's Proxmox VE host and manages its OWN
 * guests in the pool `xaventra`. Fixed rules (code, not config):
 *
 * - Standard AUS: nothing happens unless `infra.proxmox.enabled === true`, a
 *   https URL, a pinned SHA-256 fingerprint and the env token
 *   `XAVENTRA_PVE_TOKEN` (`USER@REALM!TOKENID=SECRET`) are all present.
 * - TLS: Proxmox ships a self-signed certificate. We never switch TLS checks
 *   off globally; the one socket to the host is accepted only when the peer
 *   certificate's SHA-256 fingerprint equals the configured pin. The token is
 *   written only after that check (custom `createConnection`).
 * - Lesend: nodes, guests (VM + CT) with status/CPU/RAM/disk/tags, snapshots.
 * - Schreibend nur im Pool (the adapter re-reads pool membership itself, in
 *   addition to the Proxmox role):
 *     start, shutdown (sauber), snapshot, rollback   — every pool guest
 *     configure (CPU/RAM/Disk nur vergrößern)          — pool VMs
 *     create (Cloud-Image oder Klon einer Pool-Vorlage) — always `pool`,
 *            tag `xaventra-created`, network only vmbr0, cloud-init key
 *     destroy — ONLY tag `xaventra-created`, never protection=1, never this
 *            VM, never outside the pool, only when stopped
 *   create/configure respect the resource cap (sum of all
 *   `xaventra-created` guests) and the host RAM reserve; a refusal sends no
 *   write request.
 * - Never: guests outside the pool, other bridges, shrinking disks, hard
 *   stop/reset, migrate, snapshot delete, host commands. No code path.
 * - Every write action goes through a Knopf-Karte (see proxmox-command.ts)
 *   and runs only after the owner's Ja. Result = Proxmox task (UPID) polled
 *   until `stopped` with `exitstatus: OK`.
 * - The token never reaches a log, an error text, a card or a thought.
 */
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { redactSecrets } from '../security/secret-redaction.js'
import { resolveConfigPath } from '../config/config-path.js'

export const PVE_TOKEN_ENV = 'XAVENTRA_PVE_TOKEN'
export const CREATED_TAG = 'xaventra-created'
export const LAB_TAG = 'xaventra-lab'
/**
 * Own machines: pool guests tagged xaventra-created or xaventra-lab. ONLY
 * these may get root / passwordless sudo for Xaventra (cloud-init user
 * `nova`). Spark, ns1, ns2 and the NAS are no such guests and stay hardened -
 * see `isOwnMachine` and node-profile `privilegedOnOwnMachine`.
 */
export const OWN_MACHINE_TAGS: readonly string[] = Object.freeze([CREATED_TAG, LAB_TAG])
export const OWN_VM_USER = 'nova'
export const OWN_VM_TIMEZONE = 'Europe/Vienna'
/** Network for created guests — fixed, not configurable. */
export const CREATE_BRIDGE = 'vmbr0'

// ---------------------------------------------------------------------------
// Action classification (handed to the unified action policy at integration)
// ---------------------------------------------------------------------------

export type ProxmoxWriteAction = 'start' | 'shutdown' | 'snapshot' | 'rollback' | 'create' | 'configure' | 'destroy'

export interface ProxmoxActionClass {
    /** Knopf-Karten action kind (`aktion.kind`). */
    kind: string
    /** L1 = harmless, reversible by Alfred; L2 = changes running state, resources or discards state. All ask. */
    level: 'L1' | 'L2'
    /** Effect vocabulary for the action policy. Card impact is always `infra`. */
    effect: 'infra:vm-snapshot' | 'infra:vm-power' | 'infra:vm-rollback' | 'infra:vm-create' | 'infra:vm-config' | 'infra:vm-destroy'
    label: string
    /** How Alfred gets back. */
    rueckweg: string
}

export const PROXMOX_ACTIONS: Readonly<Record<ProxmoxWriteAction, ProxmoxActionClass>> = Object.freeze({
    snapshot: { kind: 'pve-snapshot', level: 'L1', effect: 'infra:vm-snapshot', label: 'Snapshot anlegen',
        rueckweg: 'Der Snapshot bleibt, bis Alfred ihn in Proxmox löscht (Xaventra löscht keine Snapshots).' },
    start: { kind: 'pve-start', level: 'L2', effect: 'infra:vm-power', label: 'Gast starten',
        rueckweg: '/vms stop <vmid> (sauberes Herunterfahren, wieder mit Karte).' },
    shutdown: { kind: 'pve-herunterfahren', level: 'L2', effect: 'infra:vm-power', label: 'Gast sauber herunterfahren (ACPI/Agent, kein Hart-Stopp)',
        rueckweg: '/vms start <vmid> (wieder mit Karte).' },
    rollback: { kind: 'pve-rollback', level: 'L2', effect: 'infra:vm-rollback', label: 'Auf Snapshot zurückrollen',
        rueckweg: 'Alles seit dem Snapshot ist weg. Vorher /vms snapshot <vmid> anlegen.' },
    create: { kind: 'pve-anlegen', level: 'L2', effect: 'infra:vm-create', label: 'VM anlegen',
        rueckweg: 'Neue VM trägt den Tag xaventra-created und kann per Karte wieder entfernt werden.' },
    configure: { kind: 'pve-anpassen', level: 'L2', effect: 'infra:vm-config', label: 'VM vergrößern (CPU/RAM/Disk)',
        rueckweg: 'CPU/RAM kann Alfred in Proxmox zurückstellen; eine Disk lässt sich nicht verkleinern.' },
    destroy: { kind: 'pve-entfernen', level: 'L2', effect: 'infra:vm-destroy', label: 'Eigene VM entfernen (endgültig)',
        rueckweg: 'Keiner — die VM und ihre Snapshots sind danach weg. Nur Gäste mit Tag xaventra-created.' },
})

/** Documented, refused, and without any code path. */
export const PROXMOX_NEVER: readonly string[] = Object.freeze([
    'Gäste außerhalb des Pools anfassen (nur lesen)',
    'Gäste ohne Tag xaventra-created, mit protection=1 oder diese VM selbst entfernen',
    'andere Netze als vmbr0, Disks verkleinern, Hart-Stopp, Reset, Migration',
    'Snapshots löschen',
    'Befehle auf dem Proxmox-Host (Shell, apt, Dienste, Firewall)',
])

export function actionForKind(kind: string): ProxmoxWriteAction | null {
    for (const [action, cls] of Object.entries(PROXMOX_ACTIONS)) if (cls.kind === kind) return action as ProxmoxWriteAction
    return null
}

export function isProxmoxWriteAction(value: unknown): value is ProxmoxWriteAction {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROXMOX_ACTIONS, value)
}

// ---------------------------------------------------------------------------
// Config + token
// ---------------------------------------------------------------------------

export interface ProxmoxLimits { ramGB: number; cores: number; diskGB: number; hostRamReserveGB: number }
export interface ProxmoxCreateConfig { storage: string; image: string; sshKeys: string; ciuser: string; node?: string; cicustom?: string }

export interface ProxmoxConfig {
    enabled: boolean
    /** Origin only, e.g. https://192.0.2.10:8006 */
    url: string
    /** AA:BB:… (32 bytes, upper case) */
    fingerprint: string
    pool: string
    /** Sensing adapter (Gast gestartet/gestoppt, Host-RAM, Deckel). */
    watch: boolean
    ramWarnPercent: number
    limits: ProxmoxLimits
    create: ProxmoxCreateConfig
    reason?: string
}

const POOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const NODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/
const STORAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/
const IMAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,39}:(?:iso|import|images)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/
const SSH_KEY_LINE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{40,}={0,3}(?: [^\r\n]{0,100})?$/
const CIUSER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/
const CICUSTOM_PATTERN = /^user=[A-Za-z][A-Za-z0-9_.-]{0,39}:snippets\/[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.ya?ml$/
export const SNAPNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/
export const GUEST_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const TAG_PATTERN = /^[a-z0-9_][a-z0-9_.+-]{0,39}$/
const UPID_PATTERN = /^UPID:([A-Za-z0-9][A-Za-z0-9.-]{0,62}):[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8,16}:[0-9A-Fa-f]{8}:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_.-]{0,40}:[^\s:]{1,120}:$/

/** Per-VM bounds for create/configure. */
export const VM_BOUNDS = Object.freeze({ cores: [1, 16] as const, memoryMB: [512, 65536] as const, diskGB: [8, 1024] as const })

export const DEFAULT_LIMITS: ProxmoxLimits = Object.freeze({ ramGB: 64, cores: 16, diskGB: 1024, hostRamReserveGB: 16 })
export const DEFAULT_CREATE: ProxmoxCreateConfig = Object.freeze({ storage: 'local-lvm', image: 'local:iso/noble-server-cloudimg-amd64.img', sshKeys: '', ciuser: OWN_VM_USER })

export function isValidVmid(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 999_999_999
}

export function normalizeFingerprint(value: unknown): string | null {
    const hex = String(value ?? '').trim().replace(/^sha256[:=]?/i, '').replace(/[:\s]/g, '').toUpperCase()
    if (!/^[0-9A-F]{64}$/.test(hex)) return null
    return hex.match(/../g)!.join(':')
}

export function parseTags(value: unknown): string[] {
    return String(value ?? '').split(/[;,\s]+/).map(tag => tag.trim().toLowerCase()).filter(tag => TAG_PATTERN.test(tag)).slice(0, 20)
}

const disabled = (reason: string): ProxmoxConfig => ({
    enabled: false, url: '', fingerprint: '', pool: 'xaventra', watch: false, ramWarnPercent: 90, limits: { ...DEFAULT_LIMITS }, create: { ...DEFAULT_CREATE }, reason,
})

const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(value ?? fallback)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

function parseCreate(raw: unknown): ProxmoxCreateConfig {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const storage = STORAGE_PATTERN.test(String(value.storage ?? '')) ? String(value.storage) : DEFAULT_CREATE.storage
    const image = IMAGE_PATTERN.test(String(value.image ?? '')) ? String(value.image) : DEFAULT_CREATE.image
    const keys = (Array.isArray(value.sshKeys) ? value.sshKeys : String(value.sshKeys ?? '').split('\n'))
        .map(line => String(line).trim()).filter(line => SSH_KEY_LINE.test(line)).slice(0, 5)
    const ciuser = CIUSER_PATTERN.test(String(value.ciuser ?? '')) ? String(value.ciuser) : DEFAULT_CREATE.ciuser
    const node = NODE_PATTERN.test(String(value.node ?? '')) ? String(value.node) : undefined
    const cicustom = CICUSTOM_PATTERN.test(String(value.cicustom ?? '')) ? String(value.cicustom) : undefined
    return { storage, image, sshKeys: keys.join('\n'), ciuser, ...(node ? { node } : {}), ...(cicustom ? { cicustom } : {}) }
}

export function parseProxmoxConfig(raw: unknown): ProxmoxConfig {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (value.enabled !== true) return disabled('infra.proxmox.enabled ist nicht true (Standard AUS)')
    let url: URL
    try { url = new URL(String(value.url || '')) } catch { return disabled('infra.proxmox.url fehlt oder ist ungültig') }
    if (url.protocol !== 'https:') return disabled('infra.proxmox.url muss https:// sein')
    if (url.username || url.password) return disabled('infra.proxmox.url darf keine Zugangsdaten enthalten')
    if (!['', '/', '/api2/json', '/api2/json/'].includes(url.pathname)) return disabled('infra.proxmox.url: nur Host und Port angeben')
    const fingerprint = normalizeFingerprint(value.fingerprint)
    if (!fingerprint) return disabled('infra.proxmox.fingerprint fehlt (SHA-256 des Host-Zertifikats, siehe docs/PROXMOX.md)')
    const pool = String(value.pool ?? 'xaventra')
    if (!POOL_PATTERN.test(pool)) return disabled('infra.proxmox.pool ist ungültig')
    const limits = (value.limits && typeof value.limits === 'object' ? value.limits : {}) as Record<string, unknown>
    return {
        enabled: true,
        url: `https://${url.port ? url.host : `${url.host}:8006`}`,
        fingerprint, pool,
        watch: value.watch !== false,
        ramWarnPercent: bounded(value.ramWarnPercent, 90, 50, 99),
        limits: {
            ramGB: bounded(limits.ramGB, DEFAULT_LIMITS.ramGB, 0, 4096),
            cores: bounded(limits.cores, DEFAULT_LIMITS.cores, 0, 512),
            diskGB: bounded(limits.diskGB, DEFAULT_LIMITS.diskGB, 0, 65536),
            hostRamReserveGB: bounded(limits.hostRamReserveGB, DEFAULT_LIMITS.hostRamReserveGB, 0, 4096),
        },
        create: parseCreate(value.create),
    }
}

export interface ProxmoxToken { user: string; tokenId: string; header: string; secret: string }

const TOKEN_PATTERN = /^([A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,32})!([A-Za-z][A-Za-z0-9._-]{0,63})=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

/** Returns null for anything that is not `USER@REALM!TOKENID=UUID`. Never echoes the value. */
export function parseProxmoxToken(value: unknown): ProxmoxToken | null {
    const match = TOKEN_PATTERN.exec(String(value ?? '').trim())
    if (!match) return null
    return { user: match[1], tokenId: match[2], secret: match[3], header: `PVEAPIToken=${match[1]}!${match[2]}=${match[3]}` }
}

// ---------------------------------------------------------------------------
// Pinned transport
// ---------------------------------------------------------------------------

export interface ProxmoxRequest { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; form?: Record<string, string> }
export interface ProxmoxResponse { status: number; data: unknown }
export type ProxmoxTransport = (request: ProxmoxRequest) => Promise<ProxmoxResponse>

export class ProxmoxPinError extends Error {
    constructor() { super('TLS-Fingerprint des Proxmox-Hosts stimmt nicht mit infra.proxmox.fingerprint überein — Verbindung verweigert, nichts gesendet.') }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function createPinnedTransport(options: { url: string; fingerprint: string; authHeader: string; timeoutMs?: number }): ProxmoxTransport {
    const base = new URL(options.url)
    const pin = normalizeFingerprint(options.fingerprint)
    if (!pin) throw new Error('Kein gültiger Fingerprint')
    const host = base.hostname.replace(/^\[|\]$/g, '')
    const port = Number(base.port || 8006)
    const timeoutMs = options.timeoutMs ?? 15_000
    const pinBuffer = Buffer.from(pin)

    const pinnedConnect = (_opts: unknown, callback: (error: Error | null, socket?: any) => void) => {
        // Only this socket accepts the self-signed certificate, and only with
        // the exact pinned fingerprint. Nothing is written before the check.
        const socket = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
        let done = false
        const finish = (error: Error | null) => {
            if (done) return
            done = true
            if (error) { socket.destroy(); callback(error) } else callback(null, socket)
        }
        socket.setTimeout(timeoutMs, () => finish(new Error('Proxmox: Zeitüberschreitung beim Verbindungsaufbau')))
        socket.once('secureConnect', () => {
            socket.setTimeout(0)
            const got = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256)
            const ok = got !== null && got.length === pin.length && timingSafeEqual(Buffer.from(got), pinBuffer)
            finish(ok ? null : new ProxmoxPinError())
        })
        socket.once('error', error => finish(new Error(`Proxmox nicht erreichbar: ${String(error?.message || error).slice(0, 120)}`)))
        return undefined
    }

    return (req: ProxmoxRequest) => new Promise<ProxmoxResponse>((resolve, reject) => {
        const body = req.form ? new URLSearchParams(req.form).toString() : undefined
        const headers: Record<string, string> = { Authorization: options.authHeader, Accept: 'application/json' }
        if (body !== undefined) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
            headers['Content-Length'] = String(Buffer.byteLength(body))
        }
        const request = httpRequest({
            host, port, method: req.method, path: `/api2/json${req.path}`, headers,
            createConnection: pinnedConnect as any,
        }, response => {
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_RESPONSE_BYTES) { request.destroy(new Error('Proxmox-Antwort zu groß')); return }
                chunks.push(chunk)
            })
            response.on('end', () => {
                let parsed: any = null
                try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { parsed = null }
                resolve({ status: response.statusCode || 0, data: parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : null })
            })
            response.on('error', reject)
        })
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Proxmox: Zeitüberschreitung')))
        request.on('error', reject)
        if (body !== undefined) request.write(body)
        request.end()
    })
}

// ---------------------------------------------------------------------------
// Data shapes (bounded on read)
// ---------------------------------------------------------------------------

export type GuestType = 'qemu' | 'lxc'
export interface ProxmoxGuest {
    vmid: number; name: string; type: GuestType; node: string; status: string
    cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number
    pool?: string; tags: string[]; template: boolean; uptime: number
}
export interface ProxmoxNode { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number }
export interface ProxmoxSnapshot { name: string; description: string; snaptime?: number; parent?: string }

const text = (value: unknown, max = 80): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
const number = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0 }
const GiB = 1024 ** 3

export function sanitizeGuest(raw: any): ProxmoxGuest | null {
    const vmid = Number(raw?.vmid)
    const type = raw?.type === 'qemu' || raw?.type === 'lxc' ? raw.type : null
    const node = String(raw?.node ?? '')
    if (!isValidVmid(vmid) || !type || !NODE_PATTERN.test(node)) return null
    return {
        vmid, type, node, name: text(raw.name, 64), status: text(raw.status, 20) || 'unknown',
        cpu: number(raw.cpu), maxcpu: number(raw.maxcpu), mem: number(raw.mem), maxmem: number(raw.maxmem),
        disk: number(raw.disk), maxdisk: number(raw.maxdisk),
        ...(typeof raw.pool === 'string' && POOL_PATTERN.test(raw.pool) ? { pool: raw.pool } : {}),
        tags: parseTags(raw.tags),
        template: raw.template === 1 || raw.template === true, uptime: number(raw.uptime),
    }
}

export function sanitizeNode(raw: any): ProxmoxNode | null {
    const node = String(raw?.node ?? '')
    if (!NODE_PATTERN.test(node)) return null
    return { node, status: text(raw.status, 20) || 'unknown', cpu: number(raw.cpu), maxcpu: number(raw.maxcpu), mem: number(raw.mem), maxmem: number(raw.maxmem), uptime: number(raw.uptime) }
}

/** All MAC addresses in a guest config (`net0: virtio=AA:…,bridge=…` or LXC `hwaddr=AA:…`). */
export function macsFromGuestConfig(config: unknown): string[] {
    if (!config || typeof config !== 'object') return []
    const out: string[] = []
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        if (!/^net\d{1,2}$/.test(key) || typeof value !== 'string') continue
        const match = /(?:^|,)[A-Za-z0-9]+=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})(?:,|$)/.exec(value)
        if (match) out.push(match[1].toUpperCase())
    }
    return out
}

/** Size of a disk line like `local-lvm:vm-150-disk-0,size=32G` in GB (0 if unknown). */
export function diskSizeGB(line: unknown): number {
    const match = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT])?(?:,|$)/.exec(String(line ?? ''))
    if (!match) return 0
    const factor = { K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 }[match[2] || 'G'] ?? 1
    return Math.round(Number(match[1]) * factor)
}

export function localMacAddresses(interfaces: Record<string, Array<{ mac?: string; internal?: boolean }> | undefined>): string[] {
    const macs = new Set<string>()
    for (const list of Object.values(interfaces)) for (const entry of list || []) {
        const mac = String(entry?.mac || '').toUpperCase()
        if (!entry?.internal && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac) && mac !== '00:00:00:00:00:00') macs.add(mac)
    }
    return [...macs]
}

/** Exactly one guest must own one of our MACs; ambiguity means "not found". */
export function matchGuestByMac(localMacs: readonly string[], candidates: ReadonlyArray<{ vmid: number; node: string; macs: readonly string[] }>): { vmid: number; node: string } | null {
    const mine = new Set(localMacs.map(mac => mac.toUpperCase()))
    const hits = candidates.filter(candidate => candidate.macs.some(mac => mine.has(mac.toUpperCase())))
    return hits.length === 1 ? { vmid: hits[0].vmid, node: hits[0].node } : null
}

// ---------------------------------------------------------------------------
// Inventory + resource cap (pure)
// ---------------------------------------------------------------------------

export interface ProxmoxUsage { ramGB: number; cores: number; diskGB: number; count: number }
export interface ProxmoxInventory { mine: ProxmoxGuest[]; pool: ProxmoxGuest[]; self: ProxmoxGuest | null; usage: ProxmoxUsage; free: ProxmoxUsage; limits: ProxmoxLimits }

/** Pool guest tagged xaventra-created or xaventra-lab: root/sudo for Xaventra allowed, auto-snapshot before larger changes. */
export function isOwnMachine(guest: Pick<ProxmoxGuest, 'vmid' | 'tags'>, members: ReadonlySet<number>): boolean {
    return members.has(guest.vmid) && guest.tags.some(tag => OWN_MACHINE_TAGS.includes(tag))
}

/**
 * cloud-init user-data for own VMs (place once as a Proxmox snippet, then set
 * `infra.proxmox.create.cicustom`). Root via passwordless sudo is intended
 * here - and only here (own machines, never Spark/ns1/ns2/NAS).
 */
export function renderOwnVmCloudInit(sshKeys: string): string {
    const keys = sshKeys.split('\n').map(line => line.trim()).filter(line => SSH_KEY_LINE.test(line))
    return [
        '#cloud-config',
        `timezone: ${OWN_VM_TIMEZONE}`,
        'users:',
        `  - name: ${OWN_VM_USER}`,
        '    groups: [sudo, docker]',
        '    shell: /bin/bash',
        '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
        '    lock_passwd: true',
        '    ssh_authorized_keys:',
        ...keys.map(key => `      - ${JSON.stringify(key)}`),
        'ssh_pwauth: false',
        'package_update: true',
        'packages: [qemu-guest-agent]',
        'runcmd:',
        '  - [systemctl, enable, --now, qemu-guest-agent]',
        '',
    ].join('\n')
}

/** "Meine VMs" = pool members carrying the tag xaventra-created. */
export function isOwnCreated(guest: Pick<ProxmoxGuest, 'vmid' | 'tags'>, members: ReadonlySet<number>): boolean {
    return members.has(guest.vmid) && guest.tags.includes(CREATED_TAG)
}

export function buildInventory(guests: readonly ProxmoxGuest[], members: ReadonlySet<number>, limits: ProxmoxLimits, selfVmid: number | null): ProxmoxInventory {
    const mine = guests.filter(guest => isOwnCreated(guest, members))
    const usage: ProxmoxUsage = {
        ramGB: Math.round(mine.reduce((sum, guest) => sum + guest.maxmem, 0) / GiB),
        cores: mine.reduce((sum, guest) => sum + guest.maxcpu, 0),
        diskGB: Math.round(mine.reduce((sum, guest) => sum + guest.maxdisk, 0) / GiB),
        count: mine.length,
    }
    return {
        mine, pool: guests.filter(guest => members.has(guest.vmid)), self: guests.find(guest => guest.vmid === selfVmid) || null, usage, limits,
        free: { ramGB: Math.max(0, limits.ramGB - usage.ramGB), cores: Math.max(0, limits.cores - usage.cores), diskGB: Math.max(0, limits.diskGB - usage.diskGB), count: 0 },
    }
}

/** null = within the cap; otherwise the reason. `extra` is the additional demand. */
export function capViolation(usage: ProxmoxUsage, extra: { ramGB: number; cores: number; diskGB: number }, limits: ProxmoxLimits, host?: Pick<ProxmoxNode, 'node' | 'mem' | 'maxmem'>): string | null {
    const reasons: string[] = []
    if (usage.ramGB + extra.ramGB > limits.ramGB) reasons.push(`RAM ${usage.ramGB}+${extra.ramGB} > ${limits.ramGB} GB`)
    if (usage.cores + extra.cores > limits.cores) reasons.push(`Kerne ${usage.cores}+${extra.cores} > ${limits.cores}`)
    if (usage.diskGB + extra.diskGB > limits.diskGB) reasons.push(`Disk ${usage.diskGB}+${extra.diskGB} > ${limits.diskGB} GB`)
    const host_ = host ? hostReserveViolation(host, extra.ramGB, limits) : null
    if (host_) reasons.push(host_.replace(/^Ressourcen-Deckel: /, ''))
    return reasons.length ? `Ressourcen-Deckel: ${reasons.join('; ')}` : null
}

export function hostReserveViolation(host: Pick<ProxmoxNode, 'node' | 'mem' | 'maxmem'>, extraRamGB: number, limits: ProxmoxLimits): string | null {
    if (extraRamGB <= 0) return null
    const freeGB = (host.maxmem - host.mem) / GiB
    return freeGB - extraRamGB < limits.hostRamReserveGB
        ? `Ressourcen-Deckel: Host ${host.node}: frei ${Math.floor(freeGB)} GB − ${extraRamGB} GB < Reserve ${limits.hostRamReserveGB} GB`
        : null
}

// ---------------------------------------------------------------------------
// Action specs and card references (`aktion.ref`, max 160 chars, no spaces)
// ---------------------------------------------------------------------------

export interface CreateSpec { name: string; cores: number; memoryMB: number; diskGB: number; template?: number }
export interface ResizeSpec { cores?: number; memoryMB?: number; diskGB?: number }
export type ProxmoxActionInput =
    | { action: 'start' | 'shutdown' | 'destroy'; vmid: number }
    | { action: 'snapshot' | 'rollback'; vmid: number; snapname: string }
    | { action: 'create'; vmid: number; spec: CreateSpec }
    | { action: 'configure'; vmid: number; spec: ResizeSpec }

const inRange = (value: unknown, [min, max]: readonly [number, number]) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max

export function validateCreateSpec(spec: Partial<CreateSpec> | undefined): string | null {
    if (!spec || !GUEST_NAME_PATTERN.test(String(spec.name ?? ''))) return 'Name: Kleinbuchstaben, Ziffern, Bindestrich, 1–40 Zeichen.'
    if (!inRange(spec.cores, VM_BOUNDS.cores)) return `Kerne ${VM_BOUNDS.cores[0]}–${VM_BOUNDS.cores[1]}.`
    if (!inRange(spec.memoryMB, VM_BOUNDS.memoryMB)) return `RAM ${VM_BOUNDS.memoryMB[0]}–${VM_BOUNDS.memoryMB[1]} MB.`
    if (!inRange(spec.diskGB, VM_BOUNDS.diskGB)) return `Disk ${VM_BOUNDS.diskGB[0]}–${VM_BOUNDS.diskGB[1]} GB.`
    if (spec.template !== undefined && !isValidVmid(spec.template)) return 'Ungültige Vorlagen-vmid.'
    return null
}

export function validateResizeSpec(spec: ResizeSpec | undefined): string | null {
    if (!spec || (spec.cores === undefined && spec.memoryMB === undefined && spec.diskGB === undefined)) return 'Nichts zu ändern (Kerne, RAM oder Disk angeben).'
    if (spec.cores !== undefined && !inRange(spec.cores, VM_BOUNDS.cores)) return `Kerne ${VM_BOUNDS.cores[0]}–${VM_BOUNDS.cores[1]}.`
    if (spec.memoryMB !== undefined && !inRange(spec.memoryMB, VM_BOUNDS.memoryMB)) return `RAM ${VM_BOUNDS.memoryMB[0]}–${VM_BOUNDS.memoryMB[1]} MB.`
    if (spec.diskGB !== undefined && !inRange(spec.diskGB, VM_BOUNDS.diskGB)) return `Disk ${VM_BOUNDS.diskGB[0]}–${VM_BOUNDS.diskGB[1]} GB.`
    return null
}

export function encodeActionRef(input: ProxmoxActionInput): string {
    switch (input.action) {
        case 'snapshot': case 'rollback': return `${input.vmid}:${input.snapname}`
        case 'create': return [input.vmid, input.spec.name, `c${input.spec.cores}`, `m${input.spec.memoryMB}`, `d${input.spec.diskGB}`, ...(input.spec.template ? [`t${input.spec.template}`] : [])].join(':')
        case 'configure': return [input.vmid, ...(input.spec.cores ? [`c${input.spec.cores}`] : []), ...(input.spec.memoryMB ? [`m${input.spec.memoryMB}`] : []), ...(input.spec.diskGB ? [`d${input.spec.diskGB}`] : [])].join(':')
        default: return String(input.vmid)
    }
}

function sizeParts(parts: string[]): ResizeSpec & { template?: number } | null {
    const out: ResizeSpec & { template?: number } = {}
    for (const part of parts) {
        const match = /^([cmdt])(\d{1,9})$/.exec(part)
        if (!match) return null
        const n = Number(match[2])
        const key = { c: 'cores', m: 'memoryMB', d: 'diskGB', t: 'template' }[match[1]] as keyof typeof out
        if (out[key] !== undefined) return null
        out[key] = n
    }
    return out
}

export function decodeActionRef(action: ProxmoxWriteAction, ref: string): ProxmoxActionInput | null {
    const parts = String(ref ?? '').split(':')
    const vmid = Number(parts[0])
    if (!/^\d{3,9}$/.test(parts[0] || '') || !isValidVmid(vmid)) return null
    if (action === 'start' || action === 'shutdown' || action === 'destroy') return parts.length === 1 ? { action, vmid } : null
    if (action === 'snapshot' || action === 'rollback') return parts.length === 2 && SNAPNAME_PATTERN.test(parts[1]) ? { action, vmid, snapname: parts[1] } : null
    if (action === 'create') {
        const sizes = sizeParts(parts.slice(2))
        if (!sizes) return null
        const spec: CreateSpec = { name: parts[1], cores: sizes.cores!, memoryMB: sizes.memoryMB!, diskGB: sizes.diskGB!, ...(sizes.template ? { template: sizes.template } : {}) }
        return validateCreateSpec(spec) ? null : { action, vmid, spec }
    }
    const sizes = sizeParts(parts.slice(1))
    if (!sizes || sizes.template !== undefined) return null
    return validateResizeSpec(sizes) ? null : { action: 'configure', vmid, spec: sizes }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ProxmoxActionResult { ok: boolean; message: string; upid?: string; requested: boolean }
export interface ProxmoxClientOptions {
    config: ProxmoxConfig
    token: ProxmoxToken
    transport?: ProxmoxTransport
    log?: (line: string) => void
    sleep?: (ms: number) => Promise<void>
    taskPollMs?: number
    taskTimeoutMs?: number
}

type Checked<T> = { ok: true } & T | { ok: false; message: string }

export class ProxmoxClient {
    readonly config: ProxmoxConfig
    private readonly token: ProxmoxToken
    private readonly transport: ProxmoxTransport
    private readonly logLine: (line: string) => void
    private readonly sleep: (ms: number) => Promise<void>
    private readonly taskPollMs: number
    private readonly taskTimeoutMs: number

    constructor(options: ProxmoxClientOptions) {
        if (!options.config.enabled) throw new Error(`Proxmox aus: ${options.config.reason || 'nicht konfiguriert'}`)
        this.config = options.config
        this.token = options.token
        this.transport = options.transport || createPinnedTransport({ url: options.config.url, fingerprint: options.config.fingerprint, authHeader: options.token.header })
        this.logLine = options.log || (line => console.log(line))
        this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
        this.taskPollMs = options.taskPollMs ?? 1500
        this.taskTimeoutMs = options.taskTimeoutMs ?? 10 * 60_000
    }

    /** Every text that leaves this class goes through here. */
    safe(value: unknown, max = 240): string {
        let out = String(value ?? '')
        for (const secret of [this.token.header, this.token.secret]) out = out.split(secret).join('[REDACTED]')
        return redactSecrets(out).replace(/[\u0000-\u001f]/g, ' ').slice(0, max)
    }

    private log(line: string): void { try { this.logLine(`[Proxmox] ${this.safe(line, 400)}`) } catch { /* logging never fails a call */ } }

    private async call(request: ProxmoxRequest): Promise<unknown> {
        let response: ProxmoxResponse
        try { response = await this.transport(request) } catch (error) {
            throw new Error(this.safe((error as Error)?.message || error))
        }
        if (response.status === 401) throw new Error('Proxmox: Token abgelehnt (401) — XAVENTRA_PVE_TOKEN prüfen')
        if (response.status === 403) throw new Error(`Proxmox: keine Berechtigung (403) für ${request.method} ${this.safe(request.path, 120)}`)
        if (response.status < 200 || response.status >= 300) throw new Error(`Proxmox: HTTP ${response.status} für ${request.method} ${this.safe(request.path, 120)}`)
        return response.data
    }

    // ---- read ----------------------------------------------------------

    async listNodes(): Promise<ProxmoxNode[]> {
        const data = await this.call({ method: 'GET', path: '/nodes' })
        return (Array.isArray(data) ? data : []).slice(0, 64).map(sanitizeNode).filter(Boolean) as ProxmoxNode[]
    }

    async listGuests(): Promise<ProxmoxGuest[]> {
        const data = await this.call({ method: 'GET', path: '/cluster/resources?type=vm' })
        return (Array.isArray(data) ? data : []).slice(0, 1000).map(sanitizeGuest).filter(Boolean)
            .sort((a, b) => a!.vmid - b!.vmid) as ProxmoxGuest[]
    }

    /** Pool membership straight from Proxmox (authoritative for writes). */
    async poolMembers(): Promise<Set<number>> {
        const data = await this.call({ method: 'GET', path: `/pools?poolid=${encodeURIComponent(this.config.pool)}` }) as any
        const entry = Array.isArray(data) ? data.find((item: any) => item?.poolid === this.config.pool) : data
        const members = Array.isArray(entry?.members) ? entry.members : []
        return new Set(members.filter((m: any) => m?.type === 'qemu' || m?.type === 'lxc').map((m: any) => Number(m.vmid)).filter(isValidVmid))
    }

    async listSnapshots(guest: Pick<ProxmoxGuest, 'vmid' | 'node' | 'type'>): Promise<ProxmoxSnapshot[]> {
        const data = await this.call({ method: 'GET', path: `${guestPath(guest)}/snapshot` })
        return (Array.isArray(data) ? data : []).filter((item: any) => item?.name && item.name !== 'current').slice(0, 100).map((item: any) => ({
            name: text(item.name, 40), description: text(item.description, 120),
            ...(Number.isFinite(Number(item.snaptime)) ? { snaptime: Number(item.snaptime) } : {}),
            ...(item.parent ? { parent: text(item.parent, 40) } : {}),
        }))
    }

    async guestConfig(guest: Pick<ProxmoxGuest, 'vmid' | 'node' | 'type'>): Promise<Record<string, unknown>> {
        const data = await this.call({ method: 'GET', path: `${guestPath(guest)}/config` })
        return data && typeof data === 'object' ? data as Record<string, unknown> : {}
    }

    async nextId(): Promise<number> {
        const id = Number(await this.call({ method: 'GET', path: '/cluster/nextid' }))
        if (!isValidVmid(id)) throw new Error('Proxmox lieferte keine freie vmid')
        return id
    }

    async inventory(selfVmid: number | null = null): Promise<ProxmoxInventory & { nodes: ProxmoxNode[]; guests: ProxmoxGuest[]; members: Set<number> }> {
        const [guests, members, nodes] = await Promise.all([this.listGuests(), this.poolMembers(), this.listNodes()])
        return { ...buildInventory(guests, members, this.config.limits, selfVmid), nodes, guests, members }
    }

    /** Finds the guest that owns one of our MAC addresses (read only). */
    async locateSelf(localMacs: readonly string[]): Promise<{ vmid: number; node: string; ownMachine: boolean } | null> {
        if (!localMacs.length) return null
        const all = await this.listGuests()
        const guests = all.filter(guest => !guest.template).slice(0, 64)
        const candidates: Array<{ vmid: number; node: string; macs: string[] }> = []
        for (const guest of guests) {
            try { candidates.push({ vmid: guest.vmid, node: guest.node, macs: macsFromGuestConfig(await this.guestConfig(guest)) }) } catch { /* no VM.Audit on this guest */ }
        }
        const hit = matchGuestByMac(localMacs, candidates)
        if (!hit) return null
        const members = await this.poolMembers().catch(() => new Set<number>())
        const guest = all.find(item => item.vmid === hit.vmid)
        return { ...hit, ownMachine: guest ? isOwnMachine(guest, members) : false }
    }

    // ---- checks (read only; before a card and again before executing) --

    async resolvePoolGuest(vmid: number): Promise<Checked<{ guest: ProxmoxGuest; ownMachine: boolean }>> {
        if (!isValidVmid(vmid)) return { ok: false, message: 'Ungültige vmid.' }
        const [guests, members] = await Promise.all([this.listGuests(), this.poolMembers()])
        const guest = guests.find(item => item.vmid === vmid)
        if (!guest) return { ok: false, message: `Gast ${vmid} nicht gefunden.` }
        if (!members.has(vmid)) return { ok: false, message: `Gast ${vmid} (${guest.name || guest.type}) ist nicht im Pool „${this.config.pool}“ — nur lesen, keine Aktion.` }
        if (guest.template) return { ok: false, message: `Gast ${vmid} ist eine Vorlage — keine Aktion.` }
        return { ok: true, guest, ownMachine: isOwnMachine(guest, members) }
    }

    /** Everything that decides whether a write may happen. Never writes. */
    async checkAction(input: ProxmoxActionInput, options: { selfVmid?: number | null } = {}): Promise<Checked<{ guest?: ProxmoxGuest; node?: ProxmoxNode; detail: string; autoSnapshot?: boolean; current?: { cores: number; memoryMB: number; diskGB: number; diskKey?: string } }>> {
        if (!isProxmoxWriteAction((input as any)?.action)) return { ok: false, message: `Aktion „${this.safe((input as any)?.action, 40)}“ gibt es nicht.` }
        if (!isValidVmid(input.vmid)) return { ok: false, message: 'Ungültige vmid.' }
        if (input.action === 'create') {
            const invalid = validateCreateSpec(input.spec)
            if (invalid) return { ok: false, message: invalid }
            const inv = await this.inventory(options.selfVmid ?? null)
            if (inv.guests.some(guest => guest.vmid === input.vmid)) return { ok: false, message: `vmid ${input.vmid} ist bereits vergeben.` }
            const node = inv.nodes.find(item => item.node === (this.config.create.node || '')) || inv.nodes.find(item => item.status === 'online') || inv.nodes[0]
            if (!node) return { ok: false, message: 'Kein Proxmox-Knoten sichtbar.' }
            if (input.spec.template !== undefined) {
                const template = inv.guests.find(guest => guest.vmid === input.spec.template)
                if (!template || !template.template || !inv.members.has(template.vmid) || template.type !== 'qemu') return { ok: false, message: `Vorlage ${input.spec.template} ist keine VM-Vorlage im Pool „${this.config.pool}“.` }
            } else if (!this.config.create.sshKeys && !this.config.create.cicustom) {
                return { ok: false, message: 'infra.proxmox.create.sshKeys fehlt (Owner-SSH-Schlüssel für cloud-init).' }
            }
            const cap = capViolation(inv.usage, { ramGB: Math.ceil(input.spec.memoryMB / 1024), cores: input.spec.cores, diskGB: input.spec.diskGB }, this.config.limits, node)
            if (cap) return { ok: false, message: cap }
            return { ok: true, node, detail: `${input.spec.name}: ${input.spec.cores} Kerne, ${input.spec.memoryMB} MB RAM, ${input.spec.diskGB} GB Disk, ${input.spec.template ? `Klon von ${input.spec.template}` : this.config.create.image}, Netz ${CREATE_BRIDGE}, Pool ${this.config.pool}, Tag ${CREATED_TAG}, Benutzer ${OWN_VM_USER} ${this.config.create.cicustom ? `(sudo ohne Passwort, Gruppen sudo/docker, ${OWN_VM_TIMEZONE}, Snippet ${this.config.create.cicustom})` : '(cloud-init-Standard; ohne Snippet keine Zeitzone/docker-Gruppe)'}. Deckel danach: RAM ${inv.usage.ramGB + Math.ceil(input.spec.memoryMB / 1024)}/${this.config.limits.ramGB} GB, Kerne ${inv.usage.cores + input.spec.cores}/${this.config.limits.cores}, Disk ${inv.usage.diskGB + input.spec.diskGB}/${this.config.limits.diskGB} GB.` }
        }
        const resolved = await this.resolvePoolGuest(input.vmid)
        if (resolved.ok === false) return { ok: false, message: resolved.message }
        const guest = resolved.guest
        const autoSnapshot = resolved.ownMachine
        const autoText = autoSnapshot ? ' Vorher legt Xaventra automatisch einen Snapshot an (eigene VM, L1).' : ''
        if (input.action === 'snapshot' || input.action === 'rollback') {
            if (!SNAPNAME_PATTERN.test(String(input.snapname ?? ''))) return { ok: false, message: 'Ungültiger Snapshot-Name.' }
            if (input.action === 'rollback' && !(await this.listSnapshots(guest)).some(snap => snap.name === input.snapname)) return { ok: false, message: `Snapshot „${input.snapname}“ gibt es für Gast ${guest.vmid} nicht.` }
            return input.action === 'rollback' ? { ok: true, guest, autoSnapshot, detail: `Snapshot „${input.snapname}“.${autoText}` } : { ok: true, guest, detail: `Snapshot „${input.snapname}“` }
        }
        if (input.action === 'start' || input.action === 'shutdown') return { ok: true, guest, detail: `Status jetzt ${guest.status}` }
        const config = await this.guestConfig(guest)
        if (input.action === 'destroy') {
            const tags = parseTags(config.tags ?? guest.tags.join(';'))
            if (!tags.includes(CREATED_TAG) || !guest.tags.includes(CREATED_TAG)) return { ok: false, message: `Gast ${guest.vmid} trägt nicht den Tag ${CREATED_TAG} — Entfernen nur für selbst angelegte VMs.` }
            if (String(config.protection ?? '0') === '1') return { ok: false, message: `Gast ${guest.vmid} ist geschützt (protection=1) — wird nie entfernt.` }
            if (options.selfVmid && guest.vmid === options.selfVmid) return { ok: false, message: 'Das ist die VM, auf der Xaventra läuft — wird nie entfernt.' }
            if (guest.status !== 'stopped') return { ok: false, message: `Gast ${guest.vmid} läuft noch (${guest.status}) — erst /vms stop ${guest.vmid}.` }
            const snaps = await this.listSnapshots(guest).catch(() => [] as ProxmoxSnapshot[])
            return { ok: true, guest, detail: `Snapshots (${snaps.length}${snaps.length ? `: ${snaps.slice(-3).map(s => s.name).join(', ')}` : ''}) verschwinden mit der VM. Ein Backup (vzdump) legt Xaventra nicht an — falls nötig vorher in Proxmox sichern.` }
        }
        // configure (VMs only, only grow)
        if (guest.type !== 'qemu') return { ok: false, message: 'Vergrößern geht nur für VMs.' }
        const spec = (input as Extract<ProxmoxActionInput, { action: 'configure' }>).spec
        const invalid = validateResizeSpec(spec)
        if (invalid) return { ok: false, message: invalid }
        const diskKey = ['scsi0', 'virtio0', 'sata0', 'ide0'].find(key => typeof config[key] === 'string' && !/media=cdrom|cloudinit/.test(String(config[key])))
        const current = { cores: number(config.cores) || 1, memoryMB: number(config.memory) || 512, diskGB: diskKey ? diskSizeGB(config[diskKey]) : 0, diskKey }
        if (spec.cores !== undefined && spec.cores <= current.cores) return { ok: false, message: `Kerne nur vergrößern (jetzt ${current.cores}).` }
        if (spec.memoryMB !== undefined && spec.memoryMB <= current.memoryMB) return { ok: false, message: `RAM nur vergrößern (jetzt ${current.memoryMB} MB).` }
        if (spec.diskGB !== undefined && (!diskKey || spec.diskGB <= current.diskGB)) return { ok: false, message: `Disk nur vergrößern (jetzt ${current.diskGB} GB).` }
        const inv = await this.inventory(options.selfVmid ?? null)
        const counts = isOwnCreated(guest, inv.members)
        const extra = {
            ramGB: spec.memoryMB !== undefined ? Math.ceil((spec.memoryMB - current.memoryMB) / 1024) : 0,
            cores: spec.cores !== undefined ? spec.cores - current.cores : 0,
            diskGB: spec.diskGB !== undefined ? spec.diskGB - current.diskGB : 0,
        }
        const node = inv.nodes.find(item => item.node === guest.node)
        // The cap sums only xaventra-created guests; the host reserve holds for every guest.
        const cap = (counts ? capViolation(inv.usage, extra, this.config.limits) : null)
            || (node ? hostReserveViolation(node, extra.ramGB, this.config.limits) : null)
        if (cap) return { ok: false, message: cap }
        return { ok: true, guest, node, current, autoSnapshot, detail: `jetzt ${current.cores} Kerne, ${current.memoryMB} MB, ${current.diskGB} GB → ${spec.cores ?? current.cores} Kerne, ${spec.memoryMB ?? current.memoryMB} MB, ${spec.diskGB ?? current.diskGB} GB.${autoText}` }
    }

    // ---- write (only after the owner's Ja, see proxmox-command.ts) -----

    async executeAction(input: ProxmoxActionInput & { note?: string }, options: { selfVmid?: number | null } = {}): Promise<ProxmoxActionResult> {
        const refuse = (message: string): ProxmoxActionResult => { this.log(`abgelehnt: ${message}`); return { ok: false, message, requested: false } }
        let check: Awaited<ReturnType<ProxmoxClient['checkAction']>>
        try { check = await this.checkAction(input, options) } catch (error) { return refuse(this.safe((error as Error)?.message || error)) }
        if (check.ok === false) return refuse(check.message)
        const note = input.note ? String(input.note).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40) : ''
        this.log(`${input.action} Gast ${input.vmid} (Pool ${this.config.pool})`)
        try {
            if (input.action === 'create') return await this.runCreate(input, check.node!.node, note)
            const guest = check.guest!
            const base = guestPath(guest)
            if (check.autoSnapshot && (input.action === 'configure' || input.action === 'rollback')) {
                // Larger change on an own VM: safety snapshot first (L1, covered by the same Ja).
                const name = autoSnapshotName(Date.now())
                const safety = await this.runTask(guest.node, { method: 'POST', path: `${base}/snapshot`, form: { snapname: name, description: `Xaventra: automatisch vor ${input.action} ${note}`.trim() } }, false)
                if (safety.ok === false) return { ...safety, message: `Sicherheits-Snapshot fehlgeschlagen — ${input.action} nicht ausgeführt: ${safety.message}` }
            }
            if (input.action === 'configure') {
                const tasks: string[] = []
                const form: Record<string, string> = {}
                if (input.spec.cores !== undefined) form.cores = String(input.spec.cores)
                if (input.spec.memoryMB !== undefined) form.memory = String(input.spec.memoryMB)
                if (Object.keys(form).length) {
                    const result = await this.runTask(guest.node, { method: 'POST', path: `${base}/config`, form }, true)
                    if (result.ok === false) return result
                    if (result.upid) tasks.push(result.upid)
                }
                if (input.spec.diskGB !== undefined) {
                    const result = await this.runTask(guest.node, { method: 'PUT', path: `${base}/resize`, form: { disk: check.current!.diskKey!, size: `${input.spec.diskGB}G` } }, true)
                    if (result.ok === false) return result
                    if (result.upid) tasks.push(result.upid)
                }
                return { ok: true, message: `Vergrößert: ${check.detail}.`, upid: tasks[tasks.length - 1], requested: true }
            }
            const request: ProxmoxRequest = input.action === 'start' ? { method: 'POST', path: `${base}/status/start` }
                : input.action === 'shutdown' ? { method: 'POST', path: `${base}/status/shutdown`, form: { timeout: '180' } }
                : input.action === 'snapshot' ? { method: 'POST', path: `${base}/snapshot`, form: { snapname: input.snapname, description: `Xaventra, Owner-Freigabe ${note}`.trim() } }
                : input.action === 'rollback' ? { method: 'POST', path: `${base}/snapshot/${encodeURIComponent(input.snapname)}/rollback` }
                : { method: 'DELETE', path: `${base}?purge=1&destroy-unreferenced-disks=1` }
            return await this.runTask(guest.node, request, false)
        } catch (error) {
            return { ok: false, message: this.safe((error as Error)?.message || error), requested: true }
        }
    }

    private async runCreate(input: Extract<ProxmoxActionInput, { action: 'create' }>, node: string, note: string): Promise<ProxmoxActionResult> {
        const { spec, vmid } = input
        const create = this.config.create
        const description = `Angelegt von Xaventra (Owner-Freigabe ${note})`.trim()
        // With a snippet (cicustom) the user `nova` gets passwordless sudo, sudo/docker and the time zone.
        const cloudInit: Record<string, string> = create.cicustom
            ? { cicustom: create.cicustom, ipconfig0: 'ip=dhcp' }
            : { ciuser: create.ciuser, ipconfig0: 'ip=dhcp', ...(create.sshKeys ? { sshkeys: encodeURIComponent(create.sshKeys) } : {}) }
        let first: ProxmoxActionResult
        if (spec.template !== undefined) {
            first = await this.runTask(node, { method: 'POST', path: `/nodes/${encodeURIComponent(node)}/qemu/${spec.template}/clone`, form: {
                newid: String(vmid), name: spec.name, pool: this.config.pool, full: '1', storage: create.storage, description,
            } }, false)
            if (first.ok === false) return first
            const configured = await this.runTask(node, { method: 'POST', path: `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`, form: {
                tags: CREATED_TAG, cores: String(spec.cores), memory: String(spec.memoryMB), net0: `virtio,bridge=${CREATE_BRIDGE}`, ...cloudInit,
            } }, true)
            if (configured.ok === false) return configured
        } else {
            first = await this.runTask(node, { method: 'POST', path: `/nodes/${encodeURIComponent(node)}/qemu`, form: {
                vmid: String(vmid), name: spec.name, pool: this.config.pool, tags: CREATED_TAG, description,
                cores: String(spec.cores), memory: String(spec.memoryMB), ostype: 'l26', scsihw: 'virtio-scsi-pci',
                scsi0: `${create.storage}:0,import-from=${create.image}`, ide2: `${create.storage}:cloudinit`, boot: 'order=scsi0',
                serial0: 'socket', vga: 'serial0', agent: 'enabled=1', net0: `virtio,bridge=${CREATE_BRIDGE}`, ...cloudInit,
            } }, false)
            if (first.ok === false) return first
        }
        const resized = await this.runTask(node, { method: 'PUT', path: `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`, form: { disk: 'scsi0', size: `${spec.diskGB}G` } }, true)
        if (resized.ok === false) return { ...resized, message: `VM ${vmid} angelegt, aber Disk nicht vergrößert: ${resized.message}` }
        return { ok: true, message: `VM ${vmid} „${spec.name}“ angelegt (Pool ${this.config.pool}, Tag ${CREATED_TAG}, Netz ${CREATE_BRIDGE}); Proxmox-Tasks OK. Start per /vms start ${vmid}.`, upid: first.upid, requested: true }
    }

    /** One write request, then task verification. `allowSync`: some calls may answer without a task. */
    private async runTask(node: string, request: ProxmoxRequest, allowSync: boolean): Promise<ProxmoxActionResult> {
        let data: unknown
        try { data = await this.call(request) } catch (error) { return { ok: false, message: this.safe((error as Error)?.message || error), requested: true } }
        if ((data === null || data === undefined || data === '') && allowSync) return { ok: true, message: 'Proxmox: erledigt (ohne Task).', requested: true }
        const upid = String(data ?? '')
        const match = UPID_PATTERN.exec(upid)
        if (!match || match[1] !== node) return { ok: false, message: 'Proxmox lieferte keine gültige Task-ID — Ergebnis unbestätigt.', requested: true }
        const verified = await this.waitForTask(node, upid)
        this.log(`${request.method} ${request.path.split('?')[0]}: ${verified.ok ? 'OK' : verified.message}`)
        return { ...verified, upid, requested: true }
    }

    /** Polls the task until `stopped`; only `exitstatus: OK` counts as success. */
    async waitForTask(node: string, upid: string): Promise<{ ok: boolean; message: string }> {
        const deadline = Date.now() + this.taskTimeoutMs
        const maxPolls = Math.max(1, Math.ceil(this.taskTimeoutMs / Math.max(1, this.taskPollMs)) + 1)
        for (let poll = 0; poll < maxPolls; poll++) {
            let data: any
            try { data = await this.call({ method: 'GET', path: `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status` }) } catch (error) {
                return { ok: false, message: `Task-Status nicht lesbar: ${this.safe((error as Error)?.message || error, 160)}` }
            }
            if (data?.status === 'stopped') {
                const exit = this.safe(data.exitstatus ?? '', 120)
                return exit === 'OK' ? { ok: true, message: 'Proxmox-Task abgeschlossen (OK).' } : { ok: false, message: `Proxmox-Task beendet mit „${exit || 'unbekannt'}“.` }
            }
            if (Date.now() > deadline) break
            await this.sleep(this.taskPollMs)
        }
        return { ok: false, message: 'Proxmox-Task nach Zeitlimit nicht abgeschlossen — Ergebnis unbestätigt, bitte /vms prüfen.' }
    }
}

export function autoSnapshotName(now: number): string {
    return `xv-auto-${new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`
}

function guestPath(guest: Pick<ProxmoxGuest, 'vmid' | 'node' | 'type'>): string {
    if (!NODE_PATTERN.test(guest.node) || !isValidVmid(guest.vmid) || (guest.type !== 'qemu' && guest.type !== 'lxc')) throw new Error('Ungültiger Gast')
    return `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export function readProxmoxRawConfig(): unknown {
    try {
        const path = resolveConfigPath()
        if (!existsSync(path)) return undefined
        return JSON.parse(readFileSync(path, 'utf8'))?.infra?.proxmox
    } catch { return undefined }
}

export type ProxmoxRuntime = { ok: true; client: ProxmoxClient; config: ProxmoxConfig } | { ok: false; reason: string }

export async function loadProxmoxRuntime(options: { rawConfig?: unknown; env?: NodeJS.ProcessEnv; transport?: ProxmoxTransport; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<ProxmoxRuntime> {
    const raw = options.rawConfig === undefined ? readProxmoxRawConfig() : options.rawConfig
    const config = parseProxmoxConfig(raw)
    if (!config.enabled) return { ok: false, reason: config.reason || 'Proxmox aus' }
    const env = options.env || process.env
    if (!env[PVE_TOKEN_ENV]) return { ok: false, reason: `${PVE_TOKEN_ENV} ist nicht gesetzt` }
    const token = parseProxmoxToken(env[PVE_TOKEN_ENV])
    if (!token) return { ok: false, reason: `${PVE_TOKEN_ENV} hat nicht das Format USER@REALM!TOKENID=SECRET (Wert wird nicht angezeigt)` }
    return { ok: true, config, client: new ProxmoxClient({ config, token, transport: options.transport, log: options.log, sleep: options.sleep }) }
}

/** Node profile: which Proxmox guest am I? Read only, bounded in time; null when off or not found. */
export async function locateSelfOnProxmox(localMacs: readonly string[], options: { timeoutMs?: number; runtime?: ProxmoxRuntime } = {}): Promise<{ vmid: number; node: string; ownMachine: boolean } | null> {
    const runtime = options.runtime || await loadProxmoxRuntime()
    if (runtime.ok === false) return null
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            runtime.client.locateSelf(localMacs),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), options.timeoutMs ?? 8000); timer.unref?.() }),
        ])
    } catch { return null } finally { if (timer) clearTimeout(timer) }
}
