import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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

const allOff = { health: false, reminders: false, inbound: false, logs: false, uptime: false }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nightwatch-runner-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('autonomy loop: Nachtwache an den Planer abgegeben', () => {
    it('probt und meldet nicht selbst, wenn der Planer die Nachtwache führt', async () => {
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: true }, nightwatchRunner: 'planner',
            nightwatch: { configPath: join(dir, 'missing.json'), journalDir: join(dir, 'journal') } } as any)
        const report = await triggerAutonomyCheck()
        expect(report.checks.filter(check => check.source === 'nightwatch')).toEqual([])
        expect(() => readdirSync(join(dir, 'journal'))).toThrow()
    })

    it('alter Weg unverändert: ohne Planer probt die Schleife selbst', async () => {
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: true }, nightwatchRunner: 'loop',
            nightwatch: { configPath: join(dir, 'missing.json'), journalDir: join(dir, 'journal-loop') } } as any)
        const report = await triggerAutonomyCheck()
        expect(report.checks.filter(check => check.source === 'nightwatch')).toHaveLength(1)
    })
})
