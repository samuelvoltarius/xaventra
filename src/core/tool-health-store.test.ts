import { beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { clearToolFailures, isToolUnavailable, loadToolHealth, noteToolFailure, recordToolOutcome, toolHealthFile } from './tool-health-store.js'
import { getSelfCheckManager } from '../layers/L15-self-check.js'
import { getCapabilitiesPrompt, loadUnavailable, recordUnavailable } from '../memory/capabilities-store.js'

// 2.89 Paket C: ONE tool-health store. L15 (health) and the negative capability memory used to keep
// two files under process.cwd() that never read each other.

beforeEach(() => { rmSync(toolHealthFile(), { force: true }) })

describe('one tool-health store', () => {
    it('L15 and the negative memory read and write the same file in the data folder', () => {
        const manager = getSelfCheckManager()
        manager.reportToolFailure('browser_open')
        manager.reportToolFailure('browser_open')
        // the same two failures are the "does not work here" memory
        expect(loadUnavailable().map(item => item.tool)).toEqual(['browser_open'])
        expect(toolHealthFile()).toContain('.nova-data')
        expect(manager.getToolHealthStatus().find(entry => entry.name === 'browser_open')?.consecutiveFailures).toBe(2)
        expect(getCapabilitiesPrompt({ permission: 'owner' })).toContain('browser_open')
        // success heals both views
        manager.reportToolSuccess('browser_open')
        expect(loadUnavailable()).toEqual([])
    })

    it('one failed call is never counted twice (registry and runner both see it)', () => {
        const now = Date.now()
        recordToolOutcome('fax_send', 'failure', {}, now)
        noteToolFailure('fax_send', { reason: 'no modem' }, now + 200)
        const entry = loadToolHealth().find(item => item.name === 'fax_send')!
        expect(entry.consecutiveFailures).toBe(1)
        expect(entry.reason).toBe('no modem')
        expect(isToolUnavailable(entry)).toBe(false)
        // a second, separate failing call counts
        noteToolFailure('fax_send', { reason: 'no modem' }, now + 20_000)
        expect(isToolUnavailable(loadToolHealth().find(item => item.name === 'fax_send')!)).toBe(true)
    })

    it('Gegenprobe: a single failure is no verdict; clearing forgets it', () => {
        recordUnavailable('sms_send', 'gateway down')
        // one failure is remembered, but it is no "does not work here" statement in the prompt
        expect(getCapabilitiesPrompt({ permission: 'owner' })).toBe('')
        recordToolOutcome('sms_send', 'failure', {}, Date.now() + 60_000)
        expect(loadUnavailable().map(item => item.tool)).toEqual(['sms_send'])
        clearToolFailures('sms_send')
        expect(loadUnavailable()).toEqual([])
    })
})