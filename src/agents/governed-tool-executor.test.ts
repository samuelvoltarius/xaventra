import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), fence: vi.fn() }))
vi.mock('./tool-authorization.js', async importOriginal => ({
    ...await importOriginal<typeof import('./tool-authorization.js')>(),
    authorizeToolExecution: mocks.authorize,
}))
vi.mock('../core/execution-control.js', async importOriginal => ({
    ...await importOriginal<typeof import('../core/execution-control.js')>(),
    assertMissionFenceForContent: mocks.fence,
}))

import { createGovernedToolExecutor } from './governed-tool-executor.js'
import { IdempotencyStore } from '../core/execution-control.js'
import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'

beforeEach(() => {
    mocks.authorize.mockReset().mockImplementation(async (_name: string, args: Record<string, unknown>) => args)
    mocks.fence.mockReset().mockResolvedValue(undefined)
})

function executor(execute: (name: string, args: Record<string, unknown>) => Promise<unknown>, contractId = 'contract-1') {
    const store = new IdempotencyStore(join(mkdtempSync(join(tmpdir(), 'nova-governed-')), 'records.json'))
    return createGovernedToolExecutor({
        kernel: { assertCanExecute() {}, contract: { id: contractId, allowedChanges: { readOnly: false, externalSideEffects: true } } } as any,
        store, userId: 'u', authUserId: '123', channel: 'telegram', content: 'do it', internal: false,
        isBlocked: () => false, block: () => {}, execute, record: vi.fn(),
    })
}

describe('governed tool executor replay marking', () => {
    it('marks a cached object result as replayed instead of a fresh success', async () => {
        const execute = vi.fn(async () => ({ success: true, sent: 1 }))
        const run = executor(execute)
        const first = await run('send_telegram_message', { text: 'hi' })
        const second = await run('send_telegram_message', { text: 'hi' })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(first).toEqual({ success: true, sent: 1 })
        expect(first).not.toHaveProperty('replayed')
        expect(second).toMatchObject({ success: true, sent: 1, replayed: true, executedNow: false })
    })

    it('wraps a cached non-object result consistently', async () => {
        const execute = vi.fn(async () => 'done')
        const run = executor(execute)
        expect(await run('x_tool', { a: 1 })).toBe('done')
        expect(await run('x_tool', { a: 1 })).toEqual({ result: 'done', replayed: true, executedNow: false })
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it('passes the kernel contract id into the execution policy context', async () => {
        let seen: Record<string, unknown> = {}
        const run = executor(async () => { seen = { ...getExecutionPolicyContext() }; return { ok: true } }, 'contract-xyz')
        await run('x_tool', { a: 2 })
        expect(seen).toMatchObject({ runId: 'contract-xyz', contractId: 'contract-xyz', authUserId: '123', channel: 'telegram' })
    })
})
