/**
 * Nova leader election for exclusive services.
 *
 * Supabase is used as a tiny lease registry. Services such as Telegram,
 * WhatsApp and the dashboard should only run on the current main instance.
 * If that instance stops heartbeating, another Nova can acquire the lease.
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { getLocalNodeId, type MeshNode } from './mesh-registry.js'
import { recordMainRole } from '../infra/telemetry.js'
import { resolveConfigPath } from '../config/config-path.js'
import { adoptFence, dropFence, getHeldFence, markFenceSuspect, monoNow } from './fence.js'


type SupabaseConfig = { url: string; key: string }

export type LeaseDecision = {
    leader: boolean
    holder?: string
    reason: string
    epoch?: number
    fencingToken?: string
    leaseExpiresAt?: string
    coordinator?: 'local' | 'supabase' | 'witness'
    /** The coordinator positively reported a different current holder. */
    heldByOther?: boolean
    /** Monotonic (performance.now) local deadline; never later than the real expiry. */
    deadlineMono?: number
    /** Lease RPC generation the coordinator answered with (v2 = instance-fenced). */
    protocol?: 'v2' | 'v1'
    /** Server clock at decision time (v2); bounds the deadline without the local wall clock. */
    serverNow?: string
}

const LEASE_TABLE = 'nova_mesh_leases'
export const MAIN_SERVICE = 'nova-main'
export const MAIN_BOUND_SERVICES = ['telegram', 'whatsapp', 'discord', 'dashboard'] as const
const DEFAULT_LEASE_TTL_MS = 90_000
/** Leadership is dropped this long before the locally computed hard expiry. */
export const LEASE_SAFETY_MARGIN_MS = 10_000
const leaseDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
const renewTimers = new Map<string, ReturnType<typeof setInterval>>()
const takeoverTimers = new Map<string, ReturnType<typeof setInterval>>()
const leadershipTakeoverHandlers = new Map<string, Set<() => Promise<void> | void>>()
const renewalMisses = new Map<string, number>()
const leadershipLostHandlers = new Map<string, Set<() => Promise<void> | void>>()
const leaseUnavailableWarnings = new Map<string, { status: number; lastLoggedAt: number; failures: number }>()
const LEASE_WARNING_INTERVAL_MS = 5 * 60_000
/** One id per process start: two processes on one node never share a lease (CL-07). */
const LOCAL_INSTANCE_ID = randomUUID()
let leaseProtocol: 'v2' | 'v1' | null = null
let lastV1Warning = 0
let eventLoopGapTimer: ReturnType<typeof setInterval> | null = null
let eventLoopLastTick = 0
const EVENT_LOOP_PROBE_MS = 1_000

export function getLocalInstanceId(): string {
    return LOCAL_INSTANCE_ID
}

/** Which lease RPC the coordinator answered last: v2 (fencing enforceable) or v1 (legacy). */
export function getLeaseProtocol(): 'v2' | 'v1' | null {
    return leaseProtocol
}

export function noteLeaseUnavailable(
    service: string,
    status: number,
    now = Date.now(),
    intervalMs = LEASE_WARNING_INTERVAL_MS,
): { shouldLog: boolean; failures: number } {
    const previous = leaseUnavailableWarnings.get(service)
    const failures = (previous?.failures || 0) + 1
    const shouldLog = !previous || previous.status !== status || now - previous.lastLoggedAt >= intervalMs
    leaseUnavailableWarnings.set(service, {
        status,
        failures,
        lastLoggedAt: shouldLog ? now : previous.lastLoggedAt,
    })
    return { shouldLog, failures }
}

export function noteLeaseCoordinatorHealthy(service: string): number {
    const previous = leaseUnavailableWarnings.get(service)
    leaseUnavailableWarnings.delete(service)
    return previous?.failures || 0
}

function fencingToken(service: string, epoch: number, nodeId = getLocalNodeId()): string {
    return `${service}:${epoch}:${nodeId}`
}

/** Cached fence of this process; null once the monotonic deadline passed. */
export function getServiceFencingToken(service: string): { epoch: number; token: string } | null {
    const fence = getHeldFence(service)
    return fence ? { epoch: fence.epoch, token: fence.token } : null
}

/**
 * Read-only live check (CL-07): never acquires, renews or takes over a lease.
 * Uses the v5 RPC nova_check_fence; against a v1-only coordinator it reads
 * the lease row instead.
 */
