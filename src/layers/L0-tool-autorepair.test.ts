import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import repairModule, { ToolAutoRepairEngine } from './L0-tool-autorepair.js'

describe('L0 diagnostic-only boundary', () => {
    it.each(['ENOENT', 'Cannot find module "fixture; echo SHOULD_NOT_EXECUTE"', 'unexpected failure'])('never mutates or retries for %s', async error => {
        const path = join(process.env.NOVA_RUNTIME_ROOT!, 'missing-directory')
        const retry = vi.fn(async () => ({ success: true }))
        const engine = new ToolAutoRepairEngine()
        const outcome = await engine.repairAndRetry('read_file', { path }, {success:false, error}, retry, 99)
        expect(outcome.wasRepaired).toBe(false)
        expect(outcome.result).toMatchObject({success:false, repairProposal:{requiresApproval:true, executed:false}})
        expect(existsSync(path)).toBe(false)
        expect(retry).not.toHaveBeenCalled()
        expect(engine.getStats().successfulRepairs).toBe(0)
    })
    it('preserves existing files and keeps legacy pattern entry points inert', async () => {
        const path = join(process.env.NOVA_RUNTIME_ROOT!, 'existing.js')
        writeFileSync(path, 'ORIGINAL')
        const engine = new ToolAutoRepairEngine()
        const handler = vi.fn(async () => ({success:false, action:'CREATE_FILE_FIRST', missingFile:path}))
        await engine.wrapToolHandler('read_file', handler)({path})
        expect(handler).toHaveBeenCalledTimes(1)
        for (const pattern of repairModule.REPAIR_PATTERNS) {
            expect(await pattern.repair()).toMatchObject({repaired:false,shouldRetry:false})
            expect(await pattern.repair({action:'CREATE_FILE_FIRST',missingFile:path}, 'read_file', {path})).toMatchObject({repaired:false,shouldRetry:false})
        }
        expect(readFileSync(path,'utf8')).toBe('ORIGINAL')
    })
    it('preserves ordinary successful results', async () => {
        const result = {success:true, content:'read evidence'}
        const wrapped = new ToolAutoRepairEngine().wrapToolHandler('read_file', async () => result)
        expect(await wrapped({})).toBe(result)
    })
})
