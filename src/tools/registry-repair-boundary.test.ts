import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { NovaToolRegistry } from './complete-registry.js'
import { ToolRegistry } from './registry.js'
import { LifecyclePolicy, setLifecyclePolicyForTests } from '../core/lifecycle-policy.js'
import { ToolExecutionPipeline, setToolExecutionPipelineForTests } from '../core/tool-execution-pipeline.js'

const { spawnSearchAgent } = vi.hoisted(() => ({spawnSearchAgent:vi.fn(async (_request, retry) => retry({}))}))
vi.mock('../layers/L8-sub-agent.js', () => ({getSubAgentManager:() => ({spawnSearchAgent})}))

afterEach(() => {
    setToolExecutionPipelineForTests(null)
    setLifecyclePolicyForTests(null)
    vi.clearAllMocks()
})

describe('registry repair authority', () => {
    it.each(['returned','thrown'])('keeps legacy registry %s failures from launching hidden retries', async mode => {
        const registry = new ToolRegistry()
        const handler = vi.fn(async () => {
            if (mode === 'thrown') throw new Error('fixture failure')
            return {error:'fixture failure'}
        })
        registry.register({name:'fixture_legacy',description:'test',category:'system',parameters:[],requiresElevation:true,handler})
        for (let i=0; i<4; i++) {
            expect(await registry.execute({id:String(i),name:'fixture_legacy',arguments:{}}, true)).toMatchObject({success:false})
        }
        expect(handler).toHaveBeenCalledTimes(4)
        expect(spawnSearchAgent).not.toHaveBeenCalled()
        expect(await registry.execute({id:'denied',name:'fixture_legacy',arguments:{}})).toMatchObject({success:false})
        expect(handler).toHaveBeenCalledTimes(4)
    })

    it('never retries failed handlers outside preflight, even after repeated failures', async () => {
        setLifecyclePolicyForTests(new LifecyclePolicy(join(process.env.NOVA_RUNTIME_ROOT!, 'repair-policy.jsonl')))
        const pipeline = new ToolExecutionPipeline()
        setToolExecutionPipelineForTests(pipeline)
        const guard = vi.fn(() => ({decision:'abstain' as const}))
        pipeline.registerGuard({id:'count-authorized-actions', check:guard})
        const outcomes: any[] = []
        pipeline.observeFinal(outcome => { outcomes.push(outcome) })
        const registry = new NovaToolRegistry()
        const handler = vi.fn(async () => ({success:false, error:'ENOENT: missing fixture'}))
        registry.register({name:'fixture_diagnostic', description:'test', category:'system', parameters:[], handler} as any)
        for (let i=0; i<4; i++) {
            const result: any = await registry.execute('fixture_diagnostic', {})
            expect(result).toMatchObject({success:false, repairProposal:{executed:false,requiresApproval:true}})
            expect(Object.isFrozen(result)).toBe(true)
        }
        expect(handler).toHaveBeenCalledTimes(4)
        expect(guard).toHaveBeenCalledTimes(4)
        expect(outcomes).toHaveLength(4)
        expect(outcomes.every(outcome => !outcome.success && Object.isFrozen(outcome))).toBe(true)

        pipeline.registerGuard({id:'deny-next-action', check:() => ({decision:'deny',reason:'not authorized'})})
        expect(await registry.execute('fixture_diagnostic', {})).toMatchObject({success:false,blocked:true})
        expect(handler).toHaveBeenCalledTimes(4)
    })

    it('keeps ordinary successful execution and its evidence intact', async () => {
        setLifecyclePolicyForTests(new LifecyclePolicy(join(process.env.NOVA_RUNTIME_ROOT!, 'success-policy.jsonl')))
        const registry = new NovaToolRegistry()
        const handler = vi.fn(async () => ({success:true,content:'verified fixture'}))
        registry.register({name:'fixture_success',description:'test',category:'system',parameters:[],handler} as any)
        expect(await registry.execute('fixture_success', {})).toEqual({success:true,content:'verified fixture'})
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
