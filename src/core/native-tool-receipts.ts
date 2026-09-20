import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import type { ExecutionKernel } from './execution-kernel.js'
import type { IdempotencyStore } from './execution-control.js'
import { evidenceHash, type VerifiedToolCallEvidence } from './tool-evidence-binding.js'
import type { TaskContract } from './task-contract.js'

export interface NativeToolReceipt {
    version: 1
    receiptId: string
    scopeId: string
    principalId: string
    channel: string
    contractFingerprint: string
    idempotencyKey: string
    executionInputHash: string
    evidence: VerifiedToolCallEvidence
    savedAt: string
}

interface NativeToolReceiptState {
    version: 1
    receipts: Record<string, NativeToolReceipt>
}

export interface NativeReceiptRehydration {
    restored: number
    rejected: Array<{ receiptId: string; reason: string }>
}

function stableReceiptId(scopeId: string, principalId: string, channel: string, callId: string): string {
    return createHash('sha256').update(`${scopeId}\0${principalId}\0${channel}\0${callId}`).digest('hex')
}

/** Fingerprint only the binding parts of a contract. Generated IDs and dates
 * deliberately stay out so an identical reconstructed mission can resume. */
export function taskContractFingerprint(contract: TaskContract): string {
    return evidenceHash({
        goal: contract.goal,
        successCriteria: contract.successCriteria,
        requiredToolTargets: contract.requiredToolTargets || [],
        allowedChanges: contract.allowedChanges,
        requiredTests: contract.requiredTests,
        approvalPolicy: contract.approvalPolicy,
    })
}

/** Durable correlation between a verified kernel receipt and the independently
 * persisted idempotency result. No raw arguments, credentials or tool results
 * are duplicated into this file. */
export class NativeToolReceiptStore {
    private state: NativeToolReceiptState = { version: 1, receipts: {} }

    constructor(
        private readonly idempotency: IdempotencyStore,
        private readonly file = join(process.cwd(), '.nova-data', 'native-tool-receipts.json'),
    ) { this.load() }

    private load(): void {
        try {
            if (!existsSync(this.file)) return
            const value = JSON.parse(readFileSync(this.file, 'utf8')) as NativeToolReceiptState
            if (value?.version === 1 && value.receipts && typeof value.receipts === 'object') this.state = value
        } catch {
            this.state = { version: 1, receipts: {} }
        }
    }

    private saveState(): void { atomicWriteJsonSync(this.file, this.state) }

    save(input: {
        scopeId: string
        principalId: string
        channel: string
        contract: TaskContract
        idempotencyKey: string
        executionInputHash: string
        evidence: VerifiedToolCallEvidence
    }): NativeToolReceipt {
        const record = this.idempotency.get(input.idempotencyKey)
        if (!record || record.status !== 'completed') throw new Error('Cannot persist receipt without a completed idempotency record')
        if (record.runId !== input.scopeId || record.operation !== input.evidence.toolName) throw new Error('Receipt does not match its execution scope')
        if (!record.inputHash || record.inputHash !== input.executionInputHash) throw new Error('Receipt execution input hash mismatch')
        if (evidenceHash(record.result) !== input.evidence.resultHash) throw new Error('Receipt result hash mismatch')

        const receiptId = stableReceiptId(input.scopeId, input.principalId, input.channel, input.evidence.callId)
        const receipt: NativeToolReceipt = {
            version: 1,
            receiptId,
            scopeId: input.scopeId,
            principalId: input.principalId,
            channel: input.channel,
            contractFingerprint: taskContractFingerprint(input.contract),
            idempotencyKey: input.idempotencyKey,
            executionInputHash: input.executionInputHash,
            evidence: structuredClone(input.evidence),
            savedAt: new Date().toISOString(),
        }
        this.state.receipts[receiptId] = receipt
        this.saveState()
        return receipt
    }

    rehydrate(input: {
        scopeId: string
        principalId: string
        channel: string
        kernel: ExecutionKernel
    }): NativeReceiptRehydration {
        const fingerprint = taskContractFingerprint(input.kernel.contract)
        const result: NativeReceiptRehydration = { restored: 0, rejected: [] }
        const receipts = Object.values(this.state.receipts)
            .filter(receipt => receipt.scopeId === input.scopeId)
            .sort((left, right) => left.savedAt.localeCompare(right.savedAt))

        for (const receipt of receipts) {
            let reason = ''
            if (receipt.principalId !== input.principalId || receipt.channel !== input.channel) reason = 'principal or channel mismatch'
            else if (receipt.contractFingerprint !== fingerprint) reason = 'contract fingerprint mismatch'
            const record = this.idempotency.get(receipt.idempotencyKey)
            if (!reason && (!record || record.status !== 'completed')) reason = 'completed idempotency record missing'
            else if (!reason && (record!.runId !== receipt.scopeId || record!.operation !== receipt.evidence.toolName)) reason = 'idempotency scope mismatch'
            else if (!reason && (!record!.inputHash || record!.inputHash !== receipt.executionInputHash)) reason = 'execution input hash mismatch'
            else if (!reason && evidenceHash(record!.result) !== receipt.evidence.resultHash) reason = 'result hash mismatch'
            else if (!reason && !input.kernel.restoreVerifiedToolCall(receipt.evidence, record!.result)) reason = 'kernel rejected receipt'

            if (reason) result.rejected.push({ receiptId: receipt.receiptId, reason })
            else result.restored++
        }
        return result
    }
}
