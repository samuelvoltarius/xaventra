import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./validator-failure-escalation.js', () => ({ reconcileValidatorFailures: () => 0 }))
vi.mock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
vi.mock('../doctor/failure-research-coordinator.js', () => ({ getFailureResearchCoordinator: () => ({ investigateNext: async () => null }) }))
vi.mock('./message-pipeline.js', () => ({
    getIdleMinutes: () => 0,
    getMinutesSinceLastSelfThink: () => 0,
    trackSelfThink: () => { },
}))
vi.mock('./autonomous-executor.js', () => ({ getActiveMission: () => null, getMissionQueue: () => [] }))
vi.mock('../intelligence/autonomy-engine.js', () => ({
    getSelfGoalEngine: () => ({ getNextGoal: () => null, completeGoal: () => { }, failGoal: () => { } }),
}))
import { triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

// P8: thinking and software scout default to on at the Main; this test is about other loop phases.
setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })

const allOff = { health: false, reminders: false, inbound: false, logs: false, uptime: false }
let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightwatch-loop-'))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe('autonomy loop: Nachtwache as check source', () => {
    it('stays off unless the flag is set', async () => {
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: false },
            nightwatch: { configPath: join(dir, 'missing.json'), journalDir: join(dir, 'journal') } })
        const report = await triggerAutonomyCheck()
        expect(report.checks.filter(check => check.source === 'nightwatch')).toEqual([])
        expect(() => readdirSync(join(dir, 'journal'))).toThrow()
    })

    it('reports a missing config as a visible warning, never as silence', async () => {
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: true },
            nightwatch: { configPath: join(dir, 'missing.json'), journalDir: join(dir, 'journal-missing') } })
        const report = await triggerAutonomyCheck()
        const watch = report.checks.filter(check => check.source === 'nightwatch')
        expect(watch).toHaveLength(1)
        expect(watch[0]).toMatchObject({ severity: 'warning', requiresNotification: true })
        expect(watch[0].message).toMatch(/Nachtwache läuft nicht/)
        expect(readdirSync(join(dir, 'journal-missing')).some(name => name.endsWith('.jsonl'))).toBe(true)
    })

    it('turns a failing probe into a notifiable finding and journals the run', async () => {
        const configPath = join(dir, 'nightwatch.json')
        // Port 9 on loopback is closed: the http probe observes "down" without any network beyond 127.0.0.1.
        writeFileSync(configPath, JSON.stringify({
            version: 1,
            intervalMinutes: 30,
            hosts: {},
            checks: [{ id: 'dead', label: 'Toter Dienst', kind: 'http', url: 'http://127.0.0.1:9/health', timeoutMs: 2000 }],
        }))
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: true },
            nightwatch: { configPath, journalDir: join(dir, 'journal-probe') } })
        const report = await triggerAutonomyCheck()
        const watch = report.checks.filter(check => check.source === 'nightwatch')
        expect(watch).toHaveLength(1)
        expect(watch[0].requiresNotification).toBe(true)
        expect(watch[0].severity).not.toBe('info')
        expect(watch[0].message).toMatch(/Toter Dienst/)
        expect(readdirSync(join(dir, 'journal-probe')).some(name => name.endsWith('.jsonl'))).toBe(true)
    }, 15_000)
})
