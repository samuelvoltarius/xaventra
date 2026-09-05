import { describe, expect, it } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profiles.js'

describe('runtime profiles', () => {
    it('composes deterministic capabilities and keeps workers channel-free', () => {
        const worker = resolveRuntimeProfile({ profile: 'worker' })
        expect(worker.mainEligible).toBe(false)
        expect(worker.channels).toBe('disabled')
        expect(worker.capabilities).toContain('signed-work')
        expect(() => resolveRuntimeProfile({ profile: 'home', hotReload: true })).toThrow(/developer/)
    })
})
