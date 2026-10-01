import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_TOOLS } from './complete-registry.js'

// P9 Gruppe 4: `tool_confirm` could never approve anything (approve was hard-wired
// to false) and its pending store was never read by any tool. One approval path
// remains: the owner's detail-bound one-time code (/freigabe) and the Knopf-Karten.
describe('tool_confirm is gone', () => {
    it('is not registered and its module no longer exists', () => {
        expect(ALL_TOOLS.some(tool => tool.name === 'tool_confirm')).toBe(false)
        expect(existsSync(join(process.cwd(), 'src', 'tools', 'tool-confirmation.ts'))).toBe(false)
    })
})
