import { createHash } from 'node:crypto'
import type { ExecutionKernel } from './execution-kernel.js'
import type { IdempotencyRecord, IdempotencyStore, MissionExecutionFence } from './execution-control.js'
import { readHaRecords, writeHaRecord } from './ha-state.js'
import { evidenceHash } from './tool-evidence-binding.js'
import { NativeToolReceiptStore, taskContractFingerprint, type NativeToolReceipt, type NativeReceiptRehydration } from './native-tool-receipts.js'

const SCOPE = 'native-tool-checkpoint'

export interface NativeToolCheckpoint {
    version: 1
    missionId: string
    scopeId: string
    principalId: string
    channel: string
    contractFingerprint: string
    sourceEpoch: number
    records: IdempotencyRecord[]
    receipts: NativeToolReceipt[]
    savedAt: string
}

export interface NativeTakeoverAuthority {
    assertCurrent(fence: MissionExecutionFence): Promise<void>
}

export interface NativeCheckpointTransport {
    write(id: string, payload: NativeToolCheckpoint): Promise<boolean>
    read(): Promise<Array<{ id: string; timestamp: number; payload: NativeToolCheckpoint }>>
}

function checkpointId(missionId: string, scopeId: string): string {
    return `native_tool_${createHash('sha256').update(`${missionId}\0${scopeId}`).digest('hex')}`
}

function defaultTransport(): NativeCheckpointTransport {
    return {
        write: (id, payload) => writeHaRecord(SCOPE, id, payload, {
            missionId: payload.missionId, scopeId: payload.scopeId, leaseEpoch: payload.sourceEpoch,
        }),
        read: () => readHaRecords<NativeToolCheckpoint>(SCOPE, 1_000),
    }
}

function defaultAuthority(): NativeTakeoverAuthority {
    return {
        async assertCurrent(fence) {
            const { getServiceFencingToken, verifyLiveServiceLeadership } = await import('../mesh/leader-election.js')
            const service = `mission:${fence.missionId}`
            if (!(await verifyLiveServiceLeadership(service))) throw new Error(`Mission ${fence.missionId} has no live fencing authority`)
            const current = getServiceFencingToken(service)
            if (!current || current.epoch !== fence.epoch || current.token !== fence.token) {
                throw new Error(`Mission ${fence.missionId} checkpoint rejected by fencing authority`)
            }
        },
    }
}

function pairIsValid(checkpoint: NativeToolCheckpoint, receipt: NativeToolReceipt, record?: IdempotencyRecord): boolean {
    return Boolean(record)
        && receipt.scopeId === checkpoint.scopeId
        && receipt.principalId === checkpoint.principalId
        && receipt.channel === checkpoint.channel
        && receipt.contractFingerprint === checkpoint.contractFingerprint
        && receipt.idempotencyKey === record!.key
        && record!.status === 'completed'
        && record!.runId === checkpoint.scopeId
        && record!.operation === receipt.evidence.toolName
        && record!.inputHash === receipt.executionInputHash
        && evidenceHash(record!.result) === receipt.evidence.resultHash
}

export async function publishNativeToolCheckpoint(input: {
    fence: MissionExecutionFence
    scopeId: string
    principalId: string
    channel: string
    kernel: ExecutionKernel
    idempotency: IdempotencyStore
    receipts: NativeToolReceiptStore
    authority?: NativeTakeoverAuthority
    transport?: NativeCheckpointTransport
}): Promise<boolean> {
    await (input.authority || defaultAuthority()).assertCurrent(input.fence)
    const receipts = input.receipts.exportScope(input.scopeId)
    const records = input.idempotency.exportCompleted(receipts.map(receipt => receipt.idempotencyKey))
    const byKey = new Map(records.map(record => [record.key, record]))
    if (!receipts.length || receipts.some(receipt => !pairIsValid({
        version: 1, missionId: input.fence.missionId, scopeId: input.scopeId,
        principalId: input.principalId, channel: input.channel,
        contractFingerprint: taskContractFingerprint(input.kernel.contract), sourceEpoch: input.fence.epoch,
        records, receipts, savedAt: '',
    }, receipt, byKey.get(receipt.idempotencyKey)))) return false
    const payload: NativeToolCheckpoint = {
        version: 1, missionId: input.fence.missionId, scopeId: input.scopeId,
        principalId: input.principalId, channel: input.channel,
        contractFingerprint: taskContractFingerprint(input.kernel.contract),
        sourceEpoch: input.fence.epoch, records, receipts, savedAt: new Date().toISOString(),
    }
    return (input.transport || defaultTransport()).write(checkpointId(input.fence.missionId, input.scopeId), payload)
}

export async function hydrateNativeToolCheckpoint(input: {
    fence: MissionExecutionFence
    scopeId: string
    principalId: string
    channel: string
    kernel: ExecutionKernel
    idempotency: IdempotencyStore
    receipts: NativeToolReceiptStore
    authority?: NativeTakeoverAuthority
    transport?: NativeCheckpointTransport
}): Promise<NativeReceiptRehydration & { imported: number; checkpointFound: boolean }> {
    await (input.authority || defaultAuthority()).assertCurrent(input.fence)
    const expectedFingerprint = taskContractFingerprint(input.kernel.contract)
    const candidates = (await (input.transport || defaultTransport()).read())
        .map(item => item.payload)
        .filter(checkpoint => checkpoint?.version === 1
            && typeof checkpoint.savedAt === 'string'
            && Array.isArray(checkpoint.records) && checkpoint.records.length <= 500
            && Array.isArray(checkpoint.receipts) && checkpoint.receipts.length <= 500
            && checkpoint.missionId === input.fence.missionId
            && checkpoint.scopeId === input.scopeId
            && checkpoint.principalId === input.principalId
            && checkpoint.channel === input.channel
            && checkpoint.contractFingerprint === expectedFingerprint
            && Number.isSafeInteger(checkpoint.sourceEpoch)
            && checkpoint.sourceEpoch <= input.fence.epoch)
        .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    const checkpoint = candidates[0]
    if (!checkpoint) return { imported: 0, checkpointFound: false, restored: 0, rejected: [] }
    const records = new Map(checkpoint.records.map(record => [record.key, record]))
    const rejected: Array<{ receiptId: string; reason: string }> = []
    let imported = 0
    for (const receipt of checkpoint.receipts) {
        const record = records.get(receipt.idempotencyKey)
        if (!record || !pairIsValid(checkpoint, receipt, record)) {
            rejected.push({ receiptId: receipt.receiptId || 'unknown', reason: 'replicated receipt/idempotency binding mismatch' })
            continue
        }
        if (!input.idempotency.importCompleted(record) || !input.receipts.importReceipt(receipt)) {
            rejected.push({ receiptId: receipt.receiptId, reason: 'replicated state conflicts with local durable truth' })
            continue
        }
        imported++
    }
    const rehydrated = input.receipts.rehydrate({
        scopeId: input.scopeId, principalId: input.principalId, channel: input.channel, kernel: input.kernel,
    })
    return { imported, checkpointFound: true, restored: rehydrated.restored, rejected: [...rejected, ...rehydrated.rejected] }
}
