import { beforeEach, describe, expect, it, vi } from 'vitest'

// INT-12 regression: the subagent tools relied on the orchestrator picking up
// the parent identity implicitly. They now pass userId/authUserId explicitly
// from the authorized execution context, never from model arguments.

const orch = vi.hoisted(() => ({
    spawnSubagent: vi.fn(async (_task: any) => ({ id: 's1', status: 'completed', output: 'ok', durationMs: 1 })),
    spawnSubagentsParallel: vi.fn(async (_tasks: any, _parent?: any) => 'done'),
}))
vi.mock('../agents/subagent-orchestrator.js', () => orch)

import { ALL_TOOLS } from './complete-registry.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const tool = (name: string) => ALL_TOOLS.find(t => t.name === name)!
const parentContext = { userId: 'alice', authUserId: 'tg-1', channel: 'Telegram', runId: 'r1' }

beforeEach(() => { orch.spawnSubagent.mockClear(); orch.spawnSubagentsParallel.mockClear() })

describe('subagent tools pass the authorized parent identity (INT-12)', () => {
    it('spawn_subagent uses the execution context, not model-supplied identity fields', async () => {
        await withExecutionPolicyContext(parentContext, () =>
            tool('spawn_subagent').handler({ task: 'research', userId: 'mallory', authorizationUserId: '999' }))
        expect(orch.spawnSubagent).toHaveBeenCalledWith(expect.objectContaining({ task: 'research', userId: 'alice', authUserId: 'tg-1' }))
    })

    it('spawn_subagents_parallel hands the parent identity to the orchestrator', async () => {
        await withExecutionPolicyContext(parentContext, () =>
            tool('spawn_subagents_parallel').handler({ tasks: [{ task: 'a', userId: 'mallory' }] }))
        expect(orch.spawnSubagentsParallel).toHaveBeenCalledWith([{ task: 'a', userId: 'mallory' }], { userId: 'alice', authUserId: 'tg-1' })
    })

    it('falls back to the runner-injected identity when no governed context exists', async () => {
        await tool('spawn_subagent').handler({ task: 'x', userId: 'bob', authorizationUserId: 'tg-2' })
        expect(orch.spawnSubagent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob', authUserId: 'tg-2' }))
    })
})
