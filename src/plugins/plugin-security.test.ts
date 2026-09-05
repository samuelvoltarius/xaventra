import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluatePluginTrust } from './plugin-security.js'

describe('plugin trust', () => {
    it('rejects unsigned external code by default', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-plugin-'))
        const dir = join(root, 'demo'); mkdirSync(dir); writeFileSync(join(dir, 'index.js'), 'export const activate=()=>{}')
        const decision = evaluatePluginTrust(dir, { name: 'demo', version: '1.0.0', main: 'index.js' })
        expect(decision.trusted).toBe(false)
        expect(decision.reason).toMatch(/integrity|signature/)
        rmSync(root, { recursive: true, force: true })
    })
})
