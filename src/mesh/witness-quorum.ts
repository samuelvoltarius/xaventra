import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { getLocalNodeId } from './mesh-registry.js'
import type { LeaseDecision } from './leader-election.js'
import type { WitnessDecision } from './quorum-witness.js'

export interface WitnessEndpoint { id: string; url: string; secret: string }
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
        const configPath = join(process.cwd(), 'nova.config.json')
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

export function witnessModeRequested(): boolean {
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (!existsSync(configPath)) return false
        return JSON.parse(readFileSync(configPath, 'utf8'))?.mesh?.coordination?.mode === 'witness'
    } catch { return false }
}

/** Resolve an exclusive runtime service onto one shared main authority.
 * Mesh task leases intentionally remain on Supabase because its task RPCs
 * validate Supabase fencing epochs, not Witness quorum certificates. */
export function resolveWitnessAuthority(service: string): string | null {
    const config = loadWitnessQuorumConfig()
    if (!config) return null
    const governed = new Set(config.services || ['telegram', 'whatsapp', 'discord', 'dashboard'])
    return governed.has(service) ? (config.authorityService || 'nova-main') : null
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

    const requestId = randomUUID()
    const requestBody = JSON.stringify({ service, nodeId, holderHostname: hostname(), ttlMs, requestId })
    const settled = await Promise.all(config.witnesses.map(async witness => {
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

    const valid = settled.filter((item): item is WitnessDecision => item !== null)
    const approvals = valid.filter(item => item.leader && item.holderNodeId === nodeId && item.expiresAt)
    if (approvals.length < 2) {
        const denied = valid.find(item => !item.leader)
        return {
            leader: false, holder: denied?.holderHostname || denied?.holderNodeId, coordinator: 'witness',
            reason: `witness quorum denied: ${approvals.length}/2 approvals (${valid.length}/3 authenticated responses)`,
        }
    }

    const leaseExpiresAtMs = Math.min(...approvals.map(item => Date.parse(item.expiresAt!)), Date.now() + ttlMs) - 1000
    if (leaseExpiresAtMs <= Date.now()) return { leader: false, coordinator: 'witness', reason: 'witness certificate already expired' }
    const certificate = approvals.sort((a, b) => a.witnessId.localeCompare(b.witnessId))
        .map(item => `${item.witnessId}:${item.epoch}:${item.expiresAt}:${item.requestId}`).join('|')
    const epoch = Math.max(...approvals.map(item => Number(item.epoch || 0)))
    return {
        leader: true, epoch, coordinator: 'witness', leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        fencingToken: `${service}:q${epoch}:${createHash('sha256').update(certificate).digest('hex')}`,
        reason: `independent witness quorum acquired (${approvals.length}/3)`,
    }
}
