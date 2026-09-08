import { describe, expect, it, vi } from 'vitest'
import { createSingleFlight } from './single-flight.js'

describe('lifecycle single flight', () => {
    it('shares concurrent calls, then permits a later restart', async () => {
        const run = createSingleFlight()
        const state = {}
        let release!: () => void
        const operation = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
        const first = run(state, operation)
        expect(run(state, operation)).toBe(first)
        await Promise.resolve()
        expect(operation).toHaveBeenCalledTimes(1)
        release()
        await first
        await run(state, async () => {})
    })

    it('releases rejected work without blocking other runtimes', async () => {
        const run = createSingleFlight()
        const state = {}
        await expect(run(state, async () => { throw Error('connect failed') })).rejects.toThrow('connect failed')
        const retry = vi.fn(async () => {})
        await Promise.all([run(state, retry), run({}, retry)])
        expect(retry).toHaveBeenCalledTimes(2)
    })
})
