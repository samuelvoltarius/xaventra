import { describe, expect, it } from 'vitest'
import { ActionLifecycle } from './action-lifecycle.js'

describe('ActionLifecycle', () => {
    it('does not fulfill or learn from discovery', () => {
        const lifecycle = new ActionLifecycle()
        lifecycle.record('nova_capabilities', true)
        expect(lifecycle.isFulfilled()).toBe(false)
        expect(lifecycle.canLearn('nova_capabilities', true)).toBe(false)
        expect(lifecycle.getSnapshot().phase).toBe('resolve')
    })

    it('learns only after a verified effect tool', () => {
        const lifecycle = new ActionLifecycle()
        lifecycle.record('generate_image', true)
        expect(lifecycle.isFulfilled()).toBe(true)
        expect(lifecycle.canLearn('generate_image', true)).toBe(true)
        lifecycle.markLearned()
        expect(lifecycle.getSnapshot().phase).toBe('learn')
    })

    it('tracks a skill proposal as honest progress without claiming fulfillment', () => {
        const lifecycle = new ActionLifecycle()
        lifecycle.record('build_skill', true)
        expect(lifecycle.isFulfilled()).toBe(false)
        expect(lifecycle.isAwaitingApproval()).toBe(true)
        expect(lifecycle.canLearn('build_skill', true)).toBe(false)
    })
})
