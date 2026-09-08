import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { repairHash, repairRpc, signRepairValue } from './repair-activation.js'
import type { DrainAction } from './repair-drain.js'
import type { DrainRequest } from './repair-drain-server.js'

export interface DrainClientConfig { url: string; actor: string; privateKey: string; authorityPublicKey: string }
export class RepairDrainClient {
    constructor(private readonly config: DrainClientConfig) { this.config = Object.freeze({ ...config }) }
    async request(action: DrainRequest['action'], body: unknown): Promise<any> {
        const payload: DrainRequest = { actor: this.config.actor, requestId: randomUUID(), issuedAt: Date.now(), action, body }
        const reply: any = await repairRpc(this.config.url, signRepairValue(payload, this.config.privateKey), this.config.authorityPublicKey, 10_000)
        if (reply.requestId !== payload.requestId || reply.requestHash !== repairHash(payload) || reply.expiresAt <= Date.now() || reply.expiresAt > Date.now() + 10_000) throw Error('Drain response binding/freshness mismatch')
        return reply.value
    }
    async execute<T>(tool: string, completionBounded: boolean, execute: () => Promise<T>): Promise<T> {
        const id = randomUUID()
        const permit: DrainAction = await this.request('admit', { id, tool })
        if (permit.id !== id || permit.actor !== this.config.actor || permit.tool !== tool || permit.state !== 'running'
            || !/^[a-f0-9-]{36}$/.test(permit.token) || !Number.isSafeInteger(permit.epoch) || permit.epoch < 1) throw Error('Invalid action permit')
        // Do not race this await against the caller's UI timeout. A late-running
        // operation must remain in the independent ledger until it really settles.
        try { return await execute() }
        finally { await this.request('settle', { ...permit, certain: completionBounded }) }
    }
}
let configured: { path: string; client: RepairDrainClient } | undefined
/** Opt-in per-node local config. Contains node authentication only, never the
 * operator or receipt signing key. Missing/broken configured service fails closed. */
export function getRepairDrainClient(): RepairDrainClient | undefined {
    const path = process.env.XAVENTRA_REPAIR_DRAIN_CLIENT_FILE
    if (!path) return undefined
    if (configured?.path !== path) configured = { path, client: new RepairDrainClient(JSON.parse(readFileSync(path, 'utf8'))) }
    return configured.client
}
export async function withRepairAdmission<T>(tool: string, bounded: boolean, execute: () => Promise<T>): Promise<T> {
    const client = getRepairDrainClient()
    return client ? client.execute(tool, bounded, execute) : execute()
}