export async function checkLiveFence(service: string): Promise<{ valid: boolean; reason: string }> {
    const fence = getHeldFence(service)
    if (!fence) return { valid: false, reason: 'no lease held by this process' }
    if (fence.coordinator === 'local') return { valid: true, reason: 'single-node lease' }
    // The witness protocol has no read-only endpoint; its local deadline is
    // bounded by the quorum certificate (min expiry - 1 s).
    if (fence.coordinator === 'witness') return { valid: true, reason: 'witness lease within quorum deadline' }
    const configFile = readCoordinatorConfigFile()
    if (configFile.status === 'unreadable') return { valid: false, reason: 'coordinator config unreadable' }
    const config = loadSupabaseConfig(configFile)
    if (!config.url || !config.key) return { valid: false, reason: 'no coordinator configured for live check' }
    try {
        const res = await fetch(`${config.url}/rpc/nova_check_fence`, {
            method: 'POST', headers: headers(config.key),
            body: JSON.stringify({ p_service: service, p_epoch: fence.epoch, p_holder_node_id: fence.nodeId, p_holder_instance_id: fence.instanceId }),
            signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
            const value = await res.json() as { valid?: boolean; epoch?: number }
            return value.valid === true
                ? { valid: true, reason: 'live fence confirmed (nova_check_fence)' }
                : { valid: false, reason: `live fence rejected by coordinator (current epoch ${value.epoch ?? 'none'})` }
        }
        if (res.status !== 404 && res.status !== 400) return { valid: false, reason: `live fence check failed (${res.status})` }
        // v1-only coordinator: read the row, never write it.
        const row = await fetch(`${config.url}/${LEASE_TABLE}?service=eq.${encodeURIComponent(service)}&select=*`, {
            method: 'GET', headers: headers(config.key), signal: AbortSignal.timeout(5000),
        })
        if (!row.ok) return { valid: false, reason: `lease row unreadable (${row.status})` }
        const lease = ((await row.json()) as Array<{ holder_node_id?: string; holder_instance_id?: string | null; epoch?: number; expires_at?: string }>)[0]
        const valid = Boolean(lease && lease.holder_node_id === fence.nodeId && Number(lease.epoch) === fence.epoch
            && (!lease.holder_instance_id || lease.holder_instance_id === fence.instanceId) && !isExpired(lease.expires_at))
        return { valid, reason: valid ? 'live fence confirmed by lease row (v1 coordinator)' : 'lease row does not match this fence (v1 coordinator)' }
    } catch (error) {
        return { valid: false, reason: `live fence check failed (${String(error).slice(0, 160)})` }
    }
}

/** Revalidate authority before external side effects. Read-only (CL-07):
 * a check never has the side effect of an election. */
export async function verifyLiveServiceLeadership(service: string): Promise<boolean> {
    return (await checkLiveFence(service)).valid
}

/** Worker-side check of a Main's fence (node + epoch, any instance). */
export async function checkRemoteFence(service: string, epoch: number, holderNodeId: string): Promise<{ valid: boolean; available: boolean; reason: string }> {
    const configFile = readCoordinatorConfigFile()
    if (configFile.status !== 'ok') return { valid: false, available: false, reason: 'coordinator config unavailable' }
    const config = loadSupabaseConfig(configFile)
    if (!config.url || !config.key) return { valid: false, available: false, reason: 'no Supabase coordinator on this node' }
    try {
        const res = await fetch(`${config.url}/rpc/nova_check_fence`, {
            method: 'POST', headers: headers(config.key),
            body: JSON.stringify({ p_service: service, p_epoch: epoch, p_holder_node_id: holderNodeId, p_holder_instance_id: null }),
            signal: AbortSignal.timeout(5000),
        })
        if (res.status === 404 || res.status === 400) return { valid: false, available: false, reason: 'coordinator lacks nova_check_fence (v5 not applied)' }
        if (!res.ok) return { valid: false, available: true, reason: `remote fence check failed (${res.status})` }
        const value = await res.json() as { valid?: boolean; epoch?: number }
        return value.valid === true
            ? { valid: true, available: true, reason: 'remote fence confirmed' }
            : { valid: false, available: true, reason: `remote fence stale (current epoch ${value.epoch ?? 'none'})` }
    } catch (error) {
        return { valid: false, available: true, reason: `remote fence check failed (${String(error).slice(0, 160)})` }
    }
}

function nodeStrength(node: any): number {
    const hw = node.hardware || {}
    const caps = new Set<string>(node.capabilities || [])
    let score = 0
    score += Number(hw.gpu_vram_mb || 0) / 128
    score += Number(hw.ram_gb || 0) * 4
    score += Number(hw.cores || 0) * 3
    if (hw.gpu || caps.has('gpu') || caps.has('cuda') || caps.has('metal')) score += 300
    if (caps.has('local-llm') || caps.has('ollama') || caps.has('inference-runtime')) score += 150
    if (caps.has('internet')) score += 50
    return score
}

export function isMainLeadershipEligible(env: NodeJS.ProcessEnv = process.env): boolean {
    return String(env.NOVA_MAIN_ELIGIBLE || 'true').toLowerCase() !== 'false'
}

export function selectPreferredTakeoverNode(nodes: MeshNode[], now = Date.now()): PreferredTakeoverNode | null {
    const candidates = nodes
        .filter(node => node.status === 'online' && now - Date.parse(node.last_heartbeat) < 75_000)
        .filter(node => !(node.capabilities || []).includes('main-ineligible'))
        .sort((a, b) => nodeStrength(b) - nodeStrength(a) || String(a.node_id).localeCompare(String(b.node_id)))
    const preferred = candidates[0]
    return preferred ? { nodeId: preferred.node_id, hostname: preferred.hostname, score: nodeStrength(preferred) } : null
}

export interface PreferredTakeoverNode { nodeId: string; hostname?: string; score: number }

/** Deterministic compute/failover preference shared by election and status. */
export async function getPreferredTakeoverNode(): Promise<PreferredTakeoverNode | null> {
    try {
        const { discoverNodes } = await import('./mesh-registry.js')
        return selectPreferredTakeoverNode(await discoverNodes())
    } catch {
        return null
    }
}

/** Only the strongest recently-heartbeating standby may take an expired lease. */
async function isPreferredTakeoverCandidate(): Promise<boolean> {
    const preferred = await getPreferredTakeoverNode()
    return !preferred || preferred.nodeId === getLocalNodeId()
}

type CoordinatorConfigFile =
    | { status: 'ok'; raw: any }
    | { status: 'missing' }
    | { status: 'unreadable'; error: string }

function readCoordinatorConfigFile(): CoordinatorConfigFile {
    let text: string
    try {
        const configPath = resolveConfigPath()
        if (!existsSync(configPath)) return { status: 'missing' }
        text = readFileSync(configPath, 'utf-8')
    } catch (error) { return { status: 'unreadable', error: String(error) } }
    try {
        const raw = JSON.parse(text)
        if (!raw || typeof raw !== 'object') return { status: 'unreadable', error: 'config root is not an object' }
        return { status: 'ok', raw }
    } catch (error) { return { status: 'unreadable', error: String(error) } }
}

/** Local-only leadership needs an explicit single-node declaration; the mere
 * absence of coordinator credentials is not proof that no other Main exists. */
export function configDeclaresSingleNode(raw: any): boolean {
    const mode = String(raw?.mesh?.mode || '').toLowerCase()
    const coordination = String(raw?.mesh?.coordination?.mode || '').toLowerCase()
    return mode === 'standalone' || ['local', 'standalone', 'single-node'].includes(coordination)
}

function loadSupabaseConfig(file: CoordinatorConfigFile = readCoordinatorConfigFile()): SupabaseConfig {
    if (file.status === 'ok' && file.raw.supabase?.meshUrl && file.raw.supabase?.meshKey) {
        return { url: file.raw.supabase.meshUrl, key: file.raw.supabase.meshKey }
    }

    if (process.env.NOVA_MESH_SUPABASE_URL && process.env.NOVA_MESH_SUPABASE_KEY) {
        return {
            url: process.env.NOVA_MESH_SUPABASE_URL,
            key: process.env.NOVA_MESH_SUPABASE_KEY,
        }
    }

    return { url: '', key: '' }
}

function headers(key: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
    }
}

