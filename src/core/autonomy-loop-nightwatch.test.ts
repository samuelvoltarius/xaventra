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
    getSelfGoalEngine: () => ({ getNextGoal: () => null, completeGoal: () => { }, failGoal: () => { }, recordGoalFailure: () => ({ failures: 1, paused: false }) }),
}))
import { triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

// P8: thinking and software scout default to on at the Main; this test is about other loop phases.
setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })

const allOff = { health: false, inbound: false, logs: false, uptime: false }
let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightwatch-loop-'))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

// 2.82.0 ein Wächter: the Nachtwache runs only in the Wächter (watch/runtime.ts).
// The loop neither probes nor journals nor reports it — with the flag on or off.
describe('autonomy loop: keine eigene Nachtwache mehr', () => {
    it.each([false, true])('probt nicht und meldet nichts (nightwatch=%s)', async flag => {
        const configPath = join(dir, 'nightwatch.json')
        writeFileSync(configPath, JSON.stringify({ version: 1, intervalMinutes: 30, hosts: {}, checks: [{ id: 'dead', label: 'Toter Dienst', kind: 'http', url: 'http://127.0.0.1:9/health', timeoutMs: 2000 }] }))
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: flag },
            nightwatch: { configPath, journalDir: join(dir, `journal-${flag}`) } })
        const report = await triggerAutonomyCheck()
        expect(report.checks.filter(check => check.source === 'nightwatch')).toEqual([])
        expect(() => readdirSync(join(dir, `journal-${flag}`))).toThrow()
    })
})
