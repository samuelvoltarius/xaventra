import { describe, expect, it, vi } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'
import { classifyToolFailure, recoverTransientReadOnlyTool } from './typed-tool-recovery.js'

function kernel(tool = 'health_status') {
    return new ExecutionKernel('Prüfe den Systemstatus', {
        allowedChanges: { readOnly: true, externalSideEffects: false, allowedTools: [tool] },
        budget: { timeoutMs: 5_000, maxToolCalls: 3 },
    })
}

describe('typed low-risk tool recovery', () => {
    it.each([
        [{ success: false, error: 'HTTP 503 service unavailable' }, 'transient-transport'],
        [new Error('ETIMEDOUT while reading status'), 'transient-transport'],
        [new TypeError('fetch failed'), 'transient-transport'],
        [{ error: 'ECONNREFUSED 127.0.0.1:8000' }, 'transient-transport'],
        [{ error: 'HTTP 429 rate limit' }, 'rate-limited'],
        [{ error: 'permission denied' }, 'authorization'],
        [{ error: 'command not found: docker' }, 'missing-dependency'],
        [{ error: 'ENOENT file not found' }, 'missing-resource'],
        [{ error: 'unexpected invariant' }, 'unknown'],
    ] as const)('classifies %j as %s without interpreting it as an action', (failure, expected) => {
        expect(classifyToolFailure(failure)).toBe(expected)
    })

    it('retries one allowlisted read-only transient failure and requires kernel verification', async () => {
        const execute = vi.fn(async () => ({ success: true, output: 'healthy' }))
        const activeKernel = kernel()
        const result = await recoverTransientReadOnlyTool({
            toolName: 'health_status', args: {}, failure: { success: false, error: 'HTTP 503' },
            kernel: activeKernel, nextCallId: () => 'recovery-1', execute,
        })
        expect(result).toMatchObject({ classification: 'transient-transport', attempted: true, success: true, reason: 'retry-verified' })
        expect(result.executions).toHaveLength(1)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(activeKernel.getVerifiedToolCallEvidence('recovery-1')).toMatchObject({ toolName: 'health_status' })
    })

    it('stops after one failed retry', async () => {
        const execute = vi.fn(async () => ({ success: false, error: 'HTTP 503 service unavailable' }))
        const activeKernel = kernel()
        const result = await recoverTransientReadOnlyTool({
            toolName: 'health_status', args: {}, failure: { error: 'HTTP 503' },
            kernel: activeKernel, nextCallId: () => 'recovery-1', execute,
        })
        expect(result).toMatchObject({ attempted: true, success: false, reason: 'retry-unverified' })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(activeKernel.getVerifiedToolCallEvidence('recovery-1')).toBeUndefined()
    })

    it.each([
        ['run_command', { error: 'HTTP 503' }],
        ['health_status', { error: 'permission denied' }],
        ['health_status', { error: 'unexpected invariant' }],
    ] as const)('does not retry unsafe or non-transient %s failures', async (toolName, failure) => {
        const execute = vi.fn()
        const result = await recoverTransientReadOnlyTool({
            toolName, args: {}, failure, kernel: kernel(toolName), nextCallId: () => 'never', execute,
        })
        expect(result.attempted).toBe(false)
        expect(execute).not.toHaveBeenCalled()
    })
})