function isExpired(expiresAt?: string): boolean {
    return !expiresAt || new Date(expiresAt).getTime() <= Date.now()
}

function warnV1Coordinator(): void {
    const now = Date.now()
    if (now - lastV1Warning < LEASE_WARNING_INTERVAL_MS) return
    lastV1Warning = now
    console.warn('[Leader] WARNING: coordinator only offers the v1 lease RPC (no process fencing, no read-only check); '
        + 'fencing-enforced gate is false. Apply sql/mesh-coordination-v5.sql with database-admin access.')
}

/** v2 (node + instance) first; a v1-only coordinator keeps working as before
 * with a visible warning. null = neither RPC exists (fail closed upstream). */
async function acquireLeaseTransaction(config: SupabaseConfig, service: string): Promise<LeaseDecision | null> {
    const nodeId = getLocalNodeId()
    try {
        let protocol: 'v2' | 'v1' = 'v2'
        let res = await fetch(`${config.url}/rpc/nova_acquire_service_lease_v2`, {
            method: 'POST', headers: headers(config.key),
            body: JSON.stringify({
                p_service: service, p_holder_node_id: nodeId, p_holder_instance_id: LOCAL_INSTANCE_ID,
                p_holder_hostname: hostname(), p_ttl_ms: DEFAULT_LEASE_TTL_MS,
            }),
            signal: AbortSignal.timeout(5000),
        })
        if (res.status === 404 || res.status === 400) {
            protocol = 'v1'
            res = await fetch(`${config.url}/rpc/nova_acquire_service_lease`, {
                method: 'POST', headers: headers(config.key),
                body: JSON.stringify({
                    p_service: service, p_holder_node_id: nodeId,
                    p_holder_hostname: hostname(), p_ttl_ms: DEFAULT_LEASE_TTL_MS,
                }),
                signal: AbortSignal.timeout(5000),
            })
            if (res.status === 404 || res.status === 400) return null
        }
        if (!res.ok) return { leader: false, reason: `transactional lease RPC failed (${res.status}); split-brain guard` }
        leaseProtocol = protocol
        if (protocol === 'v1') warnV1Coordinator()
        const value = await res.json() as {
            leader?: boolean; holder_node_id?: string; holder_instance_id?: string | null; holder_hostname?: string
            epoch?: number; expires_at?: string; server_now?: string; reason?: string
        }
        const epoch = Number(value.epoch || 0) || undefined
        const token = value.leader && epoch ? fencingToken(service, epoch, nodeId) : undefined
        const otherHolder = Boolean(value.holder_node_id) && (value.holder_node_id !== nodeId
            || (protocol === 'v2' && value.holder_instance_id !== LOCAL_INSTANCE_ID))
        return {
            leader: value.leader === true,
            holder: value.holder_hostname || value.holder_node_id,
            epoch, fencingToken: token,
            leaseExpiresAt: value.expires_at,
            serverNow: value.server_now,
            coordinator: 'supabase',
            protocol,
            reason: value.reason || (value.leader ? 'transactional lease acquired' : `lease held until ${value.expires_at || 'unknown'}`),
            heldByOther: value.leader !== true && otherHolder,
        }
    } catch (error) {
        return { leader: false, reason: `transactional lease failed; split-brain guard (${error})` }
    }
}

