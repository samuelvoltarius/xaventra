import { describe, expect, it, vi } from 'vitest'
const investigate = vi.hoisted(() => vi.fn(async () => null))
vi.mock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
vi.mock('../doctor/failure-research-coordinator.js', () => ({ getFailureResearchCoordinator: () => ({ investigateNext: investigate }) }))
import { setAutonomyThinkCallback, setDoctorResearchWorker, triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'

describe('Doctor is reachable in the actual autonomy cycle', () => {
    it('dispatches pending investigation even while ordinary self-goals are gated during startup', async () => {
        updateAutonomyConfig({ enabled: true, socialCheckIns: false,
            checks: { health: false, reminders: false, inbound: false, logs: false, uptime: false } })
        setAutonomyThinkCallback(async () => '')
        const worker = { hasAuthority: () => true, execute: async () => ({ output: '' }), getRun: () => null }
        setDoctorResearchWorker(worker)
        await triggerAutonomyCheck()
        expect(investigate).toHaveBeenCalledExactlyOnceWith(worker)
    })
})
