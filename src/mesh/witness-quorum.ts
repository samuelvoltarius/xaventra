import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { getLocalNodeId } from './mesh-registry.js'
import type { LeaseDecision } from './leader-election.js'
import type { WitnessDecision, WitnessLease } from './quorum-witness.js'
import { resolveConfigPath } from '../config/config-path.js'


export interface WitnessEndpoint { id: string; url: string; secret: string }

/** CL-07: highest witness epoch this process has seen per service. */
const witnessEpochHighWater = new Map<string, number>()
export interface WitnessQuorumConfig {
    mode: 'witness'
    witnesses: WitnessEndpoint[]
    timeoutMs?: number
    services?: string[]
    authorityService?: string
}

function sign(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex')
}

function equalSignature(actual: string, expected: string): boolean {
    const left = Buffer.from(actual, 'hex')
    const right = Buffer.from(expected, 'hex')
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export function loadWitnessQuorumConfig(): WitnessQuorumConfig | null {
    try {
        const configPath = resolveConfigPath()
        if (!existsSync(configPath)) return null
        const raw = JSON.parse(readFileSync(configPath, 'utf8')) as any
        const coordination = raw.mesh?.coordination
        if (coordination?.mode !== 'witness') return null
        const witnesses = (coordination.witnesses || []).map((item: any) => ({
            id: String(item.id || ''), url: String(item.url || '').replace(/\/$/, ''),
            secret: String(item.secret || (item.secretEnv ? process.env[item.secretEnv] : '') || ''),
        }))
        return {
            mode: 'witness', witnesses, timeoutMs: Number(coordination.timeoutMs || 5000),
            services: Array.isArray(coordination.services) ? coordination.services.map(String) : undefined,
            authorityService: String(coordination.authorityService || 'nova-main'),
        }
    } catch {
        return { mode: 'witness', witnesses: [] }
    }
}

/** True when witness coordination is configured. Fail-closed: an existing
 * but unreadable/unparsable config counts as "requested", because the node
 * cannot prove that it is *not* supposed to be witness-controlled. */
export function witnessModeRequested(): boolean {
    let raw: string
    try {
        const configPath = resolveConfigPath()
        if (!existsSync(configPath)) return false
        raw = readFileSync(configPath, 'utf8')
    } catch { return true }
    try { return JSON.parse(raw)?.mesh?.coordination?.mode === 'witness' } catch { return true }
}

/** Resolve an exclusive runtime service onto one shared main authority.
 * The authority service itself (default `nova-main`) is always
 * witness-controlled in witness mode, even if `services` omits it.
 * Mesh task leases intentionally remain on Supabase because its task RPCs
 * validate Supabase fencing epochs, not Witness quorum certificates. */
export function resolveWitnessAuthority(service: string): string | null {
    const config = loadWitnessQuorumConfig()
    if (!config) return null
    const authority = config.authorityService || 'nova-main'
    if (service === authority) return authority
    const governed = new Set(config.services || ['telegram', 'whatsapp', 'discord', 'dashboard'])
    return governed.has(service) ? authority : null
}

export async function acquireWitnessQuorumLease(
    service: string,
    ttlMs: number,
    config = loadWitnessQuorumConfig(),
    nodeId = getLocalNodeId(),
): Promise<LeaseDecision> {
    if (!config) return { leader: false, reason: 'witness quorum is not configured', coordinator: 'witness' }
    const uniqueIds = new Set(config.witnesses.map(item => item.id))
    const uniqueUrls = new Set(config.witnesses.map(item => item.url))
    if (config.witnesses.length !== 3 || uniqueIds.size !== 3 || uniqueUrls.size !== 3
        || config.witnesses.some(item => !item.id || !item.url || item.secret.length < 16)) {
        return { leader: false, reason: 'witness mode requires exactly three independent, uniquely identified endpoints with secrets', coordinator: 'witness' }
    }

    const ask = (proposedEpoch: number) => {
        const requestId = randomUUID()
        const requestBody = JSON.stringify({ service, nodeId, holderHostname: hostname(), ttlMs, requestId, proposedEpoch })
        return Promise.all(config.witnesses.map(async witness => {
            const timestamp = String(Date.now())
            try {
                const response = await fetch(`${witness.url}/v1/lease/acquire`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json', 'x-nova-timestamp': timestamp,
                        'x-nova-signature': sign(witness.secret, `${timestamp}.${requestBody}`),
                    },
                    body: requestBody, signal: AbortSignal.timeout(config.timeoutMs || 5000),
                })
                if (!response.ok) return null
                const responseBody = await response.text()
                if (!equalSignature(response.headers.get('x-nova-signature') || '', sign(witness.secret, responseBody))) return null
                const decision = JSON.parse(responseBody) as WitnessDecision
                if (decision.witnessId !== witness.id || decision.requestId !== requestId || decision.service !== service) return null
                return decision
            } catch { return null }
        }))
    }
    return decideWitnessQuorum({ service, nodeId, ttlMs, witnessCount: config.witnesses.length, ask, label: 'independent witness quorum' })
}

