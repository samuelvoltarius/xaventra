import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'
import { IdempotencyStore, makeIdempotencyKey, type MissionExecutionFence } from './execution-control.js'
import { NativeToolReceiptStore } from './native-tool-receipts.js'
import { hydrateNativeToolCheckpoint, publishNativeToolCheckpoint, type NativeCheckpointTransport, type NativeToolCheckpoint } from './native-tool-takeover.js'
import { evidenceHash } from './tool-evidence-binding.js'

function fixture(node: string) {
    const dir = mkdtempSync(join(tmpdir(), `xaventra-takeover-${node}-`))
    return {
        idempotency: new IdempotencyStore(join(dir, 'idempotency.json')),
        receipts: null as unknown as NativeToolReceiptStore,
        dir,
    }
}

function authority(current: MissionExecutionFence) {
    return { assertCurrent: vi.fn(async (candidate: MissionExecutionFence) => {
        if (candidate.missionId !== current.missionId || candidate.epoch !== current.epoch || candidate.token !== current.token) {
            throw new Error('stale fence')
        }
    }) }
}

describe('native tool checkpoint takeover', () => {
    it('admits a verified predecessor checkpoint under a fresh fence and does not repeat the effect', async () => {
        const entries: Array<{ id: string; timestamp: number; payload: NativeToolCheckpoint }> = []
        const transport: NativeCheckpointTransport = {
            async write(id, payload, fence) { expect(fence).toEqual(oldFence); entries.splice(0, entries.length, { id, timestamp: Date.now(), payload: structuredClone(payload) }); return true },
            async read(fence) { expect(fence).toEqual(newFence); return structuredClone(entries) },
        }
        const a = fixture('a'); a.receipts = new NativeToolReceiptStore(a.idempotency, join(a.dir, 'receipts.json'))
        const b = fixture('b'); b.receipts = new NativeToolReceiptStore(b.idempotency, join(b.dir, 'receipts.json'))
        const scopeId = 'mission:handoff:step:1'; const principalId = 'owner'; const channel = 'telegram'
        const args = { path: 'result.txt', userId: principalId, channel }
        const inputHash = evidenceHash(args)
        const key = makeIdempotencyKey(scopeId, 'read_file', args)
        const effect = vi.fn(async () => ({ success: true, content: 'one effect' }))
        const kernelA = new ExecutionKernel('Lies result.txt', { allowedChanges: { allowedTools: ['read_file'] } })
        const first = await a.idempotency.executeOnce({ key, runId: scopeId, operation: 'read_file', inputHash, execute: effect })
        kernelA.verify('read_file', first.result, { callId: 'call-1', arguments: { path: 'result.txt' } })
        a.receipts.save({ scopeId, principalId, channel, contract: kernelA.contract, idempotencyKey: key, executionInputHash: inputHash, evidence: kernelA.getVerifiedToolCallEvidence('call-1')! })
        const oldFence = { missionId: 'handoff', epoch: 1, token: 'old-token' }
        expect(await publishNativeToolCheckpoint({ fence: oldFence, scopeId, principalId, channel, kernel: kernelA, idempotency: a.idempotency, receipts: a.receipts, authority: authority(oldFence), transport })).toBe(true)

        const newFence = { missionId: 'handoff', epoch: 2, token: 'new-token' }
        const kernelB = new ExecutionKernel(kernelA.taskContext, kernelA.contract)
        const restored = await hydrateNativeToolCheckpoint({ fence: newFence, scopeId, principalId, channel, kernel: kernelB, idempotency: b.idempotency, receipts: b.receipts, authority: authority(newFence), transport })
        expect(restored).toMatchObject({ checkpointFound: true, imported: 1, restored: 1, rejected: [] })
        const forbidden = vi.fn(async () => ({ success: true, content: 'duplicate' }))
        const replay = await b.idempotency.executeOnce({ key, runId: scopeId, operation: 'read_file', inputHash, execute: forbidden })
        expect(replay.replayed).toBe(true)
        expect(effect).toHaveBeenCalledOnce()
        expect(forbidden).not.toHaveBeenCalled()

        await expect(hydrateNativeToolCheckpoint({ fence: oldFence, scopeId, principalId, channel, kernel: kernelB, idempotency: b.idempotency, receipts: b.receipts, authority: authority(newFence), transport })).rejects.toThrow('stale fence')
    })

    it('rejects a replicated result whose receipt binding was changed', async () => {
        const source = fixture('source'); source.receipts = new NativeToolReceiptStore(source.idempotency, join(source.dir, 'receipts.json'))
        const target = fixture('target'); target.receipts = new NativeToolReceiptStore(target.idempotency, join(target.dir, 'receipts.json'))
        const scopeId = 'mission:tamper:step:1'; const principalId = 'owner'; const channel = 'cli'
        const args = { path: 'a', userId: principalId, channel }; const inputHash = evidenceHash(args)
        const key = makeIdempotencyKey(scopeId, 'read_file', args)
        const kernel = new ExecutionKernel('Lies a', { allowedChanges: { allowedTools: ['read_file'] } })
        const execution = await source.idempotency.executeOnce({ key, runId: scopeId, operation: 'read_file', inputHash, execute: async () => ({ success: true, content: 'safe' }) })
        kernel.verify('read_file', execution.result, { callId: 'call-t', arguments: { path: 'a' } })
        source.receipts.save({ scopeId, principalId, channel, contract: kernel.contract, idempotencyKey: key, executionInputHash: inputHash, evidence: kernel.getVerifiedToolCallEvidence('call-t')! })
        const fence = { missionId: 'tamper', epoch: 1, token: 'token' }
        let payload: NativeToolCheckpoint | undefined
        const transport: NativeCheckpointTransport = { async write(_id, value) { payload = structuredClone(value); return true }, async read() { payload!.records[0].result = { success: true, content: 'changed' }; return [{ id: 'x', timestamp: 1, payload: payload! }] } }
        await publishNativeToolCheckpoint({ fence, scopeId, principalId, channel, kernel, idempotency: source.idempotency, receipts: source.receipts, authority: authority(fence), transport })
        const result = await hydrateNativeToolCheckpoint({ fence, scopeId, principalId, channel, kernel: new ExecutionKernel(kernel.taskContext, kernel.contract), idempotency: target.idempotency, receipts: target.receipts, authority: authority(fence), transport })
        expect(result).toMatchObject({ imported: 0, restored: 0, rejected: [{ reason: 'replicated receipt/idempotency binding mismatch' }] })
    })

    it('ignores a malformed encrypted HA payload instead of reconstructing it', async () => {
        const target = fixture('malformed'); target.receipts = new NativeToolReceiptStore(target.idempotency, join(target.dir, 'receipts.json'))
        const fence = { missionId: 'malformed', epoch: 2, token: 'current' }
        const kernel = new ExecutionKernel('Lies a', { allowedChanges: { allowedTools: ['read_file'] } })
        const transport: NativeCheckpointTransport = {
            async write() { return true },
            async read() { return [{ id: 'bad', timestamp: 1, payload: { version: 1, missionId: 'malformed', scopeId: 'mission:malformed:step:1', principalId: 'owner', channel: 'cli', contractFingerprint: '', sourceEpoch: 1, records: null, receipts: null, savedAt: 'invalid' } as unknown as NativeToolCheckpoint }] },
        }
        await expect(hydrateNativeToolCheckpoint({ fence, scopeId: 'mission:malformed:step:1', principalId: 'owner', channel: 'cli', kernel, idempotency: target.idempotency, receipts: target.receipts, authority: authority(fence), transport }))
            .resolves.toEqual({ imported: 0, checkpointFound: false, restored: 0, rejected: [] })
    })
})
