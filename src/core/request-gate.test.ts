import { describe, expect, it } from 'vitest'
import { RequestGate } from './request-gate.js'

// R2 core-n-z #31: an invalid concurrency limit must not hang every request.

describe('RequestGate limits (R2 NZ-31)', () => {
    it.each([Number.NaN, 0, -1, 1.5])('falls back to a working limit for maxConcurrent=%s', async limit => {
        const gate = new RequestGate(limit, 10)
        const result = await Promise.race([
            gate.run(async () => 'done'),
            new Promise(resolve => setTimeout(() => resolve('hung'), 200)),
        ])
        expect(result).toBe('done')
        expect(gate.getStats().maxConcurrent).toBe(4)
    })

    it('keeps valid limits', () => {
        expect(new RequestGate(2, 5).getStats()).toMatchObject({ maxConcurrent: 2, maxQueue: 5 })
    })
})
