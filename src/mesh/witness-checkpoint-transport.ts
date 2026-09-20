import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { MissionExecutionFence } from '../core/execution-control.js'
import type { NativeCheckpointTransport, NativeToolCheckpoint } from '../core/native-tool-takeover.js'
import type { WitnessCheckpoint } from './quorum-witness.js'
import type { WitnessEndpoint, WitnessQuorumConfig } from './witness-quorum.js'

function sign(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex')
}

function signatureMatches(actual: string, expected: string): boolean {
    const left = Buffer.from(actual, 'hex'); const right = Buffer.from(expected, 'hex')
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

async function request<T>(witness: WitnessEndpoint, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
    const serialized = JSON.stringify(body); const timestamp = String(Date.now())
    try {
        const response = await fetch(`${witness.url}${path}`, {
            method: 'POST', body: serialized, signal: AbortSignal.timeout(timeoutMs),
            headers: { 'content-type': 'application/json', 'x-nova-timestamp': timestamp, 'x-nova-signature': sign(witness.secret, `${timestamp}.${serialized}`) },
        })
        if (!response.ok || response.headers.get('x-nova-witness-id') !== witness.id) return null
        const responseBody = await response.text()
        if (!signatureMatches(response.headers.get('x-nova-signature') || '', sign(witness.secret, responseBody))) return null
        return JSON.parse(responseBody) as T
    } catch { return null }
}

function validateConfig(config: WitnessQuorumConfig): void {
    if (config.witnesses.length !== 3 || new Set(config.witnesses.map(item => item.id)).size !== 3
        || new Set(config.witnesses.map(item => item.url)).size !== 3
        || config.witnesses.some(item => !item.id || !item.url || item.secret.length < 16)) {
        throw new Error('witness checkpoint transport requires three independent authenticated witnesses')
    }
}

export function createWitnessCheckpointTransport(config: WitnessQuorumConfig, nodeId: string): NativeCheckpointTransport {
    validateConfig(config)
    const timeoutMs = config.timeoutMs || 5000
    const call = <T>(path: string, body: Record<string, unknown>) => Promise.all(config.witnesses.map(witness => request<T>(witness, path, body, timeoutMs)))
    return {
        async write(id: string, payload: NativeToolCheckpoint, fence: MissionExecutionFence): Promise<boolean> {
            const service = `mission:${fence.missionId}`; const requestId = randomUUID()
            const replies = await call<{ requestId: string; checkpoint: WitnessCheckpoint }>('/v1/checkpoint/write', {
                service, nodeId, epoch: fence.epoch, id, payload, requestId,
            })
            return replies.filter(reply => reply?.requestId === requestId && reply.checkpoint?.id === id
                && reply.checkpoint.sourceEpoch === fence.epoch).length >= 2
        },
        async read(fence: MissionExecutionFence): Promise<Array<{ id: string; timestamp: number; payload: NativeToolCheckpoint }>> {
            const service = `mission:${fence.missionId}`; const requestId = randomUUID()
            const replies = await call<{ requestId: string; checkpoints: WitnessCheckpoint[] }>('/v1/checkpoint/read', {
                service, nodeId, epoch: fence.epoch, requestId,
            })
            const groups = new Map<string, { count: number; checkpoint: WitnessCheckpoint }>()
            for (const reply of replies) {
                if (reply?.requestId !== requestId || !Array.isArray(reply.checkpoints)) continue
                const witnessVotes = new Set<string>()
                for (const checkpoint of reply.checkpoints) {
                    if (checkpoint.service !== service || !checkpoint.id || !checkpoint.payloadHash) continue
                    const actualHash = createHash('sha256').update(JSON.stringify(checkpoint.payload)).digest('hex')
                    if (actualHash !== checkpoint.payloadHash) continue
                    const key = `${checkpoint.id}\0${checkpoint.payloadHash}`
                    if (witnessVotes.has(key)) continue
                    witnessVotes.add(key)
                    const group = groups.get(key) || { count: 0, checkpoint }
                    group.count++; groups.set(key, group)
                }
            }
            return [...groups.values()].filter(group => group.count >= 2).map(group => ({
                id: group.checkpoint.id, timestamp: Date.parse(group.checkpoint.updatedAt),
                payload: group.checkpoint.payload as NativeToolCheckpoint,
            }))
        },
    }
}
