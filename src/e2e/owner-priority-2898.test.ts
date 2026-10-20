/**
 * 2.89.8 (U3): background LLM work steps aside while an owner request runs (real Telegram entry; only the model is scripted).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

describe('2.89.8 U3: the owner is not slowed down by background work', () => {
    it('a learning-service call during an owner turn is deferred (not counted), and runs after the turn', async () => {
        h = await createE2EHarness()
        const runtime = await h.module('runtime/service-runtime.js')
        const activity = await h.module('core/owner-activity.js')
        activity._resetOwnerActivityForTest()
        const manager = runtime.getServiceRuntime()
        let backgroundCalls = 0
        manager.register({ role: 'learning', model: 'e2e', provider: 'local', timeoutMs: 5_000, dailyTokenBudget: 100_000 },
            { complete: async () => { backgroundCalls++; return { content: 'ok' } } })

        let during: unknown
        const result = await h.telegram('Wie spät ist es auf dem Mond?', [async () => {
            during = await manager.complete('learning', 'plane ein Ziel').catch((error: Error) => error)
            return { text: 'Keine Ahnung, aber ich bleibe dran.' }
        }])
        expect(result.error).toBeUndefined()
        expect(during).toBeInstanceOf(Error)
        expect(String(during)).toMatch(/owner request running/)
        expect(backgroundCalls).toBe(0)
        expect(manager.getStatus().learning.calls).toBe(0)
        expect(manager.getStatus().learning.failures).toBe(0)

        await new Promise(resolve => setTimeout(resolve, activity.OWNER_GRACE_MS + 200))
        expect((await manager.complete('learning', 'plane ein Ziel')).content).toBe('ok')
        expect(backgroundCalls).toBe(1)
    }, T)

    it('a system-authored or guest turn does not hold background work back', async () => {
        h = await createE2EHarness()
        const activity = await h.module('core/owner-activity.js')
        activity._resetOwnerActivityForTest()
        expect(activity.ownerTurnActive()).toBe(false)
        await activity.runAsPotentialOwnerTurn(async () => {
            activity.markOwnerTurn('user', false)
            activity.markOwnerTurn('owner', true)
            expect(activity.ownerTurnActive()).toBe(false)
        })
    }, T)
})
