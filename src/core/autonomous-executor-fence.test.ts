import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mission lease looks valid; only the nova-main fence is missing.
vi.mock('../mesh/leader-election.js', () => ({
    getServiceFencingToken: () => ({ epoch: 1, token: 'fence-token' }),
    stopLeaseRenewal: () => { },
}))
vi.mock('../mesh/mesh-registry.js', () => ({
    acquireMissionOwnership: async () => ({ ownerNode: 'fixture-node', leaseEpoch: 1, fencingToken: 'fence-token' }),
    publishMissionCheckpoint: async () => true,
}))

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('CL-07 mission lease is a sub-lease of nova-main', () => {
    it('does not start a mission step without a Main fence (enforce) and pauses the mission', async () => {
        vi.stubEnv('NOVA_FENCING_MODE', 'enforce')
        vi.useFakeTimers()
        vi.resetModules()
        const dataDir = join(process.cwd(), '.nova-data')
        writeFileSync(join(dataDir, 'mission-config.json'), JSON.stringify({ timeoutPerStep: 1_000, delayBetweenSteps: 10, notifyEveryNSteps: 99 }))
        writeFileSync(join(dataDir, 'missions.json'), JSON.stringify({
            active: {
                id: 'fence-mission', goal: 'Fixture-Ziel', summary: '', currentStep: 0,
                steps: [{ id: 1, description: 'Schritt 1', command: 'mache 1', status: 'pending', retries: 0 }],
                status: 'active', createdBy: 'fixture-user', channel: 'internal', createdAt: 1, progressUpdates: [],
                ownerNode: 'fixture-node', leaseEpoch: 1, fencingToken: 'fence-token',
            },
            history: [], queue: [],
        }))
        const handleMessage = vi.fn(async () => undefined)
        const executor = await import('./autonomous-executor.js')
        executor.initMissionEngine({ handleMessage: handleMessage as any, notifyFn: async () => { }, llm: null, state: {} })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(handleMessage).not.toHaveBeenCalled()
        const mission = executor.getActiveMission()!
        expect(mission.status).toBe('paused')
        expect(mission.progressUpdates.some(line => line.includes('Main-Fence'))).toBe(true)
    })
})
