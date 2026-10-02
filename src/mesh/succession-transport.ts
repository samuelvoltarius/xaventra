/**
 * 2.86 package K — succession over the existing signed mesh channel.
 *
 * Requests travel as `succession.request` envelopes (Ed25519-signed by the
 * sender's mesh identity, replay-guarded, principal role `system` only — a
 * peer must be configured with that role, otherwise the policy rejects it).
 * Replies use the normal `run.result` path. A node without a registered
 * endpoint answers "succession not active" (fail closed, default today).
 */

import { randomUUID } from 'node:crypto'
import type { JournalAck, JournalMessage, JournalReplica, ReplicaExport } from './state-journal.js'
import type { ShareHolder, ShareRelease, ShareRequest } from './secret-shares.js'
import type { EmergencyCodeRecord, EmergencyReleaseGate } from './emergency-release.js'
import type { SuccessionPeer } from './succession.js'

export type SuccessionOp = 'journal' | 'export' | 'share' | 'emergency-record' | 'yield'
const OPS = new Set<SuccessionOp>(['journal', 'export', 'share', 'emergency-record', 'yield'])

export interface SuccessionRequestPayload {
    op: SuccessionOp
    body?: unknown
    idempotencyKey: string
}

export interface SuccessionEndpoint {
    replica: JournalReplica
    shareHolder?: ShareHolder
    emergencyGate?: EmergencyReleaseGate
    /** Steps down an emergency Main after checking the majority itself. */
    yieldEmergency?: (reason: string) => Promise<boolean>
}

let endpoint: SuccessionEndpoint | null = null

export function registerSuccessionEndpoint(next: SuccessionEndpoint | null): void {
    endpoint = next
}

export async function handleSuccessionRequest(payload: unknown, sourceNode: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const request = payload as Partial<SuccessionRequestPayload>
    if (!request || typeof request !== 'object' || !OPS.has(request.op as SuccessionOp) || typeof request.idempotencyKey !== 'string') {
        return { success: false, error: 'invalid succession request' }
    }
    if (!endpoint) return { success: false, error: 'succession not active on this node' }
    try {
        switch (request.op) {
            case 'journal': return { success: true, result: endpoint.replica.receive(request.body as JournalMessage) }
            case 'export': return { success: true, result: endpoint.replica.export() }
            case 'share': {
                const share = request.body as ShareRequest
                // The verified envelope sender is the only possible requester.
                if (!endpoint.shareHolder || !share || share.requester !== sourceNode) return { success: false, error: 'share request refused' }
                return { success: true, result: await endpoint.shareHolder.release(share) }
            }
            case 'emergency-record': {
                const record = request.body as EmergencyCodeRecord
                if (!endpoint.emergencyGate || !record || record.nodeId !== sourceNode) return { success: false, error: 'emergency record refused' }
                endpoint.emergencyGate.register(record)
                return { success: true, result: true }
            }
            case 'yield':
                return { success: true, result: endpoint.yieldEmergency ? await endpoint.yieldEmergency(`requested by ${sourceNode}`) : false }
        }
    } catch (error) {
        return { success: false, error: String(error).slice(0, 300) }
    }
    return { success: false, error: 'unsupported succession operation' }
}

export type SuccessionSend = (targetNode: string, payload: SuccessionRequestPayload, timeoutMs: number) => Promise<{ success: boolean; result?: unknown } | undefined>

/** Default sender: signed `succession.request` envelope + wait for the `run.result`. */
export const sendOverMesh: SuccessionSend = async (targetNode, payload, timeoutMs) => {
    const runtime = await import('./mesh-transport-runtime.js')
    const transport = runtime.getMeshTransport()
    if (!transport) return undefined
    const envelope = transport.create('succession.request', targetNode, payload, {
        runId: randomUUID(), ttlMs: Math.max(timeoutMs, 10_000), principal: { id: 'succession', role: 'system', channel: 'mesh-succession' },
    })
    const ack = await transport.send(targetNode, envelope)
    if (ack.status !== 'delivered' && ack.status !== 'queued') return undefined
    return runtime.waitForMeshRunResult(envelope.id, timeoutMs)
}

/** SuccessionPeer backed by the mesh channel; every failure reads as "unreachable". */
export function createMeshSuccessionPeer(nodeId: string, options: { reachable: () => boolean; timeoutMs?: number; send?: SuccessionSend }): SuccessionPeer {
    const send = options.send || sendOverMesh
    const timeoutMs = options.timeoutMs ?? 8_000
    const call = async <T>(op: SuccessionOp, body?: unknown): Promise<T | null> => {
        if (!options.reachable()) return null
        try {
            const reply = await send(nodeId, { op, body, idempotencyKey: `succession:${op}:${randomUUID()}` }, timeoutMs)
            return reply?.success ? (reply.result as T) : null
        } catch { return null }
    }
    return {
        nodeId,
        reachable: options.reachable,
        deliver: message => call<JournalAck>('journal', message),
        exportJournal: () => call<ReplicaExport>('export'),
        requestShare: request => call<ShareRelease>('share', request),
        registerEmergencyRecord: async record => Boolean(await call<boolean>('emergency-record', record)),
        yieldEmergency: async () => Boolean(await call<boolean>('yield')),
    }
}