async function bootstrapLeaseTable(config: SupabaseConfig): Promise<void> {
    console.warn(`[Leader] Lease schema is not current for ${config.url}; apply sql/mesh-coordination-v2.sql with database-admin access.`)
}

/**
 * Acquire or renew a lease. For distributed coordinators the returned
 * deadline is bounded by (local request start + remaining lease): the
 * coordinator sets its expiry *after* the request started, so the local
 * deadline is never later than the real one. The remaining lease is taken
 * from the server's own clock (expires_at - server_now, v2) where available,
 * and the deadline is kept on the monotonic clock (CL-07), so local wall-clock
 * jumps cannot extend it.
 *
 * This does NOT cache a fencing token. Only the renewal path
 * (shouldStartExclusiveService / watchForServiceLeadership) adopts a fence.
 */
export async function acquireServiceLease(service: string): Promise<LeaseDecision> {
    const requestStartedAt = Date.now()
    const requestStartedMono = monoNow()
    const decision = await acquireServiceLeaseDecision(service)
    if (!decision.leader || decision.coordinator === 'local') return decision
    const reported = decision.leaseExpiresAt ? Date.parse(decision.leaseExpiresAt) : Number.NaN
    const serverNow = decision.serverNow ? Date.parse(decision.serverNow) : Number.NaN
    const reportedRemaining = Number.isFinite(reported)
        ? reported - (Number.isFinite(serverNow) ? serverNow : requestStartedAt)
        : DEFAULT_LEASE_TTL_MS
    const remaining = Math.max(0, Math.min(DEFAULT_LEASE_TTL_MS, reportedRemaining))
    return {
        ...decision,
        leaseExpiresAt: new Date(requestStartedAt + remaining).toISOString(),
        deadlineMono: requestStartedMono + remaining,
    }
}