/** One witness vote round: every witness's decision (null = unreachable/unauthenticated). */
export type WitnessAsk = (proposedEpoch: number) => Promise<Array<WitnessDecision | null>>

/**
 * Majority core of the witness lease (CL-07 epochs). Shared by the HTTP
 * quorum above and the 2.88 succession simulation. A lease needs
 * floor(n/2)+1 approvals, so two holders never both reach a majority within
 * one TTL. `quorumReachable` says whether enough witnesses answered at all:
 * false means "no majority reachable" (safe mode), not "held by another".
 */
export async function decideWitnessQuorum(input: {
    service: string
    nodeId: string
    ttlMs: number
    witnessCount: number
    ask: WitnessAsk
    now?: () => number
    /** Epoch high-water per service; defaults to this process's map. */
    highWater?: Map<string, number>
    label?: string
}): Promise<LeaseDecision> {
    const { service, nodeId, ttlMs, witnessCount, ask } = input
    const now = input.now || Date.now
    const highWater = input.highWater || witnessEpochHighWater
    const label = input.label || 'witness majority'
    if (!Number.isSafeInteger(witnessCount) || witnessCount < 1) {
        return { leader: false, coordinator: 'witness', quorumReachable: false, reason: 'witness quorum needs at least one witness' }
    }
    const majority = Math.floor(witnessCount / 2) + 1
    const noteSeen = (decisions: Array<WitnessDecision | null>) => {
        for (const item of decisions) {
            const epoch = Number(item?.epoch || 0)
            if (Number.isSafeInteger(epoch) && epoch > (highWater.get(service) || 0)) highWater.set(service, epoch)
        }
    }

    let settled = await ask(highWater.get(service) || 0)
    noteSeen(settled)
    let valid = settled.filter((item): item is WitnessDecision => item !== null)
    let approvals = valid.filter(item => item.leader && item.holderNodeId === nodeId && item.expiresAt)
    if (approvals.length < majority) {
        const denied = valid.find(item => !item.leader)
        return {
            leader: false, holder: denied?.holderHostname || denied?.holderNodeId, coordinator: 'witness',
            quorumReachable: valid.length >= majority,
            reason: `witness quorum denied: ${approvals.length}/${majority} approvals (${valid.length}/${witnessCount} authenticated responses)`,
            heldByOther: Boolean(denied?.holderNodeId && denied.holderNodeId !== nodeId),
        }
    }

    // CL-07: witnesses count independently, so approvals can disagree and a
    // takeover could otherwise yield a LOWER epoch than an earlier term that
    // only a now-unreachable witness knew. The term is max(everything seen),
    // committed back to the approving witnesses before it is used.
    const epoch = Math.max(...approvals.map(item => Number(item.epoch || 0)), highWater.get(service) || 0)
    if (approvals.some(item => Number(item.epoch) !== epoch)) {
        settled = await ask(epoch)
        noteSeen(settled)
        valid = settled.filter((item): item is WitnessDecision => item !== null)
        approvals = valid.filter(item => item.leader && item.holderNodeId === nodeId && item.expiresAt && Number(item.epoch) === epoch)
        if (approvals.length < majority) {
            return { leader: false, coordinator: 'witness', quorumReachable: valid.length >= majority, reason: `witness quorum could not commit epoch ${epoch}: ${approvals.length}/${majority} approvals` }
        }
    }

    const leaseExpiresAtMs = Math.min(...approvals.map(item => Date.parse(item.expiresAt!)), now() + ttlMs) - 1000
    if (leaseExpiresAtMs <= now()) return { leader: false, coordinator: 'witness', quorumReachable: true, reason: 'witness certificate already expired' }
    return {
        leader: true, epoch, coordinator: 'witness', quorumReachable: true, leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        // Stable per term (no certificate hash): renewals keep the same token.
        fencingToken: `${service}:q${epoch}:${nodeId}`,
        reason: `${label} acquired (${approvals.length}/${witnessCount})`,
    }
}

