import { beforeEach, describe, expect, it } from 'vitest'
import { awaitRuntimeReady, isRuntimeReady, markRuntimeNotReady, markRuntimeReady } from './runtime-readiness.js'

describe('runtime readiness gate', () => {
    beforeEach(() => markRuntimeNotReady())

    it('holds work until the runtime is ready', async () => {
        let released = false
        const waiting = awaitRuntimeReady(1_000).then(() => { released = true })
        await Promise.resolve()
        expect(released).toBe(false)
        markRuntimeReady()
        await waiting
        expect(released).toBe(true)
        expect(isRuntimeReady()).toBe(true)
    })
})