async function acquireServiceLeaseDecision(service: string): Promise<LeaseDecision> {
    if (service === MAIN_SERVICE && !isMainLeadershipEligible()) {
        return { leader: false, reason: 'node is explicitly main-ineligible (worker-only)' }
    }
    const standbyNode = process.env.NOVA_TELEGRAM_MODE === 'standby'
        || (service === 'telegram' && process.env.NOVA_NODE_ONLY === 'true')
    if (process.env.NOVA_DISABLE_LEADER_ELECTION === 'true') {
        if (standbyNode) {
            return { leader: false, reason: 'standby cannot disable distributed leader election; split-brain guard' }
        }
        const disabledConfig = readCoordinatorConfigFile()
        if (disabledConfig.status === 'unreadable'
            || (disabledConfig.status === 'ok' && String(disabledConfig.raw?.mesh?.mode || '').toLowerCase() === 'ha')) {
            return { leader: false, reason: 'NOVA_DISABLE_LEADER_ELECTION is refused in mesh.mode=ha; split-brain guard' }
        }
        return { leader: true, reason: 'leader election disabled', epoch: 1, fencingToken: fencingToken(service, 1), coordinator: 'local' }
    }

    // An unreadable config hides which coordinator is authoritative (witness,
    // Supabase or single-node). Fail closed instead of guessing.
    const configFile = readCoordinatorConfigFile()
    if (configFile.status === 'unreadable') {
        return { leader: false, reason: `coordinator config unreadable; coordinator unknown, split-brain guard (${configFile.error.slice(0, 160)})` }
    }

    // Coordinator choice is explicit. Nodes must never silently mix a Witness
    // quorum with Supabase because two independent authorities could each elect
    // a leader. Witness mode therefore fails closed when fewer than two votes
    // are available and never falls back to Supabase for that election.
    const { resolveWitnessAuthority, acquireWitnessQuorumLease, witnessModeRequested } = await import('./witness-quorum.js')
    const witnessAuthority = resolveWitnessAuthority(service)
    if (witnessAuthority) {
        const decision = await acquireWitnessQuorumLease(witnessAuthority, DEFAULT_LEASE_TTL_MS)
        return { ...decision, reason: `${decision.reason}; authority=${witnessAuthority}; service=${service}` }
    }

    const config = loadSupabaseConfig(configFile)
    if (!config.url || !config.key) {
        if (standbyNode) {
            return { leader: false, reason: 'standby has no distributed coordinator; split-brain guard' }
        }
        if (witnessModeRequested()) {
            return { leader: false, reason: 'witness coordination configured; local-only leader refused (split-brain guard)', coordinator: 'witness' }
        }
        if (configFile.status !== 'ok' || !configDeclaresSingleNode(configFile.raw)) {
            return { leader: false, reason: 'no distributed coordinator configured and config does not declare single-node (set mesh.mode="standalone"); split-brain guard' }
        }
        const token = fencingToken(service, 1)
        return { leader: true, reason: 'single-node config (mesh.mode=standalone); local-only leader', epoch: 1, fencingToken: token, coordinator: 'local' }
    }

    const nodeId = getLocalNodeId()

    try {
        const res = await fetch(
            `${config.url}/${LEASE_TABLE}?service=eq.${encodeURIComponent(service)}&select=*`,
            {
                method: 'GET',
                headers: headers(config.key),
                signal: AbortSignal.timeout(5000),
            },
        )
        if (!res.ok) {
            if (res.status === 404 || res.status === 400) {
                await bootstrapLeaseTable(config)
            }
            const warning = noteLeaseUnavailable(service, res.status)
            if (warning.shouldLog) {
                console.warn(`[Leader] Lease table unavailable for ${service} (${res.status}); exclusive service remains stopped`
                    + (warning.failures > 1 ? `; ${warning.failures} failed checks` : ''))
            }
            return { leader: false, reason: `lease table unavailable (${res.status}); split-brain guard` }
        }
        const recoveredFailures = noteLeaseCoordinatorHealthy(service)
        if (recoveredFailures > 1) {
            console.log(`[Leader] Lease coordinator recovered for ${service} after ${recoveredFailures} failed checks`)
        }

        const leases = (await res.json()) as Array<{
            holder_node_id?: string
            holder_instance_id?: string | null
            holder_hostname?: string
            expires_at?: string
            epoch?: number
        }>
        const lease = leases[0]

        // CL-07: lease rows are written only by the transactional RPCs. The
        // former REST/CAS writes computed the epoch on the client and could
        // restart it at 1; without an RPC this node fails closed.
        if (!lease) {
            const transactional = await acquireLeaseTransaction(config, service)
            if (transactional) return transactional
            return { leader: false, coordinator: 'supabase', reason: 'lease RPC unavailable (REST lease writes are disabled); apply sql/mesh-coordination-v2.sql and v5; split-brain guard' }
        }

        // Existing deployments may predate fencing epochs. The migration is
        // additive; if it cannot be applied, the node fails closed instead of
        // running without a valid fencing token.
        if (lease.epoch === undefined) {
            return { leader: false, holder: lease.holder_hostname ?? lease.holder_node_id, reason: 'lease epoch missing; apply sql/mesh-coordination-v2.sql' }
        }

        if (isExpired(lease.expires_at) && lease.holder_node_id !== nodeId && !(await isPreferredTakeoverCandidate())) {
            return { leader: false, holder: lease.holder_hostname ?? lease.holder_node_id, reason: 'expired lease; stronger standby has takeover priority', coordinator: 'supabase', heldByOther: true }
        }

        if (lease.holder_node_id === nodeId || isExpired(lease.expires_at)) {
            const transactional = await acquireLeaseTransaction(config, service)
            if (transactional) return transactional
            // Renewal and takeover are decided with server time by the
            // transactional RPC only; REST/CAS lease writes are disabled.
            return {
                leader: false, holder: lease.holder_hostname ?? lease.holder_node_id, coordinator: 'supabase',
                heldByOther: lease.holder_node_id !== nodeId,
                reason: 'renewal/takeover requires the transactional lease RPC (server time); REST/CAS writes disabled, apply sql/mesh-coordination-v2.sql and v5',
            }
        }

        return {
            leader: false,
            holder: lease.holder_hostname ?? lease.holder_node_id,
            reason: `lease held until ${lease.expires_at}`,
            coordinator: 'supabase',
            heldByOther: lease.holder_node_id !== nodeId
                || Boolean(lease.holder_instance_id && lease.holder_instance_id !== LOCAL_INSTANCE_ID),
        }
    } catch (err) {
        return { leader: false, reason: `lease check failed; split-brain guard (${err})` }
    }
}

