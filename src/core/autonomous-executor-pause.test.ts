import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoalManager, setGoalManager } from './goal-manager.js'
import { getActiveMission, initMissionEngine, pauseMission, type Mission } from './autonomous-executor.js'

afterEach(() => vi.useRealTimers())

function seed(status: 'active' | 'paused') {
    const manager = new GoalManager(join(process.cwd(), '.nova-data', `pause-goals-${status}.json`))
    setGoalManager(manager)
    const plan = manager.createMissionPlan({ missionId: `pause-${status}`, userId: 'fixture-user', goal: 'Inspect fixture',
        steps: [{ title: 'Read', nextAction: 'inspect' }] })
    const mission: Mission = { id: `pause-${status}`, goal: 'Inspect fixture', summary: '', steps: [], currentStep: 0,
        status, createdBy: 'fixture-user', channel: 'internal', createdAt: 1, progressUpdates: [], rootGoalId: plan.root.id }
    writeFileSync(join(process.cwd(), '.nova-data', 'missions.json'), JSON.stringify({ active: mission, history: [], queue: [] }))
    const handleMessage = vi.fn(async () => {})
    initMissionEngine({ handleMessage, notifyFn: async () => {}, llm: null, state: {} })
    return { manager, handleMessage }
}

describe('native mission pause projects into persistent goals', () => {
    it('blocks goal selection when an active mission is explicitly paused', async () => {
        vi.useFakeTimers()
        const { manager, handleMessage } = seed('active')
        // Model an already claimed active mission, not the startup fence wait.
        manager.update(getActiveMission()!.rootGoalId!, { status: 'active' })
        expect(manager.next('fixture-user')).not.toBeNull()
        pauseMission()
        expect(getActiveMission()?.status).toBe('paused')
        expect(manager.next('fixture-user')).toBeNull()
        await vi.advanceTimersByTimeAsync(6_000)
        expect(handleMessage).not.toHaveBeenCalled()
    })

    it('restores a paused checkpoint without losing it or dispatching work', async () => {
        vi.useFakeTimers()
        const { manager, handleMessage } = seed('paused')
        expect(getActiveMission()?.id).toBe('pause-paused')
        expect(getActiveMission()?.status).toBe('paused')
        expect(manager.next('fixture-user')).toBeNull()
        await vi.advanceTimersByTimeAsync(6_000)
        expect(handleMessage).not.toHaveBeenCalled()
    })
})
