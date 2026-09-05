/**
 * Nova leader election for exclusive services.
 *
 * Supabase is used as a tiny lease registry. Services such as Telegram,
 * WhatsApp and the dashboard should only run on the current main instance.
 * If that instance stops heartbeating, another Nova can acquire the lease.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { getLocalNodeId, type MeshNode } from './mesh-registry.js'
import { recordMainRole } from '../infra/telemetry.js'

type SupabaseConfig = { url: string; key: string }

export type LeaseDecision = {
    leader: boolean
    holder?: string
    reason: string
    epoch?: number
    fencingToken?: string
    leaseExpiresAt?: string
    coordinator?: 'local' | 'supabase' | 'witness'
}

const LEASE_TABLE = 'nova_mesh_leases'
export const MAIN_SERVICE = 'nova-main'
export const MAIN_BOUND_SERVICES = ['telegram', 'whatsapp', 'discord', 'dashboard'] as const
const DEFAULT_LEASE_TTL_MS = 90_000
const renewTimers = new Map<string, ReturnType<typeof setInterval>>()
const takeoverTimers = new Map<string, ReturnType<typeof setInterval>>()
const leadershipTakeoverHandlers = new Map<string, Set<() => Promise<void> | void>>()
const renewalMisses = new Map<string, number>()
const leadershipLostHandlers = new Map<string, Set<() => Promise<void> | void>>()
const localFencingTokens = new Map<string, { epoch: number; token: string }>()
const localLeaseExpiries = new Map<string, number>()
const leaseUnavailableWarnings = new Map<string, { status: number; lastLoggedAt: number; failures: number }>()
const LEASE_WARNING_INTERVAL_MS = 5 * 60_000

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

export function getServiceFencingToken(service: string): { epoch: number; token: string } | null {
    return localFencingTokens.get(service) || null
}

/** Revalidate authority before external side effects; cached fencing tokens
 * alone are insufficient during a coordinator/network partition. */
export async function verifyLiveServiceLeadership(service: string): Promise<boolean> {
    const decision = await acquireServiceLease(service)
    return decision.leader === true && Boolean(decision.epoch && decision.fencingToken)
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

function loadSupabaseConfig(): SupabaseConfig {
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.supabase?.meshUrl && config.supabase?.meshKey) {
                return { url: config.supabase.meshUrl, key: config.supabase.meshKey }
            }
        }
    } catch { /* ignore */ }

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

async function writeLease(params: {
    config: SupabaseConfig
    service: string
    method: 'POST' | 'PATCH'
    previous?: { holder_node_id?: string; expires_at?: string; epoch?: number }
}): Promise<{ ok: boolean; epoch?: number }> {
    const nodeId = getLocalNodeId()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + DEFAULT_LEASE_TTL_MS)
    const sameHolder = params.previous?.holder_node_id === nodeId
    const epoch = params.method === 'POST' ? 1 : sameHolder ? Number(params.previous?.epoch || 1) : Number(params.previous?.epoch || 0) + 1
    const compare = params.previous
        ? `&holder_node_id=eq.${encodeURIComponent(params.previous.holder_node_id || '')}&expires_at=eq.${encodeURIComponent(params.previous.expires_at || '')}`
        : ''
    const path = params.method === 'PATCH'
        ? `${LEASE_TABLE}?service=eq.${encodeURIComponent(params.service)}${compare}`
        : LEASE_TABLE

    const res = await fetch(`${params.config.url}/${path}`, {
        method: params.method,
        headers: {
            ...headers(params.config.key),
            Prefer: 'return=representation',
        },
        body: JSON.stringify({
            service: params.service,
            holder_node_id: nodeId,
            holder_hostname: hostname(),
            lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
            acquired_at: now.toISOString(),
            updated_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            epoch,
        }),
        signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) return { ok: false }
    const rows = await res.json().catch(() => []) as unknown[]
    if (!Array.isArray(rows) || rows.length !== 1) return { ok: false }
    return { ok: true, epoch }
}

