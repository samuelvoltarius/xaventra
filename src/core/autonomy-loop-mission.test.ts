import { afterEach, describe, expect, it, vi } from 'vitest'

const executorState = vi.hoisted(() => ({ active: null as any, queue: [] as any[] }))
const nextGoal = vi.hoisted(() => ({ value: null as any }))
vi.mock('./validator-failure-escalation.js', () => ({ reconcileValidatorFailures: () => 0 }))
vi.mock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
vi.mock('../doctor/failure-research-coordinator.js', () => ({ getFailureResearchCoordinator: () => ({ investigateNext: async () => null }) }))
vi.mock('./message-pipeline.js', () => ({
    getIdleMinutes: () => 60,
    getMinutesSinceLastSelfThink: () => 999,
    trackSelfThink: () => { },
}))
vi.mock('./autonomous-executor.js', () => ({
    getActiveMission: () => executorState.active,
    getMissionQueue: () => executorState.queue,
}))
vi.mock('../intelligence/autonomy-engine.js', () => ({
    getSelfGoalEngine: () => ({ getNextGoal: () => nextGoal.value, completeGoal: () => { }, failGoal: () => { } }),
}))
import { setAutonomyThinkCallback, triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

// P8: thinking and software scout default to on at the Main; this test is about other loop phases.
setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })

updateAutonomyConfig({ enabled: true, socialCheckIns: false, quietHoursStart: -1,
    checks: { health: false, reminders: false, inbound: false, logs: false, uptime: false } })

afterEach(() => {
    executorState.active = null
    executorState.queue = []
    nextGoal.value = null
    delete (globalThis as any).__novaState
})

describe('autonomy loop and mission executor', () => {
    it('does not start a parallel tool run on the step the mission executor owns (R2 A3)', async () => {
        executorState.active = { goal: 'Fixture-Mission', status: 'active', steps: [{ status: 'active', description: 'Schritt 1' }] }
        executorState.queue = [{ goal: 'wartet' }]
        const thinkFn = vi.fn(async () => 'ok')
        setAutonomyThinkCallback(thinkFn)
        await triggerAutonomyCheck()
        expect(thinkFn).not.toHaveBeenCalled()
    })

    it('returns a report when a self-goal yields an empty answer (R2 A13)', async () => {
        ;(globalThis as any).__novaState = { startTime: Date.now() - 60 * 60_000 }
        nextGoal.value = { id: 'g1', goal: 'Fixture self goal' }
        setAutonomyThinkCallback(vi.fn(async () => ''))
        const report = await triggerAutonomyCheck()
        expect(report?.summary).toBeTypeOf('string')
    })

    it('never runs two autonomy cycles at the same time (R2 A14)', async () => {
        ;(globalThis as any).__novaState = { startTime: Date.now() - 60 * 60_000 }
        nextGoal.value = { id: 'g2', goal: 'Langsames Fixture-Ziel' }
        const thinkFn = vi.fn<(prompt: string) => Promise<string>>()
            .mockImplementationOnce(() => new Promise<string>(() => { }))
            .mockResolvedValue('')
        setAutonomyThinkCallback(thinkFn)
        void triggerAutonomyCheck()
        await vi.waitFor(() => expect(thinkFn).toHaveBeenCalledTimes(1))
        const second = await triggerAutonomyCheck()
        expect(second?.summary).toMatch(/Übersprungen/)
        expect(thinkFn).toHaveBeenCalledTimes(1)
    })
})
