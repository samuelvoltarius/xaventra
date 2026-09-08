import { describe, expect, it, vi } from 'vitest'
import fallback, { triggerFallbackIfNeeded } from './L8-sub-agent.js'

describe('legacy L8 repair authority', () => {
    it('keeps both callback signatures inert even with a known solution', async () => {
        const manager = new fallback.SubAgentManager()
        const known = vi.spyOn(manager as any, 'getKnownSolution').mockReturnValue('cached suggestion')
        const retry = vi.fn(async () => ({success:true}))
        const report = vi.fn(async (_message: string) => {})
        expect(await manager.spawnSearchAgent('fixture', {}, retry, report)).toMatchObject({status:'failed',results:[]})
        expect(await manager.spawnSearchAgent({problem:'fixture'}, retry, report)).toMatchObject({status:'failed',results:[]})
        expect(retry).not.toHaveBeenCalled()
        expect(known).not.toHaveBeenCalled()
        expect(report).toHaveBeenCalledTimes(2)
        expect(manager.getActiveTasks()).toEqual([])
    })
    it('never treats a failure count as authorization', async () => {
        const retry = vi.fn(async () => ({success:true}))
        expect(await triggerFallbackIfNeeded(100, 'fixture', {}, retry, async () => {})).toMatchObject({triggered:false})
        expect(retry).not.toHaveBeenCalled()
    })
})
