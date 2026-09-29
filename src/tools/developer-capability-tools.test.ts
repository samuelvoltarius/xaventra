import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    start: vi.fn(async (task: any) => ({ id: 'c1', task })),
    interrupt: vi.fn((id: string) => id === 'c-running'),
    list: vi.fn(() => [{ id: 'c-running', phase: 'running' }, { id: 'c-done', phase: 'complete' }]),
}))
vi.mock('../agents/continuable-subagents.js', () => ({ getContinuableSubagentRuntime: () => runtime }))
const orch = vi.hoisted(() => ({
    cancelSubagent: vi.fn((id: string) => id === 's-running'),
    listSubagents: vi.fn(() => [{ id: 's-running', status: 'running' }, { id: 's-old', status: 'completed' }]),
}))
vi.mock('../agents/subagent-orchestrator.js', async (original) => ({ ...(await original() as object), ...orch }))

import { developerCapabilityTools } from './developer-capability-tools.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const tool = (name: string) => developerCapabilityTools.find(entry => entry.name === name)!
beforeEach(() => { runtime.start.mockClear(); runtime.interrupt.mockClear(); orch.cancelSubagent.mockClear() })

describe('R2 UEB-12: continuable subagents carry the authorized parent identity', () => {
    it('passes userId/authUserId from the execution context, not from model fields', async () => {
        await withExecutionPolicyContext({ userId: 'alice', authUserId: 'tg-1', channel: 'telegram', runId: 'r' },
            () => tool('continuable_subagent_start').handler({ task: 'research', userId: 'mallory', authUserId: '999' }))
        expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ task: 'research', userId: 'alice', authUserId: 'tg-1' }))
    }, 120_000)
})

describe('R2 UEB-12: subagent_interrupt ("Nova, stopp")', () => {
    it('without id stops every running subagent of both runtimes', async () => {
        const result = await tool('subagent_interrupt').handler({}) as any
        expect(result.stopped.sort()).toEqual(['c-running', 's-running'])
        expect(runtime.interrupt).toHaveBeenCalledTimes(1)
        expect(orch.cancelSubagent).toHaveBeenCalledTimes(1)
    })
    it('with id stops only that one and reports honestly when nothing ran', async () => {
        expect((await tool('subagent_interrupt').handler({ id: 's-running' }) as any).stopped).toEqual(['s-running'])
        const none = await tool('subagent_interrupt').handler({ id: 'unknown' }) as any
        expect(none.success).toBe(false)
        expect(none.message).toMatch(/Kein laufender Subagent/)
    })
})
