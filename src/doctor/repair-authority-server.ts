import { createServer } from 'node:http'
import { repairHash, signRepairValue, type RepairBinding, type RepairTicket } from './repair-activation.js'

export interface RepairOperatorGrant {
    binding: RepairBinding; expiresAt: number; holderNodeId: string; leaseEpoch: number
    /** Optional fresh evidence from the deployment's drain/writer-fencing owner.
     * An empty task list alone is not proof that future external writes are fenced. */
    quiescence?: { bindingHash: string; verifiedAt: number; expiresAt: number; externalWritersQuiesced: true }
}
export interface RepairAuthorityOptions {
    privateKey: string
    readGrant(patchHash: string): RepairOperatorGrant | undefined
    readLease(): Promise<{ holderNodeId: string; epoch: number; expiresAt: number } | undefined>
    readToolDrain?(ticket: RepairTicket): Promise<{ bindingHash: string; toolActionsDrained: boolean }>
}
/** Separate operator-owned signing service. A model, runtime identity or merely
 * healthy process does not grant permission. No lease acquisition or takeover. */
export function createRepairAuthorityServer(options: RepairAuthorityOptions) {
    return createServer(async (request, response) => {
        if (request.method !== 'POST' || !['/authority', '/state'].includes(request.url || '')) { response.writeHead(404).end(); return }
        const timer = setTimeout(() => request.destroy(), 5000)
        try {
            let raw = ''
            for await (const chunk of request) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('Authority input budget') }
            clearTimeout(timer)
            const { challenge, ticket } = JSON.parse(raw) as { challenge: string; ticket: RepairTicket }
            if (!/^[a-f0-9-]{36}$/.test(challenge) || !/^[a-f0-9]{64}$/.test(ticket?.patchHash || '')
                || !/^repair-[a-f0-9-]{36}$/.test(ticket.attemptId)) throw new Error('Invalid authority request')
            const { attemptId: _id, expiresAt: _expiry, ...binding } = ticket
            // Drain RPC may take seconds. Read the lease/grant AFTER it and check
            // freshness at signing time, never reuse pre-await authorization.
            const drain = request.url === '/state' ? await options.readToolDrain?.(ticket) : undefined
            const lease = await options.readLease(), grant = options.readGrant(ticket.patchHash), now = Date.now()
            const allowed = Boolean(grant && lease && repairHash(binding) === repairHash(grant.binding)
                && grant.expiresAt > now && grant.expiresAt <= now + 10 * 60_000 && ticket.expiresAt > now
                && lease.holderNodeId === grant.holderNodeId && Number.isSafeInteger(lease.epoch) && lease.epoch === grant.leaseEpoch
                && lease.expiresAt > now + 5000)
            const q = grant?.quiescence
            const quiesced = allowed && q?.externalWritersQuiesced === true && q.bindingHash === repairHash(ticket)
                && q.verifiedAt >= now - 15_000 && q.verifiedAt <= now && q.expiresAt > now && q.expiresAt <= now + 30_000
                && drain?.bindingHash === repairHash(ticket) && drain.toolActionsDrained === true
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify(signRepairValue({ challenge, targetId: ticket.targetId, patchHash: ticket.patchHash,
                bindingHash: repairHash(ticket), allowed: request.url === '/state' ? Boolean(quiesced) : allowed,
                externalWritersQuiesced: Boolean(quiesced), expiresAt: Math.min(now + 10_000, lease?.expiresAt || now,
                    grant?.expiresAt || now, ticket.expiresAt || now, request.url === '/state' ? q?.expiresAt || now : Infinity) }, options.privateKey)))
        } catch { response.writeHead(409).end('Repair authority unavailable or invalid') }
        finally { clearTimeout(timer) }
    })
}
