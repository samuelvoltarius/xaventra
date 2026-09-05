import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { deriveToolCompensation, executionScopeForContent, IdempotencyStore, makeIdempotencyKey, missionFenceForContent, prepareToolCompensation } from './execution-control.js'

describe('IdempotencyStore', () => {
    it('keeps a stable mission execution scope across reconstructed runner IDs', () => {
        const content = '[NOVA_MISSION_KEY:m_1:step:2] perform the verified action'
        expect(executionScopeForContent(content, 'run-a')).toBe('m_1:step:2')
        expect(executionScopeForContent(content, 'run-b')).toBe('m_1:step:2')
        expect(executionScopeForContent('[NOVA_MISSION_KEY:unsafe value]', 'run-c')).toBe('run-c')
    })

    it('parses only a typed mission fence', () => {
        expect(missionFenceForContent('[NOVA_MISSION_FENCE:m_123:7:token_abc] task')).toEqual({
            missionId: 'm_123', epoch: 7, token: 'token_abc',
        })
        expect(missionFenceForContent('[NOVA_MISSION_FENCE:m_123:0:token]')).toBeUndefined()
        expect(missionFenceForContent('[NOVA_MISSION_FENCE:m 123:7:token]')).toBeUndefined()
    })
    it('replays completed operations and does not repeat their side effects', async () => {
        const store = new IdempotencyStore(join(mkdtempSync(join(tmpdir(), 'nova-idem-')), 'records.json'))
        const execute = vi.fn(async () => ({ ok: true }))
        const key = makeIdempotencyKey('run-1', 'write_file', { path: 'a', value: 1 })
        const first = await store.executeOnce({ key, runId: 'run-1', operation: 'write_file', execute })
        const second = await store.executeOnce({ key, runId: 'run-1', operation: 'write_file', execute })
        expect(first.replayed).toBe(false)
        expect(second.replayed).toBe(true)
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it('only compensates through an explicitly registered handler', async () => {
        const store = new IdempotencyStore(join(mkdtempSync(join(tmpdir(), 'nova-idem-')), 'records.json'))
        const compensate = vi.fn(async () => 'rolled-back')
        await store.executeOnce({ key: 'k', runId: 'r', operation: 'change', execute: async () => 'done', compensate })
        await expect(store.compensate('k')).resolves.toBe('rolled-back')
        expect(compensate).toHaveBeenCalledOnce()
    })

    it('restores the exact previous file content for write_file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-idem-'))
        const path = join(dir, 'artifact.txt')
        writeFileSync(path, 'before')
        const store = new IdempotencyStore(join(dir, 'records.json'))
        await store.executeOnce({
            key: 'file', runId: 'r', operation: 'write_file',
            compensate: prepareToolCompensation('write_file', { path }),
            execute: async () => { writeFileSync(path, 'after'); return 'done' },
        })
        await store.compensate('file')
        expect(readFileSync(path, 'utf8')).toBe('before')
    })

    it('restores a deleted file after process reconstruction', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-idem-'))
        const path = join(dir, 'deleted.txt')
        const records = join(dir, 'records.json')
        writeFileSync(path, 'keep me')
        const first = new IdempotencyStore(records)
        await first.executeOnce({
            key: 'delete', runId: 'r', operation: 'delete_file',
            compensate: prepareToolCompensation('delete_file', { path }),
            execute: async () => { const { unlinkSync } = await import('node:fs'); unlinkSync(path); return 'done' },
        })
        const reconstructed = new IdempotencyStore(records)
        await reconstructed.compensate('delete')
        expect(readFileSync(path, 'utf8')).toBe('keep me')
    })

    it('persists a deployment rollback only after a verified deployment receipt', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-idem-'))
        const store = new IdempotencyStore(join(dir, 'records.json'))
        const input = { host: 'node-a', user: 'nova', port: 22 }
        await store.executeOnce({
            key: 'deploy', runId: 'r', operation: 'mesh_deploy',
            execute: async () => ({ success: true, compensationReceipt: { kind: 'mesh-deployment', host: 'node-a', user: 'nova', port: 22, installPath: '/opt/nova-core', previousRevision: 'abcdef1234567', createdNewInstallation: false } }),
            deriveCompensation: result => deriveToolCompensation('mesh_deploy', input, result),
        })
        expect(store.get('deploy')?.compensationPlan).toMatchObject({ kind: 'mesh-deployment', previousRevision: 'abcdef1234567' })
    })

    it('creates a secret-free Telegram delete compensation from the delivery receipt', () => {
        const handler = deriveToolCompensation('send_telegram_message', { to: '123' }, { success: true, sentTo: '123', messageId: 77 })
        expect(handler?.plan).toEqual({ kind: 'telegram-delete', chatId: '123', messageId: 77 })
        expect(JSON.stringify(handler?.plan)).not.toContain('token')
    })
})