/**
 * 2.88 succession: the next term must be strictly above every epoch the
 * replicated Main journal has seen (including an owner-confirmed emergency
 * term the witnesses never knew). Raises the proposal floor; never lowers it.
 */
export function raiseWitnessEpochFloor(service: string, minEpoch: number): number {
    if (!Number.isSafeInteger(minEpoch) || minEpoch < 1) return witnessEpochHighWater.get(service) || 0
    const next = Math.max(witnessEpochHighWater.get(service) || 0, minEpoch)
    witnessEpochHighWater.set(service, next)
    return next
}

export function getWitnessEpochHighWater(service: string): number {
    return witnessEpochHighWater.get(service) || 0
}

export interface WitnessQuorumView {
    /** Witnesses that answered authenticated. */
    reachable: number
    total: number
    majority: number
    /** Live holder confirmed by a majority of witnesses (same node + epoch). */
    holder?: { nodeId: string; epoch: number; expiresAt: string }
}

/** Majority view over read-only peeks (`undefined` = witness unreachable). */
export function summarizeWitnessPeeks(peeks: Array<WitnessLease | null | undefined>, now = Date.now()): WitnessQuorumView {
    const total = peeks.length
    const majority = Math.floor(total / 2) + 1
    const answered = peeks.filter(item => item !== undefined) as Array<WitnessLease | null>
    const counts = new Map<string, { nodeId: string; epoch: number; expiresAt: string; votes: number }>()
    for (const lease of answered) {
        if (!lease || Date.parse(lease.expiresAt) <= now) continue
        const key = `${lease.holderNodeId}|${lease.epoch}`
        const entry = counts.get(key) || { nodeId: lease.holderNodeId, epoch: lease.epoch, expiresAt: lease.expiresAt, votes: 0 }
        entry.votes++
        if (Date.parse(lease.expiresAt) < Date.parse(entry.expiresAt)) entry.expiresAt = lease.expiresAt
        counts.set(key, entry)
    }
    const winner = [...counts.values()].find(item => item.votes >= majority)
    return {
        reachable: answered.length, total, majority,
        holder: winner ? { nodeId: winner.nodeId, epoch: winner.epoch, expiresAt: winner.expiresAt } : undefined,
    }
}

/** Read-only quorum view over the configured HTTP witnesses (never acquires). */
export async function peekWitnessQuorum(service: string, config = loadWitnessQuorumConfig()): Promise<WitnessQuorumView | null> {
    if (!config || !config.witnesses.length) return null
    let nodeId: string
    try { nodeId = getLocalNodeId() } catch { nodeId = hostname() }
    const peeks = await Promise.all(config.witnesses.map(async witness => {
        if (!witness.url || witness.secret.length < 16) return undefined
        const requestId = randomUUID()
        const body = JSON.stringify({ service, nodeId, requestId })
        const timestamp = String(Date.now())
        try {
            const response = await fetch(`${witness.url}/v1/lease/peek`, {
                method: 'POST', body, signal: AbortSignal.timeout(config.timeoutMs || 5000),
                headers: { 'content-type': 'application/json', 'x-nova-timestamp': timestamp, 'x-nova-signature': sign(witness.secret, `${timestamp}.${body}`) },
            })
            if (!response.ok) return undefined
            const text = await response.text()
            if (!equalSignature(response.headers.get('x-nova-signature') || '', sign(witness.secret, text))) return undefined
            const reply = JSON.parse(text) as { requestId?: string; witnessId?: string; lease?: WitnessLease | null }
            if (reply.requestId !== requestId || reply.witnessId !== witness.id) return undefined
            return reply.lease ?? null
        } catch { return undefined }
    }))
    return summarizeWitnessPeeks(peeks)
}

/** Test helper: forget the per-process witness epoch high-water marks. */
export function resetWitnessEpochHighWaterForTests(): void {
    witnessEpochHighWater.clear()
}
