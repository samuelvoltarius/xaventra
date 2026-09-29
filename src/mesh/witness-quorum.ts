import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { getLocalNodeId } from './mesh-registry.js'
import type { LeaseDecision } from './leader-election.js'
import type { WitnessDecision } from './quorum-witness.js'
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
    const noteSeen = (decisions: Array<WitnessDecision | null>) => {
        for (const item of decisions) {
            const epoch = Number(item?.epoch || 0)
            if (Number.isSafeInteger(epoch) && epoch > (witnessEpochHighWater.get(service) || 0)) witnessEpochHighWater.set(service, epoch)
        }
    }

    let settled = await ask(witnessEpochHighWater.get(service) || 0)
    noteSeen(settled)
    let valid = settled.filter((item): item is WitnessDecision => item !== null)
    let approvals = valid.filter(item => item.leader && item.holderNodeId === nodeId && item.expiresAt)
    if (approvals.length < 2) {
        const denied = valid.find(item => !item.leader)
        return {
            leader: false, holder: denied?.holderHostname || denied?.holderNodeId, coordinator: 'witness',
            reason: `witness quorum denied: ${approvals.length}/2 approvals (${valid.length}/3 authenticated responses)`,
            heldByOther: Boolean(denied?.holderNodeId && denied.holderNodeId !== nodeId),
        }
    }

    // CL-07: witnesses count independently, so approvals can disagree and a
    // takeover could otherwise yield a LOWER epoch than an earlier term that
    // only a now-unreachable witness knew. The term is max(everything seen),
    // committed back to the approving witnesses before it is used.
    const epoch = Math.max(...approvals.map(item => Number(item.epoch || 0)), witnessEpochHighWater.get(service) || 0)
    if (approvals.some(item => Number(item.epoch) !== epoch)) {
        settled = await ask(epoch)
        noteSeen(settled)
        valid = settled.filter((item): item is WitnessDecision => item !== null)
        approvals = valid.filter(item => item.leader && item.holderNodeId === nodeId && item.expiresAt && Number(item.epoch) === epoch)
        if (approvals.length < 2) {
            return { leader: false, coordinator: 'witness', reason: `witness quorum could not commit epoch ${epoch}: ${approvals.length}/2 approvals` }
        }
    }

    const leaseExpiresAtMs = Math.min(...approvals.map(item => Date.parse(item.expiresAt!)), Date.now() + ttlMs) - 1000
    if (leaseExpiresAtMs <= Date.now()) return { leader: false, coordinator: 'witness', reason: 'witness certificate already expired' }
    return {
        leader: true, epoch, coordinator: 'witness', leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        // Stable per term (no certificate hash): renewals keep the same token.
        fencingToken: `${service}:q${epoch}:${nodeId}`,
        reason: `independent witness quorum acquired (${approvals.length}/3)`,
    }
}

/** Test helper: forget the per-process witness epoch high-water marks. */
export function resetWitnessEpochHighWaterForTests(): void {
    witnessEpochHighWater.clear()
}