/** Adopt a decision obtained on the renewal path as this process's fence. */
function adoptLease(service: string, decision: LeaseDecision): void {
    if (!decision.leader || !decision.epoch || !decision.fencingToken) return
    adoptFence({
        service, epoch: decision.epoch, token: decision.fencingToken,
        coordinator: decision.coordinator || 'supabase',
        nodeId: getLocalNodeId(), instanceId: LOCAL_INSTANCE_ID,
        deadlineMono: decision.coordinator === 'local' ? undefined : decision.deadlineMono,
    })
}

export async function shouldStartExclusiveService(service: string): Promise<boolean> {
    const decision = await acquireServiceLease(service)
    recordMainRole({ event: decision.leader ? 'lease.acquired' : 'lease.standby', service, leader: decision.leader, coordinator: decision.coordinator })
    if (!decision.leader) {
        console.log(`[Leader] Skipping ${service}; active on ${decision.holder ?? 'another node'} (${decision.reason})`)
        return false
    }
    adoptLease(service, decision)
    console.log(`[Leader] Starting ${service}: ${decision.reason}`)
    startLeaseRenewal(service)
    return true
}

function clearLeaseDeadline(service: string): void {
    const deadline = leaseDeadlineTimers.get(service)
    if (deadline) clearTimeout(deadline)
    leaseDeadlineTimers.delete(service)
}

/** Drop leadership at hardExpiry - safety margin even if a renewal tick is
 * late or hangs; interval ticks alone cannot guarantee this. The deadline is
 * monotonic (performance.now), so wall-clock jumps cannot move it. */
function armLeaseDeadline(service: string): void {
    clearLeaseDeadline(service)
    const hardExpiry = getHeldFence(service, Number.NEGATIVE_INFINITY)?.deadlineMono
    if (hardExpiry === undefined || !Number.isFinite(hardExpiry)) return
    const delay = Math.max(0, hardExpiry - LEASE_SAFETY_MARGIN_MS - monoNow())
    const timer = setTimeout(() => {
        void relinquishLeadership(service, 'lease deadline reached before a successful renewal')
    }, delay)
    if (timer.unref) timer.unref()
    leaseDeadlineTimers.set(service, timer)
}

/** Synchronous self-fencing: token gone and in-flight work aborted before any
 * await, so nothing scheduled after this point can act on the old term. */
function fenceLocally(service: string, reason: string): boolean {
    const timer = renewTimers.get(service)
    if (timer) clearInterval(timer)
    renewTimers.delete(service)
    clearLeaseDeadline(service)
    renewalMisses.delete(service)
    const hadFence = dropFence(service, reason)
    return hadFence || Boolean(timer)
}

async function relinquishLeadership(service: string, reason: string, coordinator?: LeaseDecision['coordinator']): Promise<void> {
    if (!fenceLocally(service, reason)) return
    console.warn(`[Leader] Lost ${service} leadership: ${reason}`)
    recordMainRole({ event: 'lease.lost', service, leader: false, coordinator })
    for (const handler of leadershipLostHandlers.get(service) || []) {
        try { await handler() } catch { /* best effort */ }
    }
}

