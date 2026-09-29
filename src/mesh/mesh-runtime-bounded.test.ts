import { describe, expect, it } from 'vitest'
import { rememberBounded } from './mesh-transport-runtime.js'

// MI-17: runtime idempotency/result caches must not grow for the whole uptime.

describe('MI-17 bounded mesh runtime caches', () => {
    it('evicts the oldest entries beyond the limit and refreshes re-written keys', () => {
        const map = new Map<string, number>()
        for (let i = 0; i < 10; i++) rememberBounded(map, `k${i}`, i, 5)
        expect([...map.keys()]).toEqual(['k5', 'k6', 'k7', 'k8', 'k9'])
        rememberBounded(map, 'k5', 55, 5)
        rememberBounded(map, 'k10', 10, 5)
        expect([...map.keys()]).toEqual(['k7', 'k8', 'k9', 'k5', 'k10'])
    })
})
