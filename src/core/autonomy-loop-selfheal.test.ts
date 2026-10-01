import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({ value: true }))
const selfHeal = vi.hoisted(() => ({ calls: [] as Array<{ isMain: boolean; nightwatchJournalDir?: string }>, order: [] as string[] }))

vi.mock('./validator-failure-escalation.js', () => ({ reconcileValidatorFailures: () => 0 }))
vi.mock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => authority.value }))
vi.mock('../doctor/failure-research-coordinator.js', () => ({ getFailureResearchCoordinator: () => ({ investigateNext: async () => null }) }))
vi.mock('./message-pipeline.js', () => ({ getIdleMinutes: () => 0, getMinutesSinceLastSelfThink: () => 0, trackSelfThink: () => { } }))
vi.mock('./autonomous-executor.js', () => ({ getActiveMission: () => null, getMissionQueue: () => [] }))
vi.mock('../intelligence/autonomy-engine.js', () => ({ getSelfGoalEngine: () => ({ getNextGoal: () => null, completeGoal: () => { }, failGoal: () => { } }) }))
vi.mock('./croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule: async () => { } }) }))
vi.mock('../doctor/self-heal-runtime.js', () => ({
    // 2.82.0: the loop uses the one self-heal trigger like Wächter and missions.
    triggerSelfHeal: async (options: { isMain: boolean; reason: string; nightwatchJournalDir?: string }) => {
        selfHeal.calls.push({ isMain: options.isMain, nightwatchJournalDir: options.nightwatchJournalDir })
        selfHeal.order.push(`selbstheilung:${options.reason}`)
        // Even a notifiable finding must never reach the owner from a worker.
        return { ran: true, note: 'gelaufen', checks: [{ source: 'selbstheilung', severity: 'warning', message: 'Platte fast voll: 95 %', timestamp: Date.now(), requiresNotification: true }] }
    },
}))

import { startAutonomyLoop, stopAutonomyLoop, triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

// P8: thinking and software scout default to on at the Main; this test is about other loop phases.
setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })

const notify = vi.fn(async (_message: string) => { })
const allOff = { health: false, reminders: false, inbound: false, logs: false, uptime: false }

beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    await startAutonomyLoop(notify, { enabled: true, quietHoursStart: -1, quietHoursEnd: -1, checks: allOff as any })
    vi.useRealTimers()
})

afterAll(() => stopAutonomyLoop())

beforeEach(() => {
    selfHeal.calls.length = 0
    selfHeal.order.length = 0
    notify.mockClear()
})

describe('autonomy loop: Selbstheilung as its own phase (Stufe 3)', () => {
    it('runs through the one trigger on the Main and feeds the normal alarm path (no own Nachtwache)', async () => {
        authority.value = true
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, quietHoursEnd: -1, checks: { ...allOff, nightwatch: true }, nightwatch: { configPath: 'x.json', journalDir: 'nw-journal' } })
        const report = await triggerAutonomyCheck()
        expect(selfHeal.order).toEqual(['selbstheilung:autonomie-schleife'])
        expect(selfHeal.calls).toEqual([{ isMain: true, nightwatchJournalDir: 'nw-journal' }])
        expect(report.checks.some(check => check.source === 'selbstheilung')).toBe(true)
        expect(notify).toHaveBeenCalledTimes(1)
        expect(notify.mock.calls[0][0]).toMatch(/selbstheilung/)
    })

    it('a worker without the Main lease heals locally but never notifies the owner', async () => {
        authority.value = false
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, quietHoursEnd: -1, checks: { ...allOff, nightwatch: false } })
        const report = await triggerAutonomyCheck()
        expect(selfHeal.calls).toEqual([{ isMain: false, nightwatchJournalDir: undefined }])
        expect(report.summary).toMatch(/Standby/)
        expect(report.checks).toEqual([])
        expect(notify).not.toHaveBeenCalled()
    })
})
