import { createHash, randomUUID, sign, verify } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export const repairHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
export interface RepairBinding {
    proposalId: string; patchHash: string; baselineHash: string; candidateHash: string
    probeId: string; targetId: string
}
export interface RepairTicket extends RepairBinding { attemptId: string; expiresAt: number }
export interface SignedRepairValue<T> { payload: T; signature: string }
export function signRepairValue<T>(payload: T, privateKey: string): SignedRepairValue<T> {
    return { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') }
}
export function verifyRepairValue<T>(value: SignedRepairValue<T>, publicKey: string): T {
    if (!value || !verify(null, Buffer.from(JSON.stringify(value.payload)), publicKey, Buffer.from(value.signature || '', 'base64'))) {
        throw new Error('Invalid repair signature')
    }
    return value.payload
}
export type ProbeState = 'fault' | 'healthy' | 'unknown'
export interface RepairObservation {
    probeId: string; targetId: string; challenge: string; observedAt: number
    state: ProbeState; fingerprint: string; releaseId: string
}
export interface RepairReceipt {
    binding: RepairTicket; status: 'prepared' | 'activating' | 'verifying' | 'resolved' | 'rolling-back' | 'rolled-back' | 'blocked'
    releaseId?: string; previousReleaseId?: string
    before?: RepairObservation; after?: RepairObservation; restoration?: RepairObservation
    reason?: string; updatedAt: number
}
export interface PreparedRepair {
    releaseId: string; previousReleaseId: string
    /** Deployment controller verifies the signed immutable artifact, including this binding. */
    binding: RepairBinding
}
export interface RepairDeploymentDriver {
    hasAuthority(ticket: RepairTicket): Promise<boolean>
    prepare(ticket: RepairTicket): Promise<PreparedRepair>
    activate(prepared: PreparedRepair, ticket: RepairTicket): Promise<void>
    rollback(prepared: PreparedRepair, ticket: RepairTicket): Promise<void>
    currentRelease(targetId: string): Promise<string>
}
export type IndependentRepairProbe = (probeId: string, targetId: string, challenge: string) => Promise<RepairObservation>

/** Runs OUTSIDE the runtime being replaced, under a separate operator identity.
 * Never executes patch strings, builds on the live checkout, or trusts a model
 * answer / in-process regression assertion as a live recovery observation. */
export class RepairActivationController {
    constructor(private readonly root: string, private readonly approvalPublicKey: string,
        private readonly driver: RepairDeploymentDriver, private readonly probe: IndependentRepairProbe) {}

    async activate(signed: SignedRepairValue<RepairTicket>): Promise<RepairReceipt> {
        const ticket = verifyRepairValue(signed, this.approvalPublicKey)
        if (!/^repair-[a-f0-9-]{36}$/.test(ticket.attemptId) || !ticket.proposalId
            || ![ticket.patchHash, ticket.baselineHash, ticket.candidateHash].every(v => /^[a-f0-9]{64}$/.test(v))
            || !ticket.probeId || !ticket.targetId || ticket.expiresAt < Date.now() || ticket.expiresAt > Date.now() + 10 * 60_000) {
            throw new Error('Invalid or expired PATCH_GATE ticket')
        }
        mkdirSync(this.root, { recursive: true })
        // A crash leaves this lock in place. An operator must reconcile actual
        // runtime identity first; no TTL-based duplicate activation after a crash.
        const lock = join(this.root, 'activation.lock')
        mkdirSync(lock)
        const path = join(this.root, `${ticket.attemptId}.json`)
        let receipt: RepairReceipt = { binding: ticket, status: 'prepared', updatedAt: Date.now() }
        let prepared: PreparedRepair | undefined
        let possiblyChanged = false
        let ownsReceipt = false
        const save = () => { receipt.updatedAt = Date.now(); atomicWriteJsonSync(path, receipt) }
        const authority = async () => {
            if (ticket.expiresAt < Date.now() || !await this.driver.hasAuthority(ticket)) throw new Error('Repair authority lost or ticket expired')
        }
        const observe = async (releaseId: string) => {
            const challenge = randomUUID(), started = Date.now()
            const observation = await this.probe(ticket.probeId, ticket.targetId, challenge)
            if (observation.challenge !== challenge || observation.probeId !== ticket.probeId || observation.targetId !== ticket.targetId
                || observation.releaseId !== releaseId || !observation.fingerprint
                || observation.observedAt < started - 1000 || observation.observedAt > Date.now() + 1000
                || !['fault', 'healthy', 'unknown'].includes(observation.state)) throw new Error('Independent probe binding/freshness mismatch')
            return observation
        }
        try {
            if (existsSync(path)) {
                const prior: RepairReceipt = JSON.parse(readFileSync(path, 'utf8'))
                if (repairHash(prior.binding) !== repairHash(ticket)) throw new Error('Activation replay binding mismatch')
                return prior // Never retry an ambiguous/terminal attempt implicitly.
            }
            ownsReceipt = true; save()
            await authority()
            prepared = await this.driver.prepare(ticket)
            const { attemptId: _id, expiresAt: _expiry, ...binding } = ticket
            if (repairHash(prepared.binding) !== repairHash(binding) || !prepared.releaseId || !prepared.previousReleaseId
                || prepared.releaseId === prepared.previousReleaseId) throw new Error('Prepared release does not match approved patch')
            receipt.releaseId = prepared.releaseId; receipt.previousReleaseId = prepared.previousReleaseId
            if (await this.driver.currentRelease(ticket.targetId) !== prepared.previousReleaseId) throw new Error('Prior release changed')
            receipt.before = await observe(prepared.previousReleaseId)
            if (receipt.before.state !== 'fault') throw new Error('Original live fault was not independently reproduced')
            await authority()
            receipt.status = 'activating'; save(); possiblyChanged = true
            await this.driver.activate(prepared, ticket)
            await authority()
            receipt.status = 'verifying'; save()
            if (await this.driver.currentRelease(ticket.targetId) !== prepared.releaseId) throw new Error('Candidate runtime identity mismatch')
            receipt.after = await observe(prepared.releaseId)
            if (receipt.after.state !== 'healthy') throw new Error('Original live fault remains or recovery is unknown')
            await authority()
            receipt.status = 'resolved'; save()
        } catch (error) {
            if (!ownsReceipt) throw error // Never overwrite an existing receipt on a replay mismatch.
            receipt.reason = String(error).slice(0, 500)
            if (possiblyChanged && prepared) {
                receipt.status = 'rolling-back'; save()
                try {
                    // Driver must use fenced compare-and-swap, including rollback;
                    // lost leadership never authorizes overwriting a newer release.
                    await authority()
                    await this.driver.rollback(prepared, ticket)
                    if (await this.driver.currentRelease(ticket.targetId) !== prepared.previousReleaseId) throw new Error('Rollback runtime identity mismatch')
                    receipt.restoration = await observe(prepared.previousReleaseId)
                    if (receipt.restoration.state !== receipt.before?.state || receipt.restoration.fingerprint !== receipt.before?.fingerprint) {
                        throw new Error('Prior runtime behaviour was not restored')
                    }
                    receipt.status = 'rolled-back'
                } catch (rollbackError) { receipt.status = 'blocked'; receipt.reason += `; rollback unverified: ${String(rollbackError).slice(0, 300)}` }
            } else receipt.status = 'blocked'
            save()
        } finally {
            // Uncertain activation / rollback retains ownership for explicit
            // reconciliation. Never let a second controller guess after failure.
            if (!possiblyChanged || ['resolved', 'rolled-back'].includes(receipt.status)) rmdirSync(lock)
        }
        return receipt
    }
}

/** Operator-configured endpoints only. No URL, key or oracle supplied by models. */
export async function repairRpc<T>(url: string, body: unknown, publicKey: string, timeoutMs = 20_000): Promise<T> {
    return (await repairRpcEnvelope<T>(url, body, publicKey, timeoutMs)).payload
}
export async function repairRpcEnvelope<T>(url: string, body: unknown, publicKey: string, timeoutMs = 20_000): Promise<SignedRepairValue<T>> {
    const parsed = new URL(url)
    if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:'
        && !(parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('Repair RPC requires HTTPS or loopback HTTP')
    const response = await fetch(parsed, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)) })
    if (!response.ok || !response.body) throw new Error('Repair controller/probe unavailable')
    const reader = response.body.getReader(); let text = '', size = 0
    try {
        while (true) { const { done, value } = await reader.read(); if (done) break
            size += value.length; if (size > 128 * 1024) throw new Error('Repair response exceeds budget')
            text += Buffer.from(value).toString('utf8')
        }
    } finally { await reader.cancel().catch(() => undefined) }
    const envelope = JSON.parse(text)
    verifyRepairValue(envelope, publicKey)
    return envelope
}
