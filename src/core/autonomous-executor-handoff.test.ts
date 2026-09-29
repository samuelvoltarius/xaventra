import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../mesh/leader-election.js', () => ({ getServiceFencingToken: () => null, stopLeaseRenewal: () => { } }))
vi.mock('../mesh/mesh-registry.js', () => ({ acquireMissionOwnership: async () => null, publishMissionCheckpoint: async () => true }))

async function freshExecutor() {
    vi.resetModules()
    writeFileSync(join(process.cwd(), '.nova-data', 'missions.json'), JSON.stringify({ active: null, history: [], queue: [] }))
    const executor = await import('./autonomous-executor.js')
    executor.initMissionEngine({ handleMessage: vi.fn(async () => { }) as any, notifyFn: async () => { }, llm: null, state: {} })
    return executor
}

const checkpoint = (createdBy: string, channel = 'telegram') => JSON.stringify({
    id: `handoff-${createdBy}`, goal: 'Fixture', summary: '', steps: [], currentStep: 0, status: 'paused',
    createdBy, channel, createdAt: 1, progressUpdates: [],
})
const ownership = { ownerNode: 'local-node', leaseEpoch: 2, fencingToken: 't' }

describe('mission handoff identity (R2 UEB-27)', () => {
    it('never adopts the owner/Telegram identity from a checkpoint', async () => {
        const executor = await freshExecutor()
        expect(executor.acceptMissionHandoff(checkpoint('123456789'), ownership)).toBe(true)
        expect(executor.getActiveMission()).toMatchObject({ channel: 'mesh', createdBy: 'mesh:unverified' })
    })

    it('runs as the verified source node when it is known', async () => {
        const executor = await freshExecutor()
        expect(executor.acceptMissionHandoff(checkpoint('123456789'), ownership, 'spark')).toBe(true)
        expect(executor.getActiveMission()).toMatchObject({ channel: 'mesh', createdBy: 'mesh:spark' })
    })

    it('keeps a mesh identity already rebound by the mesh layer', async () => {
        const executor = await freshExecutor()
        expect(executor.acceptMissionHandoff(checkpoint('mesh:pi5', 'mesh'), ownership)).toBe(true)
        expect(executor.getActiveMission()).toMatchObject({ channel: 'mesh', createdBy: 'mesh:pi5' })
    })
})
