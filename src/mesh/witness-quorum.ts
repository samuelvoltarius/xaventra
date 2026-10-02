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
    return decideQuorumLease({ service, nodeId, ttlMs, witnessCount: 3, ask, label: 'independent witness quorum' })
}

/** One witness vote round: the decisions of all witnesses (null = unreachable/unauthenticated). */
export type WitnessAsk = (proposedEpoch: number) => Promise<Array<WitnessDecision | null>>

/**
 * Majority core shared by the HTTP witness quorum (exactly three witnesses)
 * and the 2.86 succession (one witness per mesh node, e.g. five). A lease is
 * granted only with floor(n/2)+1 approvals, so two holders can never both
 * reach a majority within one TTL.
 */
export async function decideQuorumLease(input: {
    service: string
    nodeId: string
    ttlMs: number
    witnessCount: number
    ask: WitnessAsk
    now?: () => number
    /** Per-node epoch high-water; defaults to this process's map. */
    highWater?: Map<string, number>
    label?: string
}): Promise<LeaseDecision> {
    const { service, nodeId, ttlMs, witnessCount, ask } = input
    const now = input.now || Date.now
    const highWater = input.highWater || witnessEpochHighWater
    const label = input.label || 'witness majority'
    if (!Number.isSafeInteger(witnessCount) || witnessCount < 1) {
        return { leader: false, coordinator: 'witness', reason: 'witness quorum needs at least one witness' }
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
            return { leader: false, coordinator: 'witness', reason: `witness quorum could not commit epoch ${epoch}: ${approvals.length}/${majority} approvals` }
        }
    }

    const leaseExpiresAtMs = Math.min(...approvals.map(item => Date.parse(item.expiresAt!)), now() + ttlMs) - 1000
    if (leaseExpiresAtMs <= now()) return { leader: false, coordinator: 'witness', reason: 'witness certificate already expired' }
    return {
        leader: true, epoch, coordinator: 'witness', leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        // Stable per term (no certificate hash): renewals keep the same token.
        fencingToken: `${service}:q${epoch}:${nodeId}`,
        reason: `${label} acquired (${approvals.length}/${witnessCount})`,
    }
}

/** Signed request/response against one HTTP witness (same auth as the lease path). */
async function witnessRequest<T>(witness: WitnessEndpoint, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
    const serialized = JSON.stringify(body)
    const timestamp = String(Date.now())
    try {
        const response = await fetch(`${witness.url}${path}`, {
            method: 'POST', body: serialized, signal: AbortSignal.timeout(timeoutMs),
            headers: { 'content-type': 'application/json', 'x-nova-timestamp': timestamp, 'x-nova-signature': sign(witness.secret, `${timestamp}.${serialized}`) },
        })
        if (!response.ok || response.headers.get('x-nova-witness-id') !== witness.id) return null
        const responseBody = await response.text()
        if (!equalSignature(response.headers.get('x-nova-signature') || '', sign(witness.secret, responseBody))) return null
        return JSON.parse(responseBody) as T
    } catch { return null }
}

/**
 * Succession witness client over the existing authenticated witness HTTP API
 * (`/v1/lease/acquire|peek|release`). `peek` resolves `undefined` when the
 * witness is unreachable so the caller can count reachable witnesses.
 */
export function createHttpWitnessClient(witness: WitnessEndpoint, timeoutMs = 5000): {
    id: string
    acquire(input: { service: string; nodeId: string; holderHostname: string; ttlMs: number; requestId: string; proposedEpoch: number }): Promise<WitnessDecision | null>
    peek(service: string): Promise<WitnessLease | null | undefined>
    release(input: { service: string; nodeId: string; epoch: number }): Promise<boolean>
} {
    if (!witness.id || !witness.url || witness.secret.length < 16) throw new Error('witness client needs id, url and a secret of at least 16 characters')
    return {
        id: witness.id,
        async acquire(input) {
            const decision = await witnessRequest<WitnessDecision>(witness, '/v1/lease/acquire', { ...input }, timeoutMs)
            return decision && decision.witnessId === witness.id && decision.requestId === input.requestId && decision.service === input.service ? decision : null
        },
        async peek(service) {
            const requestId = randomUUID()
            const reply = await witnessRequest<{ requestId: string; lease: WitnessLease | null }>(witness, '/v1/lease/peek', { service, nodeId: getLocalNodeIdSafe(), requestId }, timeoutMs)
            if (!reply || reply.requestId !== requestId) return undefined
            return reply.lease
        },
        async release(input) {
            const requestId = randomUUID()
            const reply = await witnessRequest<{ requestId: string; released: boolean }>(witness, '/v1/lease/release', { ...input, requestId }, timeoutMs)
            return Boolean(reply && reply.requestId === requestId && reply.released)
        },
    }
}

function getLocalNodeIdSafe(): string {
    try { return getLocalNodeId() } catch { return hostname() }
}

/** Test helper: forget the per-process witness epoch high-water marks. */
export function resetWitnessEpochHighWaterForTests(): void {
    witnessEpochHighWater.clear()
}
