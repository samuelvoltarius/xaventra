import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RepairActivationController, signRepairValue, type RepairDeploymentDriver, type RepairObservation, type IndependentRepairProbe, type RepairReceipt, type SignedRepairValue } from './repair-activation.js'

export interface HttpRepairProbeProfile {
    id: string; targetId: string; url: string; expectedStatus: number; expectedBodySha256: string
}
/** Immutable operator-owned oracle, evaluated in the controller process rather
 * than the candidate process. Tests of one predicate are not full correctness. */
export function createHttpRepairProbe(profiles: readonly HttpRepairProbeProfile[], driver: RepairDeploymentDriver): IndependentRepairProbe {
    const pinned = structuredClone(profiles)
    return async (probeId, targetId, challenge): Promise<RepairObservation> => {
        const profile = pinned.find(p => p.id === probeId && p.targetId === targetId)
        if (!profile || !/^[a-f0-9]{64}$/.test(profile.expectedBodySha256)) throw new Error('No registered independent predicate')
        const url = new URL(profile.url)
        if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid operator probe URL')
        let state: RepairObservation['state'] = 'unknown', fingerprint = 'unobserved'
        try {
            const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'cache-control': 'no-cache', 'x-xaventra-probe': challenge } })
            if (!response.body) throw new Error('No observable response')
            const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0
            try {
                while (true) { const item = await reader.read(); if (item.done) break
                    size += item.value.length; if (size > 64 * 1024) throw new Error('Probe body exceeds budget')
                    chunks.push(Buffer.from(item.value))
                }
            } finally { await reader.cancel().catch(() => undefined) }
            const digest = createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
            fingerprint = `${response.status}:${digest}`
            state = response.status === profile.expectedStatus && digest === profile.expectedBodySha256 ? 'healthy' : 'fault'
        } catch { /* Transport failure is unknown, not an independently reproduced application fault. */ }
        return { probeId, targetId, challenge, observedAt: Date.now(), releaseId: await driver.currentRelease(targetId), state, fingerprint }
    }
}

/** Embed in a separately installed, operator-owned supervisor. Runtime has only
 * its public key, not the receipt-signing key or access to this state directory. */
export function createRepairControllerServer(options: { stateRoot: string; approvalPublicKey: string; receiptPrivateKey: string;
    driver: RepairDeploymentDriver; probe: IndependentRepairProbe;
    onVerifiedReceipt?(receipt: SignedRepairValue<RepairReceipt>): Promise<void> }) {
    const controller = new RepairActivationController(options.stateRoot, options.approvalPublicKey, options.driver, options.probe)
    return createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/repair') { response.writeHead(404).end(); return }
        let raw = ''
        const timer = setTimeout(() => request.destroy(), 5000)
        try {
            for await (const chunk of request) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('Request too large') }
            clearTimeout(timer)
            const input = JSON.parse(raw)
            const receipt = input.operation === 'activate' ? await controller.activate(input.ticket)
                : input.operation === 'status' && /^repair-[a-f0-9-]{36}$/.test(input.attemptId)
                    ? JSON.parse(readFileSync(join(options.stateRoot, `${input.attemptId}.json`), 'utf8')) : null
            if (!receipt) throw new Error('Invalid operation')
            const signed = signRepairValue<RepairReceipt>(receipt, options.receiptPrivateKey)
            // If reopening fails, keep the immutable recovery evidence and allow
            // status reconciliation. Never repeat activation to release admission.
            if (['resolved', 'rolled-back'].includes(receipt.status)) await options.onVerifiedReceipt?.(signed)
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify(signed))
        } catch { response.writeHead(409).end('Repair request rejected or pending; reconcile signed status') }
        finally { clearTimeout(timer) }
    })
}
