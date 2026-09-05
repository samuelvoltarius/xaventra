import { describe, expect, it } from 'vitest'
import { shouldRecoverMission, type Mission } from './autonomous-executor.js'

describe('native mission recovery deduplication', () => {
    it('does not re-import an already reconstructed paused mission', () => {
        const paused = {
            id: 'm-paused',
            goal: 'test',
            summary: 'test',
            steps: [],
            currentStep: 0,
            status: 'paused',
            createdBy: 'system',
            channel: 'internal',
            createdAt: 1,
            progressUpdates: [],
        } satisfies Mission
        expect(shouldRecoverMission(paused)).toBe(false)
        expect(shouldRecoverMission(null)).toBe(true)
    })
})
