import { describe, expect, it } from 'vitest'
import { LifecyclePolicy, setLifecyclePolicyForTests } from './lifecycle-policy.js'
import { ToolExecutionPipeline } from './tool-execution-pipeline.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('ToolExecutionPipeline', () => {
    it('keeps guards monotonic and publishes an immutable final outcome', async () => {
        setLifecyclePolicyForTests(new LifecyclePolicy(join(tmpdir(), `nova-lifecycle-${Date.now()}.jsonl`)))
        const pipeline = new ToolExecutionPipeline()
        const observed: any[] = []
        pipeline.registerGuard({ id: 'deny-write', check: () => ({ decision: 'deny', reason: 'read only' }) })
        pipeline.registerGuard({ id: 'later', check: () => ({ decision: 'abstain' }) })
        pipeline.observeFinal(outcome => { observed.push(outcome) })

        const preflight = await pipeline.preflight('write_file', { path: 'a' })
        expect(preflight.decision).toBe('deny')
        expect(preflight.guards).toEqual(['deny-write'])

        const result = pipeline.finalize('read_file', { path: 'a' }, { ok: true, nested: { value: 1 } }, true) as any
        expect(Object.isFrozen(result)).toBe(true)
        expect(Object.isFrozen(result.nested)).toBe(true)
        expect(observed[0].hash).toMatch(/^[a-f0-9]{64}$/)
        setLifecyclePolicyForTests(null)
    })
})
