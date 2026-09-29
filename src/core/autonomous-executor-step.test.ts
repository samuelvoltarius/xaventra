import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../mesh/leader-election.js', () => ({
    getServiceFencingToken: () => ({ epoch: 1, token: 'fence-token' }),
    stopLeaseRenewal: () => { },
}))
vi.mock('../mesh/mesh-registry.js', () => ({
    acquireMissionOwnership: async () => ({ ownerNode: 'fixture-node', leaseEpoch: 1, fencingToken: 'fence-token' }),
    publishMissionCheckpoint: async () => true,
}))

afterEach(() => vi.useRealTimers())

function step(id: number) {
    return { id, description: `Schritt ${id}`, command: `mache ${id}`, status: 'pending' as const, retries: 0 }
}

async function seed(status: 'active' | 'paused', handleMessage: (...args: any[]) => Promise<void>) {
    vi.resetModules()
    const dataDir = join(process.cwd(), '.nova-data')
    writeFileSync(join(dataDir, 'mission-config.json'), JSON.stringify({ timeoutPerStep: 1_000, delayBetweenSteps: 10, notifyEveryNSteps: 99 }))
    writeFileSync(join(dataDir, 'missions.json'), JSON.stringify({
        active: {
            id: `step-${status}`, goal: 'Fixture-Ziel', summary: '', steps: [step(1), step(2), step(3)], currentStep: 0,
            status, createdBy: 'fixture-user', channel: 'internal', createdAt: 1, progressUpdates: [],
            ownerNode: 'fixture-node', leaseEpoch: 1, fencingToken: 'fence-token',
        },
        history: [],
        queue: [],
    }))
    const executor = await import('./autonomous-executor.js')
    executor.initMissionEngine({ handleMessage: handleMessage as any, notifyFn: async () => { }, llm: null, state: {} })
    return executor
}

describe('mission step execution', () => {
    it('never re-runs a timed-out step while the first run may still execute (R2 A1)', async () => {
        vi.useFakeTimers()
        const handleMessage = vi.fn(() => new Promise<void>(() => { }))
        const executor = await seed('active', handleMessage)
        await vi.advanceTimersByTimeAsync(5_000 + 60_000)
        expect(handleMessage).toHaveBeenCalledTimes(1)
        const mission = executor.getActiveMission()!
        expect(mission.status).toBe('paused')
        expect(mission.steps[0].status).toBe('failed')
        expect(mission.currentStep).toBe(1)
    })

    it('a step finishing after cancel does not touch the next mission (R2 A2)', async () => {
        vi.useFakeTimers()
        const resolvers: Array<() => void> = []
        const handleMessage = vi.fn(() => new Promise<void>(resolve => { resolvers.push(resolve) }))
        const executor = await seed('active', handleMessage)
        await vi.advanceTimersByTimeAsync(5_100)
        expect(handleMessage).toHaveBeenCalledTimes(1)

        executor.cancelMission()
        const next = await executor.startMission('Neues Fixture-Ziel mit Inhalt', 'fixture-user', 'internal')
        await vi.advanceTimersByTimeAsync(100)
        expect(handleMessage).toHaveBeenCalledTimes(2)

        resolvers[0]()
        await vi.advanceTimersByTimeAsync(500)
        expect(executor.getActiveMission()?.id).toBe(next.id)
        expect(executor.getActiveMission()?.currentStep).toBe(0)
        expect(executor.getActiveMission()?.progressUpdates.some(line => line.includes('Schritt 1'))).toBe(false)
        expect(handleMessage).toHaveBeenCalledTimes(2)
    })

    it('does not silently overwrite a paused mission (R2 A15)', async () => {
        const executor = await seed('paused', vi.fn(async () => { }))
        await expect(executor.startMission('Anderes Fixture-Ziel', 'fixture-user', 'internal')).rejects.toThrow(/pausierte Mission/)
        expect(executor.getActiveMission()?.id).toBe('step-paused')
        expect(executor.getActiveMission()?.status).toBe('paused')
    })
})
