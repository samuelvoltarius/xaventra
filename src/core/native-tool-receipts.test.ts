import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IdempotencyStore, makeIdempotencyKey } from './execution-control.js'
import { ExecutionKernel } from './execution-kernel.js'
import { NativeToolReceiptStore } from './native-tool-receipts.js'
import { evidenceHash } from './tool-evidence-binding.js'

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'xaventra-native-receipt-'))
    const idempotencyFile = join(dir, 'idempotency.json')
    const receiptFile = join(dir, 'receipts.json')
    const scopeId = 'mission:fixture:step:1'
    const principalId = 'owner-1'
    const channel = 'cli'
    const evidenceArgs = { path: 'a.txt' }
    const executionArgs = { ...evidenceArgs, userId: principalId, channel }
    const result = { success: true, path: 'a.txt', content: 'verified' }
    const key = makeIdempotencyKey(scopeId, 'read_file', executionArgs)
    return { dir, idempotencyFile, receiptFile, scopeId, principalId, channel, evidenceArgs, executionArgs, result, key }
}

describe('NativeToolReceiptStore', () => {
    it('rehydrates verified evidence after reconstruction and replays the effect exactly once', async () => {
        const f = fixture()
        const firstStore = new IdempotencyStore(f.idempotencyFile)
        const execute = vi.fn(async () => f.result)
        const inputHash = evidenceHash(f.executionArgs)
        await firstStore.executeOnce({
            key: f.key, runId: f.scopeId, operation: 'read_file', inputHash, execute,
        })
        const firstKernel = new ExecutionKernel('Lies die Datei a.txt', { allowedChanges: { allowedTools: ['read_file'] } })
        expect(firstKernel.verify('read_file', f.result, { callId: 'call-1', arguments: f.evidenceArgs }).success).toBe(true)
        new NativeToolReceiptStore(firstStore, f.receiptFile).save({
            scopeId: f.scopeId, principalId: f.principalId, channel: f.channel,
            contract: firstKernel.contract, idempotencyKey: f.key, executionInputHash: inputHash,
            evidence: firstKernel.getVerifiedToolCallEvidence('call-1')!,
        })
        const receiptJson = readFileSync(f.receiptFile, 'utf8')
        expect(receiptJson).not.toContain('verified')
        expect(receiptJson).not.toContain('content')

        const reconstructedStore = new IdempotencyStore(f.idempotencyFile)
        const reconstructedKernel = new ExecutionKernel(firstKernel.taskContext, firstKernel.contract)
        const rehydrated = new NativeToolReceiptStore(reconstructedStore, f.receiptFile).rehydrate({
            scopeId: f.scopeId, principalId: f.principalId, channel: f.channel, kernel: reconstructedKernel,
        })
        expect(rehydrated).toEqual({ restored: 1, rejected: [] })
        expect(reconstructedKernel.validateCompletion('Datei wurde verifiziert.').success).toBe(true)

        const forbiddenRepeat = vi.fn(async () => ({ success: true, content: 'repeated' }))
        const replay = await reconstructedStore.executeOnce({
            key: f.key, runId: f.scopeId, operation: 'read_file', inputHash, execute: forbiddenRepeat,
        })
        expect(replay.replayed).toBe(true)
        expect(replay.result).toEqual(f.result)
        expect(forbiddenRepeat).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledOnce()
    })

    it('fails closed for another principal or a modified durable result', async () => {
        const f = fixture()
        const inputHash = evidenceHash(f.executionArgs)
        const firstStore = new IdempotencyStore(f.idempotencyFile)
        await firstStore.executeOnce({
            key: f.key, runId: f.scopeId, operation: 'read_file', inputHash, execute: async () => f.result,
        })
        const firstKernel = new ExecutionKernel('Lies die Datei a.txt', { allowedChanges: { allowedTools: ['read_file'] } })
        firstKernel.verify('read_file', f.result, { callId: 'call-1', arguments: f.evidenceArgs })
        new NativeToolReceiptStore(firstStore, f.receiptFile).save({
            scopeId: f.scopeId, principalId: f.principalId, channel: f.channel,
            contract: firstKernel.contract, idempotencyKey: f.key, executionInputHash: inputHash,
            evidence: firstKernel.getVerifiedToolCallEvidence('call-1')!,
        })

        const wrongPrincipalKernel = new ExecutionKernel(firstKernel.taskContext, firstKernel.contract)
        expect(new NativeToolReceiptStore(new IdempotencyStore(f.idempotencyFile), f.receiptFile).rehydrate({
            scopeId: f.scopeId, principalId: 'other-user', channel: f.channel, kernel: wrongPrincipalKernel,
        })).toMatchObject({ restored: 0, rejected: [{ reason: 'principal or channel mismatch' }] })

        const changedContractKernel = new ExecutionKernel('Lies die Datei b.txt', { allowedChanges: { allowedTools: ['read_file'] } })
        expect(new NativeToolReceiptStore(new IdempotencyStore(f.idempotencyFile), f.receiptFile).rehydrate({
            scopeId: f.scopeId, principalId: f.principalId, channel: f.channel, kernel: changedContractKernel,
        })).toMatchObject({ restored: 0, rejected: [{ reason: 'contract fingerprint mismatch' }] })

        const records = JSON.parse(readFileSync(f.idempotencyFile, 'utf8'))
        records[f.key].result = { success: true, path: 'a.txt', content: 'tampered' }
        writeFileSync(f.idempotencyFile, JSON.stringify(records))
        const tamperedKernel = new ExecutionKernel(firstKernel.taskContext, firstKernel.contract)
        expect(new NativeToolReceiptStore(new IdempotencyStore(f.idempotencyFile), f.receiptFile).rehydrate({
            scopeId: f.scopeId, principalId: f.principalId, channel: f.channel, kernel: tamperedKernel,
        })).toMatchObject({ restored: 0, rejected: [{ reason: 'result hash mismatch' }] })
    })
})
