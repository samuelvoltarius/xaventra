import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LifecyclePolicy, withExecutionPolicyContext } from './lifecycle-policy.js'

describe('authoritative lifecycle policy', () => {
    it('orders hooks, rewrites inputs and preserves execution context', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-policy-'))
        const policy = new LifecyclePolicy(join(dir, 'audit.jsonl'))
        const seen: string[] = []
        policy.register({ id: 'second', event: 'tool.before', priority: 20, handler: payload => { seen.push(String(payload.input?.value)); return { decision: 'allow' } } })
        policy.register({ id: 'first', event: 'tool.before', priority: 10, handler: payload => ({ updatedInput: { ...payload.input, value: 'rewritten' } }) })
        const result = await withExecutionPolicyContext({ runId: 'run-1', userId: 'u-1' }, () => policy.run('tool.before', { toolName: 'demo', input: { value: 'raw' } }))
        expect(seen).toEqual(['rewritten'])
        expect(result.payload.input).toEqual({ value: 'rewritten' })
        expect(result.payload.context).toMatchObject({ runId: 'run-1', userId: 'u-1' })
        rmSync(dir, { recursive: true, force: true })
    })

    it('fails closed when a pre-tool policy crashes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-policy-'))
        const policy = new LifecyclePolicy(join(dir, 'audit.jsonl'))
        policy.register({ id: 'broken', event: 'tool.before', handler: () => { throw new Error('nope') } })
        const result = await policy.run('tool.before', { toolName: 'danger', input: {} })
        expect(result.decision).toBe('deny')
        expect(result.reason).toContain('failed closed')
        rmSync(dir, { recursive: true, force: true })
    })
})