async function acquireLeaseTransaction(config: SupabaseConfig, service: string): Promise<LeaseDecision | null> {
    const nodeId = getLocalNodeId()
    try {
        const res = await fetch(`${config.url}/rpc/nova_acquire_service_lease`, {
            method: 'POST', headers: headers(config.key),
            body: JSON.stringify({
                p_service: service, p_holder_node_id: nodeId,
                p_holder_hostname: hostname(), p_ttl_ms: DEFAULT_LEASE_TTL_MS,
            }),
            signal: AbortSignal.timeout(5000),
        })
        if (res.status === 404 || res.status === 400) return null
        if (!res.ok) return { leader: false, reason: `transactional lease RPC failed (${res.status}); split-brain guard` }
        const value = await res.json() as {
            leader?: boolean; holder_node_id?: string; holder_hostname?: string
            epoch?: number; expires_at?: string; reason?: string
        }
        const epoch = Number(value.epoch || 0) || undefined
        const token = value.leader && epoch ? fencingToken(service, epoch, nodeId) : undefined
        if (token && epoch) localFencingTokens.set(service, { epoch, token })
        return {
            leader: value.leader === true,
            holder: value.holder_hostname || value.holder_node_id,
            epoch, fencingToken: token,
            leaseExpiresAt: value.expires_at,
            coordinator: 'supabase',
            reason: value.reason || (value.leader ? 'transactional lease acquired' : `lease held until ${value.expires_at || 'unknown'}`),
        }
    } catch (error) {
        return { leader: false, reason: `transactional lease failed; split-brain guard (${error})` }
    }
}

async function bootstrapLeaseTable(config: SupabaseConfig): Promise<void> {
    console.warn(`[Leader] Lease schema is not current for ${config.url}; apply sql/mesh-coordination-v2.sql with database-admin access.`)
}

export async function acquireServiceLease(service: string): Promise<LeaseDecision> {
    if (service === MAIN_SERVICE && !isMainLeadershipEligible()) {
        return { leader: false, reason: 'node is explicitly main-ineligible (worker-only)' }
    }
    const standbyNode = process.env.NOVA_TELEGRAM_MODE === 'standby'
        || (service === 'telegram' && process.env.NOVA_NODE_ONLY === 'true')
    if (process.env.NOVA_DISABLE_LEADER_ELECTION === 'true') {
        if (standbyNode) {
            return { leader: false, reason: 'standby cannot disable distributed leader election; split-brain guard' }
        }
        return { leader: true, reason: 'leader election disabled', epoch: 1, fencingToken: fencingToken(service, 1), coordinator: 'local' }
    }

    // Coordinator choice is explicit. Nodes must never silently mix a Witness
    // quorum with Supabase because two independent authorities could each elect
    // a leader. Witness mode therefore fails closed when fewer than two votes
    // are available and never falls back to Supabase for that election.
    const { resolveWitnessAuthority, acquireWitnessQuorumLease } = await import('./witness-quorum.js')
    const witnessAuthority = resolveWitnessAuthority(service)
    if (witnessAuthority) {
        const decision = await acquireWitnessQuorumLease(witnessAuthority, DEFAULT_LEASE_TTL_MS)
        if (decision.leader && decision.fencingToken && decision.epoch) {
            localFencingTokens.set(service, { epoch: decision.epoch, token: decision.fencingToken })
            if (decision.leaseExpiresAt) localLeaseExpiries.set(service, Date.parse(decision.leaseExpiresAt))
        }
        return { ...decision, reason: `${decision.reason}; authority=${witnessAuthority}; service=${service}` }
    }

    const config = loadSupabaseConfig()
    if (!config.url || !config.key) {
        if (standbyNode) {
            return { leader: false, reason: 'standby has no distributed coordinator; split-brain guard' }
        }
        const token = fencingToken(service, 1)
        localFencingTokens.set(service, { epoch: 1, token })
        return { leader: true, reason: 'no distributed coordinator configured; local-only leader', epoch: 1, fencingToken: token, coordinator: 'local' }
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
            holder_hostname?: string
            expires_at?: string
            epoch?: number
        }>
        const lease = leases[0]

        if (!lease) {
            const transactional = await acquireLeaseTransaction(config, service)
            if (transactional) return transactional
            const written = await writeLease({ config, service, method: 'POST' })
            if (written.ok) {
                const token = fencingToken(service, written.epoch!)
                localFencingTokens.set(service, { epoch: written.epoch!, token })
            }
            return written.ok
                ? { leader: true, reason: 'new lease acquired', epoch: written.epoch, fencingToken: fencingToken(service, written.epoch!) }
                : { leader: false, reason: 'failed to create lease' }
        }

        // Existing deployments may predate fencing epochs. The migration is
        // additive; if it cannot be applied, the subsequent CAS write fails
        // closed instead of running without a valid fencing token.
        if (lease.epoch === undefined) {
            return { leader: false, holder: lease.holder_hostname ?? lease.holder_node_id, reason: 'lease epoch missing; apply sql/mesh-coordination-v2.sql' }
        }

        if (isExpired(lease.expires_at) && lease.holder_node_id !== nodeId && !(await isPreferredTakeoverCandidate())) {
            return { leader: false, holder: lease.holder_hostname ?? lease.holder_node_id, reason: 'expired lease; stronger standby has takeover priority' }
        }

        if (lease.holder_node_id === nodeId || isExpired(lease.expires_at)) {
            const transactional = await acquireLeaseTransaction(config, service)
            if (transactional) return transactional
            const written = await writeLease({ config, service, method: 'PATCH', previous: lease })
            if (written.ok) {
                const token = fencingToken(service, written.epoch!)
                localFencingTokens.set(service, { epoch: written.epoch!, token })
            }
            return written.ok
                ? { leader: true, reason: lease.holder_node_id === nodeId ? 'lease renewed' : 'expired lease acquired', epoch: written.epoch, fencingToken: fencingToken(service, written.epoch!) }
                : { leader: false, holder: lease.holder_hostname ?? lease.holder_node_id, reason: 'failed to update lease' }
        }

        return {
            leader: false,
            holder: lease.holder_hostname ?? lease.holder_node_id,
            reason: `lease held until ${lease.expires_at}`,
            coordinator: 'supabase',
        }
    } catch (err) {
        return { leader: false, reason: `lease check failed; split-brain guard (${err})` }
    }
}

