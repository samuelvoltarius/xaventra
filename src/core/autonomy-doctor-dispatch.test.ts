import { describe, expect, it, vi } from 'vitest'
const investigate = vi.hoisted(() => vi.fn(async () => null))
const reconcile = vi.hoisted(() => vi.fn(() => 0))
vi.mock('./validator-failure-escalation.js', () => ({ reconcileValidatorFailures: reconcile }))
vi.mock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
vi.mock('../doctor/failure-research-coordinator.js', () => ({ getFailureResearchCoordinator: () => ({ investigateNext: investigate }) }))
import { DOCTOR_WARMUP_SECONDS, setAutonomyThinkCallback, setDoctorResearchWorker, triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

// P8: thinking and software scout default to on at the Main; this test is about other loop phases.
setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })

describe('Doctor is reachable in the actual autonomy cycle', () => {
    it('dispatches pending investigation even while ordinary self-goals are gated during startup', async () => {
        updateAutonomyConfig({ enabled: true, socialCheckIns: false,
            checks: { health: false, inbound: false, logs: false, uptime: false } })
        setAutonomyThinkCallback(async () => '')
        const worker = { hasAuthority: () => true, execute: async () => ({ output: '' }), getRun: () => null }
        setDoctorResearchWorker(worker)
        // 2.84.0 Punkt 1: investigations start after the warm-up (doctor-warmstart.test.ts).
        const uptime = vi.spyOn(process, 'uptime').mockReturnValue(DOCTOR_WARMUP_SECONDS)
        await triggerAutonomyCheck()
        uptime.mockRestore()
        expect(investigate).toHaveBeenCalledExactlyOnceWith(worker)
        expect(reconcile).toHaveBeenCalledOnce()
    })
})
