import { describe, expect, it, vi } from 'vitest'

const selfHeal = vi.hoisted(() => ({ enabled: false, runs: 0 }))
vi.mock('../doctor/self-heal-runtime.js', () => ({
    getSelfHealSettings: () => ({ enabled: selfHeal.enabled }),
    // 2.82.0: an owner Ja goes through the one self-heal trigger as well.
    triggerSelfHeal: async () => { selfHeal.runs++; return { ran: true, checks: [], note: 'Selbstheilung gelaufen' } },
}))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'spark' }))

const { addThought } = await import('../planner/index.js')
const { dispatchThoughtAnswer, rememberWatchAction } = await import('./thought-hub.js')

const thoughtWith = (action: { actionKind: string; node?: string; target?: string }) => {
    const { thought } = addThought({ source: 'waechter', title: `Test ${Math.random()}`, kind: 'vorschlag', permission: 'fragen' })
    rememberWatchAction(thought.id, action)
    return thought.id
}

describe('Gedanken-Hub: Wächter-Aktionen hinter dem Knopf', () => {
    it('Ja on a service restart only records the decision — there is no executor', async () => {
        const result = await dispatchThoughtAnswer(thoughtWith({ actionKind: 'dienst-neustart', target: 'Drucker' }), 'ja', { userId: '1' })
        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/keinen freigegebenen Ausführungsweg/)
    })

    it('Ja on the own self-heal runs the existing cycle only when self-heal is on', async () => {
        selfHeal.enabled = false
        expect((await dispatchThoughtAnswer(thoughtWith({ actionKind: 'self-heal-zyklus', node: 'spark' }), 'ja', { userId: '1' })).ok).toBe(false)
        expect(selfHeal.runs).toBe(0)
        selfHeal.enabled = true
        expect((await dispatchThoughtAnswer(thoughtWith({ actionKind: 'self-heal-zyklus', node: 'spark' }), 'ja', { userId: '1' })).ok).toBe(true)
        expect(selfHeal.runs).toBe(1)
        // Foreign node: no remote path, nothing runs.
        await dispatchThoughtAnswer(thoughtWith({ actionKind: 'self-heal-zyklus', node: 'ns1' }), 'ja', { userId: '1' })
        expect(selfHeal.runs).toBe(1)
    })

    it('an L3 kind is refused even after Ja, and Nein never acts', async () => {
        expect((await dispatchThoughtAnswer(thoughtWith({ actionKind: 'daten-loeschen' }), 'ja', { userId: '1' })).ok).toBe(false)
        selfHeal.enabled = true
        const before = selfHeal.runs
        expect((await dispatchThoughtAnswer(thoughtWith({ actionKind: 'self-heal-zyklus', node: 'spark' }), 'nein', { userId: '1' })).message).toMatch(/Verworfen/)
        expect(selfHeal.runs).toBe(before)
    })
})
