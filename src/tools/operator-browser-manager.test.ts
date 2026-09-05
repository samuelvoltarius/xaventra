import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorBrowserManager } from './operator-browser-manager.js'

describe('operator browser manager', () => {
    it('does not expose raw user ids and starts with isolated status', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-browser-'))
        const manager = new OperatorBrowserManager(root)
        expect(manager.status('alice')).toEqual({ running: false, handoff: false })
        expect(JSON.stringify(manager.status('alice'))).not.toContain('alice')
        rmSync(root, { recursive: true, force: true })
    })
})