/**
 * Event-loop gap watch (CL-07): a pause longer than TTL/2 (GC, swap, SIGSTOP,
 * docker pause, blocking execSync) marks every held fence suspect, so the next
 * effect must pass a live check before it may act.
 */
export function noteEventLoopGap(gapMs: number): string[] {
    if (gapMs <= DEFAULT_LEASE_TTL_MS / 2) return []
    const marked = markFenceSuspect()
    if (marked.length) console.warn(`[Leader] Event loop stalled ${Math.round(gapMs / 1000)}s; live fence check required for ${marked.join(', ')}`)
    return marked
}

function ensureEventLoopGapWatch(): void {
    if (eventLoopGapTimer) return
    eventLoopLastTick = monoNow()
    eventLoopGapTimer = setInterval(() => {
        const now = monoNow()
        const gap = now - eventLoopLastTick - EVENT_LOOP_PROBE_MS
        eventLoopLastTick = now
        if (gap > 0) noteEventLoopGap(gap)
    }, EVENT_LOOP_PROBE_MS)
    if (eventLoopGapTimer.unref) eventLoopGapTimer.unref()
}

function startLeaseRenewal(service: string): void {
    if (renewTimers.has(service)) return
    ensureEventLoopGapWatch()
    const timer = setInterval(async () => {
        const decision = await acquireServiceLease(service)
        if (renewTimers.get(service) !== timer) {
            // Leadership was dropped (deadline/loss) while this tick was in
            // flight; the fence was already dropped synchronously then.
            return
        }
        if (decision.leader) {
            recordMainRole({ event: 'lease.renewed', service, leader: true, coordinator: decision.coordinator })
            renewalMisses.set(service, 0)
            adoptLease(service, decision)
            armLeaseDeadline(service)
            return
        }
        if (decision.heldByOther) {
            await relinquishLeadership(service, `lease is held by ${decision.holder ?? 'another node'} (${decision.reason})`, decision.coordinator)
            return
        }
        const misses = (renewalMisses.get(service) || 0) + 1
        renewalMisses.set(service, misses)
        const hardExpiry = getHeldFence(service, Number.NEGATIVE_INFINITY)?.deadlineMono
        if (misses < 3 && (hardExpiry === undefined || monoNow() < hardExpiry - LEASE_SAFETY_MARGIN_MS)) return
        await relinquishLeadership(service, `${misses} failed renewals (${decision.reason})`, decision.coordinator)
    }, Math.max(15_000, Math.floor(DEFAULT_LEASE_TTL_MS / 3)))
    if (timer.unref) timer.unref()
    renewTimers.set(service, timer)
    armLeaseDeadline(service)
}

/** Stop renewing and ALWAYS forget the cached fence (also for ad-hoc leases). */
export function stopLeaseRenewal(service: string): void {
    fenceLocally(service, 'lease renewal stopped')
}

/** Voluntarily expire an owned Supabase lease so the strongest healthy node
 * can take over immediately. The database verifies holder + epoch in one
 * transaction; there is deliberately no REST/CAS fallback for handover. */