export async function shouldStartExclusiveService(service: string): Promise<boolean> {
    const decision = await acquireServiceLease(service)
    recordMainRole({ event: decision.leader ? 'lease.acquired' : 'lease.standby', service, leader: decision.leader, coordinator: decision.coordinator })
    if (!decision.leader) {
        console.log(`[Leader] Skipping ${service}; active on ${decision.holder ?? 'another node'} (${decision.reason})`)
        return false
    }
    if (decision.leaseExpiresAt) localLeaseExpiries.set(service, Date.parse(decision.leaseExpiresAt))
    console.log(`[Leader] Starting ${service}: ${decision.reason}`)
    startLeaseRenewal(service)
    return true
}

function startLeaseRenewal(service: string): void {
    if (renewTimers.has(service)) return
    const timer = setInterval(async () => {
        const decision = await acquireServiceLease(service)
        if (decision.leader) {
            recordMainRole({ event: 'lease.renewed', service, leader: true, coordinator: decision.coordinator })
            renewalMisses.set(service, 0)
            if (decision.leaseExpiresAt) localLeaseExpiries.set(service, Date.parse(decision.leaseExpiresAt))
            return
        }
        const misses = (renewalMisses.get(service) || 0) + 1
        renewalMisses.set(service, misses)
        const hardExpiry = localLeaseExpiries.get(service)
        if (misses < 3 && (!hardExpiry || Date.now() < hardExpiry)) return

        clearInterval(timer)
        renewTimers.delete(service)
        renewalMisses.delete(service)
        localFencingTokens.delete(service)
        localLeaseExpiries.delete(service)
        console.warn(`[Leader] Lost ${service} leadership after ${misses} failed renewals`)
        recordMainRole({ event: 'lease.lost', service, leader: false, coordinator: decision.coordinator })
        for (const handler of leadershipLostHandlers.get(service) || []) {
            try { await handler() } catch { /* best effort */ }
        }
    }, Math.max(15_000, Math.floor(DEFAULT_LEASE_TTL_MS / 3)))
    if (timer.unref) timer.unref()
    renewTimers.set(service, timer)
}

export function stopLeaseRenewal(service: string): void {
    const timer = renewTimers.get(service)
    if (!timer) return
    clearInterval(timer)
    renewTimers.delete(service)
    renewalMisses.delete(service)
    localFencingTokens.delete(service)
    localLeaseExpiries.delete(service)
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
