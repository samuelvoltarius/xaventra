import { beforeEach, describe, expect, it } from 'vitest'
import { clearServerUnreachable, isEndpointKnownDead, isServerUnreachable, markServerUnreachable, resetServerHealthForTests } from './nova-llm-sdk.js'

const URL_A = 'http://192.0.2.10:11434'
beforeEach(() => resetServerHealthForTests())

describe('dead endpoint memory (2.89.8, U3)', () => {
    it('stretches the hold with consecutive failures and resets after an answer', () => {
        let now = 1_000_000
        markServerUnreachable(URL_A, now)
        expect(isServerUnreachable(URL_A, now + 5 * 60_000 - 1)).toBe(true)
        now += 5 * 60_000 + 10_000
        expect(isServerUnreachable(URL_A, now)).toBe(false)           // half-open try allowed
        markServerUnreachable(URL_A, now)                              // fails again -> 30 min
        expect(isServerUnreachable(URL_A, now + 29 * 60_000)).toBe(true)
        now += 31 * 60_000
        expect(isServerUnreachable(URL_A, now)).toBe(false)
        markServerUnreachable(URL_A, now)                              // third failure -> 3 h, known dead
        expect(isServerUnreachable(URL_A, now + 2 * 60 * 60_000)).toBe(true)
        expect(isEndpointKnownDead(URL_A)).toBe(true)
        clearServerUnreachable(URL_A)                                  // it answered again
        expect(isEndpointKnownDead(URL_A)).toBe(false)
        markServerUnreachable(URL_A, now)
        expect(isServerUnreachable(URL_A, now + 5 * 60_000 + 1)).toBe(false)
    })

    it('marks inside one request count once', () => {
        const now = 5_000_000
        markServerUnreachable(URL_A, now); markServerUnreachable(URL_A, now + 10)
        expect(isServerUnreachable(URL_A, now + 5 * 60_000 + 11)).toBe(false)
    })
})
