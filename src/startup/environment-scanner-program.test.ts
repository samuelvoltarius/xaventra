import { describe, expect, it, vi } from 'vitest'

const commands = vi.hoisted(() => ({ lookup: vi.fn(() => { throw Object.assign(new Error('lookup timeout'), { code: 'ETIMEDOUT' }) }) }))
vi.mock('node:child_process', () => ({ execFileSync: commands.lookup, execSync: commands.lookup }))
import { locateProgram, resetProgramCache } from './environment-scanner.js'

describe('direct evidence of the running Node executable', () => {
    it('does not misreport Node as absent when external lookup is unavailable', () => {
        resetProgramCache()
        expect(locateProgram('node')).toBe(process.execPath)
        expect(locateProgram('node')).toBe(process.execPath)
        expect(locateProgram('node; rm -rf /')).toBeUndefined()
        expect(commands.lookup).not.toHaveBeenCalled()
    })
})
