import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export interface WitnessLease {
    service: string
    holderNodeId: string
    holderHostname: string
    epoch: number
    expiresAt: string
    updatedAt: string
}

interface WitnessState { leases: Record<string, WitnessLease> }

export interface WitnessDecision {
    witnessId: string
    leader: boolean
    service: string
    holderNodeId?: string
    holderHostname?: string
    epoch?: number
    expiresAt?: string
    requestId: string
    reason: string
}

export class QuorumWitnessStore {
    private state: WitnessState = { leases: {} }

    constructor(readonly witnessId: string, private readonly file: string) {
        try {
            if (existsSync(file)) this.state = JSON.parse(readFileSync(file, 'utf8')) as WitnessState
        } catch {
            this.state = { leases: {} }
        }
    }

    acquire(input: { service: string; nodeId: string; holderHostname: string; ttlMs: number; requestId: string }, now = Date.now()): WitnessDecision {
        const current = this.state.leases[input.service]
        const expired = !current || Date.parse(current.expiresAt) <= now
        if (current && !expired && current.holderNodeId !== input.nodeId) {
            return {
                witnessId: this.witnessId, leader: false, service: input.service,
                holderNodeId: current.holderNodeId, holderHostname: current.holderHostname,
                epoch: current.epoch, expiresAt: current.expiresAt, requestId: input.requestId,
                reason: 'lease held by another node',
            }
        }

        const epoch = !current ? 1 : current.holderNodeId === input.nodeId ? current.epoch : current.epoch + 1
        const lease: WitnessLease = {
            service: input.service, holderNodeId: input.nodeId, holderHostname: input.holderHostname, epoch,
            expiresAt: new Date(now + Math.max(100, Math.min(input.ttlMs, 5 * 60_000))).toISOString(),
            updatedAt: new Date(now).toISOString(),
        }
        this.state.leases[input.service] = lease
        atomicWriteJsonSync(this.file, this.state)
        return {
            witnessId: this.witnessId, leader: true, service: input.service,
            holderNodeId: lease.holderNodeId, holderHostname: lease.holderHostname,
            epoch: lease.epoch, expiresAt: lease.expiresAt, requestId: input.requestId,
            reason: current ? 'lease renewed or acquired after expiry' : 'new lease acquired',
        }
    }
}

function signature(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex')
}

function signaturesEqual(actual: string, expected: string): boolean {
    const left = Buffer.from(actual, 'hex')
    const right = Buffer.from(expected, 'hex')
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export function createQuorumWitnessServer(options: {
    witnessId: string; secret: string; stateFile: string; host?: string; port?: number
}): { server: Server; store: QuorumWitnessStore; listen: () => Promise<number> } {
    if (!options.witnessId || options.secret.length < 16) throw new Error('Witness id and a secret of at least 16 characters are required')
    const store = new QuorumWitnessStore(options.witnessId, options.stateFile)
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, witnessId: options.witnessId }))
            return
        }
        if (req.method !== 'POST' || req.url !== '/v1/lease/acquire') {
            res.writeHead(404).end()
            return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString('utf8')
        const timestamp = String(req.headers['x-nova-timestamp'] || '')
        const requestSignature = String(req.headers['x-nova-signature'] || '')
        const timestampMs = Number(timestamp)
        if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 30_000
            || !signaturesEqual(requestSignature, signature(options.secret, `${timestamp}.${body}`))) {
            res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid witness authentication' }))
            return
        }

        try {
            const input = JSON.parse(body) as Record<string, unknown>
            if (!input.service || !input.nodeId || !input.requestId || !input.holderHostname) throw new Error('missing required lease fields')
            const decision = store.acquire({
                service: String(input.service), nodeId: String(input.nodeId), holderHostname: String(input.holderHostname),
                ttlMs: Number(input.ttlMs || 90_000), requestId: String(input.requestId),
            })
            const responseBody = JSON.stringify(decision)
            res.writeHead(200, {
                'content-type': 'application/json', 'x-nova-witness-id': options.witnessId,
                'x-nova-signature': signature(options.secret, responseBody),
            })
            res.end(responseBody)
        } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
        }
    })

    return {
        server, store,
        listen: () => new Promise((resolveListen, reject) => {
            server.once('error', reject)
            server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
                server.off('error', reject)
                const address = server.address()
                resolveListen(typeof address === 'object' && address ? address.port : Number(options.port || 0))
            })
        }),
    }
}

async function main(): Promise<void> {
    const witnessId = process.env.NOVA_WITNESS_ID || hostname()
    const secret = process.env.NOVA_WITNESS_SECRET || ''
    const port = Number(process.env.NOVA_WITNESS_PORT || 9191)
    const stateFile = process.env.NOVA_WITNESS_STATE_FILE || join(process.cwd(), '.nova-data', 'witness', `${witnessId}.json`)
    const instance = createQuorumWitnessServer({ witnessId, secret, stateFile, host: process.env.NOVA_WITNESS_HOST || '0.0.0.0', port })
    await instance.listen()
    console.log(`[Witness] ${witnessId} listening on ${port}; state=${dirname(stateFile)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    void main().catch(error => { console.error(error); process.exitCode = 1 })
}
