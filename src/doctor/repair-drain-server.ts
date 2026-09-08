import { createServer } from 'node:http'
import { repairHash, signRepairValue, verifyRepairValue, type RepairReceipt, type RepairTicket, type SignedRepairValue } from './repair-activation.js'
import { RepairDrain } from './repair-drain.js'

export interface DrainRequest { actor: string; requestId: string; issuedAt: number; action: 'admit' | 'settle' | 'begin' | 'status' | 'release'; body: any }
export interface DrainServerOptions {
    drain: RepairDrain; privateKey: string; operatorPublicKey: string; receiptPublicKey: string
    nodes: Record<string, { publicKey: string; settledTools: readonly string[] }>
    observers?: Record<string, string>
}
/** Authenticated single-writer coordinator. Pin all members out of band; model
 * output, advertised capabilities and tool names cannot enroll or approve. */
export function createRepairDrainServer(options: DrainServerOptions) {
    options = { ...options, nodes: structuredClone(options.nodes), observers: { ...options.observers } }
    const server = createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/drain') { response.writeHead(404).end(); return }
        const timer = setTimeout(() => request.destroy(), 5000)
        try {
            const chunks: Buffer[] = []; let size = 0
            for await (const chunk of request) { size += chunk.length; if (size > 32 * 1024) throw Error('Drain request exceeds budget'); chunks.push(chunk) }
            const envelope = JSON.parse(Buffer.concat(chunks).toString()) as SignedRepairValue<DrainRequest>
            const actor = envelope.payload?.actor
            const key = actor === 'operator' ? options.operatorPublicKey : options.nodes[actor]?.publicKey || options.observers?.[actor]
            if (!key) throw Error('Unknown drain actor')
            const input = verifyRepairValue(envelope, key), now = Date.now()
            if (!/^[a-f0-9-]{36}$/.test(input.requestId) || !Number.isFinite(input.issuedAt) || input.issuedAt < now - 10_000 || input.issuedAt > now + 1000) throw Error('Stale drain request')
            let value: unknown
            if (input.action === 'admit' && options.nodes[actor]) value = options.drain.admit(actor, input.body.id, input.body.tool, options.nodes[actor].settledTools.includes(input.body.tool))
            else if (input.action === 'settle' && options.nodes[actor]) {
                // Membership policy, not a runtime boolean, bounds completion classification.
                const action = input.body
                options.drain.settle(actor, action.id, action.token, action.epoch, action.certain === true && options.nodes[actor].settledTools.includes(action.tool))
                value = { accepted: true }
            } else if (input.action === 'begin' && actor === 'operator') { options.drain.begin(input.body); value = options.drain.status(input.body) }
            else if (input.action === 'status') value = options.drain.status(input.body)
            else if (input.action === 'release' && actor === 'operator') {
                const receipt = verifyRepairValue<RepairReceipt>(input.body.receipt, options.receiptPublicKey)
                const ticket: RepairTicket = input.body.ticket
                if (repairHash(receipt.binding) !== repairHash(ticket) || !['resolved', 'rolled-back'].includes(receipt.status)
                    || receipt.before?.state !== 'fault'
                    || !receipt.releaseId || !receipt.previousReleaseId || receipt.releaseId === receipt.previousReleaseId
                    || receipt.before.releaseId !== receipt.previousReleaseId
                    || (receipt.status === 'resolved' ? receipt.after?.state !== 'healthy' || receipt.after.releaseId !== receipt.releaseId
                        : receipt.restoration?.state !== 'fault' || receipt.restoration.releaseId !== receipt.previousReleaseId
                            || receipt.restoration.fingerprint !== receipt.before.fingerprint)) throw Error('Independent recovery receipt required to reopen admission')
                options.drain.release(ticket); value = { released: true }
            } else throw Error('Drain action not permitted')
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify(signRepairValue({ requestId: input.requestId, requestHash: repairHash(input), expiresAt: Date.now() + 5000, value }, options.privateKey)))
        } catch { response.writeHead(409).end('Drain request denied or uncertain; do not execute or replay') }
        finally { clearTimeout(timer) }
    })
    server.on('close', () => options.drain.close())
    return server
}