export async function yieldServiceLeadership(service: string): Promise<LeaseDecision> {
    const current = getServiceFencingToken(service)
    if (!current) return { leader: false, reason: 'local node does not hold a fenced lease' }
    const { resolveWitnessAuthority } = await import('./witness-quorum.js')
    if (resolveWitnessAuthority(service)) {
        return { leader: true, reason: 'planned handover is not supported by the configured witness authority; keeping lease', coordinator: 'witness' }
    }
    const config = loadSupabaseConfig()
    if (!config.url || !config.key) {
        return { leader: true, reason: 'planned handover requires a transactional coordinator; keeping local lease', coordinator: 'local' }
    }
    try {
        const response = await fetch(`${config.url}/rpc/nova_release_service_lease`, {
            method: 'POST', headers: headers(config.key),
            body: JSON.stringify({ p_service: service, p_holder_node_id: getLocalNodeId(), p_epoch: current.epoch }),
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) return { leader: true, reason: `planned handover RPC failed (${response.status}); keeping lease`, coordinator: 'supabase' }
        const value = await response.json() as { released?: boolean; reason?: string }
        if (value.released !== true) return { leader: true, reason: value.reason || 'coordinator rejected planned handover', coordinator: 'supabase' }
        stopLeaseRenewal(service)
        recordMainRole({ event: 'lease.yielded', service, leader: false, coordinator: 'supabase' })
        for (const handler of leadershipLostHandlers.get(service) || []) {
            try { await handler() } catch { /* best effort shutdown */ }
        }
        return { leader: false, reason: value.reason || 'lease yielded transactionally', epoch: current.epoch, coordinator: 'supabase' }
    } catch (error) {
        return { leader: true, reason: `planned handover failed; keeping lease (${error})`, coordinator: 'supabase' }
    }
}

export async function yieldMainToPreferredIfSafe(isSafe: () => Promise<boolean> | boolean): Promise<LeaseDecision> {
    const current = getServiceFencingToken(MAIN_SERVICE)
    if (!current) return { leader: false, reason: 'local node is not Main' }
    const preferred = await getPreferredTakeoverNode()
    if (!preferred || preferred.nodeId === getLocalNodeId()) return { leader: true, reason: 'local Main is already the strongest healthy candidate', epoch: current.epoch }
    if (!(await isSafe())) return { leader: true, reason: `handover to ${preferred.hostname || preferred.nodeId} deferred by critical work`, epoch: current.epoch }
    // Release channel leases first so the new Main can reconnect immediately
    // instead of waiting another full TTL after the planned Main handover.
    for (const service of MAIN_BOUND_SERVICES) {
        if (!getServiceFencingToken(service)) continue
        const released = await yieldServiceLeadership(service)
        if (released.leader) {
            return {
                leader: true,
                reason: `handover to ${preferred.hostname || preferred.nodeId} deferred: ${service} lease could not be released (${released.reason})`,
                epoch: current.epoch,
                coordinator: released.coordinator,
            }
        }
    }
    return yieldServiceLeadership(MAIN_SERVICE)
}

/**
 * Graceful shutdown (CL-07): leases are bound to this process instance, so a
 * restarted process cannot renew them. Release them transactionally so the
 * successor (same node or standby) does not wait for the full TTL. Channels
 * and missions first, nova-main last. Best effort; a crash still waits.
 */
export async function releaseHeldLeasesForShutdown(timeoutMs = 5_000): Promise<string[]> {
    const { getFenceStatus } = await import('./fence.js')
    const services = getFenceStatus().held.map(item => item.service)
        .sort((a, b) => Number(a === MAIN_SERVICE) - Number(b === MAIN_SERVICE))
    const released: string[] = []
    const run = (async () => {
        for (const service of services) {
            const decision = await yieldServiceLeadership(service)
            if (!decision.leader) released.push(service)
        }
    })()
    await Promise.race([run, new Promise(resolve => { const t = setTimeout(resolve, timeoutMs); t.unref?.() })])
    for (const service of services) stopLeaseRenewal(service)
    return released
}

export function onLeadershipLost(service: string, handler: () => Promise<void> | void): () => void {
    if (!leadershipLostHandlers.has(service)) leadershipLostHandlers.set(service, new Set())
    leadershipLostHandlers.get(service)!.add(handler)
    return () => leadershipLostHandlers.get(service)?.delete(handler)
}

export function queueLeadershipTakeoverHandler(
    service: string,
    handler: () => Promise<void> | void,
): void {
    if (!leadershipTakeoverHandlers.has(service)) leadershipTakeoverHandlers.set(service, new Set())
    leadershipTakeoverHandlers.get(service)!.add(handler)
}

export function takeLeadershipTakeoverHandlers(service: string): Array<() => Promise<void> | void> {
    const handlers = [...(leadershipTakeoverHandlers.get(service) || [])]
    leadershipTakeoverHandlers.delete(service)
    return handlers
}

/** Keep a standby alive and promote it automatically when the active lease dies. */
export function watchForServiceLeadership(
    service: string,
    onLeadership: () => Promise<void>,
    intervalMs = 15_000,
): void {
    if (service === MAIN_SERVICE && !isMainLeadershipEligible()) return
    // Telegram, mission recovery, updater and Codex continuity share the same
    // nova-main authority. Use one poller, but never discard later handlers.
    queueLeadershipTakeoverHandler(service, onLeadership)
    if (takeoverTimers.has(service)) return
    const timer = setInterval(async () => {
        const decision = await acquireServiceLease(service)
        if (!decision.leader) return
        clearInterval(timer)
        takeoverTimers.delete(service)
        adoptLease(service, decision)
        startLeaseRenewal(service)
        console.log(`[Leader] Taking over ${service}: ${decision.reason}`)
        recordMainRole({ event: 'lease.takeover', service, leader: true, coordinator: decision.coordinator })
        for (const handler of takeLeadershipTakeoverHandlers(service)) {
            try { await handler() } catch (error) {
                console.warn(`[Leader] ${service} takeover handler failed: ${error}`)
            }
        }
    }, intervalMs)
    if (timer.unref) timer.unref()
    takeoverTimers.set(service, timer)
}
