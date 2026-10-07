/**
 * 2.89 (review: 40 of 77 runs were failing self-goals): a self-goal that fails
 * twice is paused. Real goal store, real self-goal engine, the think function is
 * the real pipeline path's failure text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GoalManager, SELF_GOAL_OWNER, setGoalManager } from './goal-manager.js'
import { getSelfGoalEngine } from '../intelligence/autonomy-engine.js'
import { runSelfGoalStep, selfGoalFailure } from './autonomy-loop.js'

const dir = mkdtempSync(join(tmpdir(), 'self-goal-pause-'))
afterAll(() => setGoalManager(new GoalManager(join(dir, 'reset.json'))))

function freshGoal(title: string) {
    const manager = new GoalManager(join(dir, `${Math.random().toString(16).slice(2)}.json`))
    setGoalManager(manager)
    return manager.create({ userId: SELF_GOAL_OWNER, title, origin: 'selbst', reason: 'Wartung', dependencies: [], priority: 30, status: 'active' } as any)
}

describe('self-goals pause after two failed runs', () => {
    it('two failures → paused, a third cycle does not run it again', async () => {
        const goal = freshGoal('Prüfe die Log-Dateien auf wiederkehrende Warnungen')
        const engine = getSelfGoalEngine()
        const think = vi.fn(async () => 'Die Aktion wurde versucht, ist aber fehlgeschlagen:\nGoverned tool execution stopped')
        expect(await runSelfGoalStep(engine, think)).toBe('failed')
        expect(await runSelfGoalStep(engine, think)).toBe('paused')
        expect(await runSelfGoalStep(engine, think)).toBe('none')
        expect(think).toHaveBeenCalledTimes(2)
        const { getGoalManager } = await import('./goal-manager.js')
        const stored = getGoalManager().list(SELF_GOAL_OWNER).find(item => item.id === goal.id)
        expect(stored?.status).toBe('blocked')
        expect(stored?.result).toMatch(/^Pausiert nach 2 Fehlversuchen/)
    })

    it('a thrown run counts as a failure too', async () => {
        freshGoal('Fasse die Fehlerberichte der Woche zusammen')
        const engine = getSelfGoalEngine()
        const think = vi.fn(async () => { throw new Error('Governed tool execution stopped') })
        expect(await runSelfGoalStep(engine, think)).toBe('failed')
        expect(await runSelfGoalStep(engine, think)).toBe('paused')
    })

    it('Gegenprobe: a usable result completes the goal, one failure alone does not pause', async () => {
        const goal = freshGoal('Liste die größten Ordner im Workspace auf')
        const engine = getSelfGoalEngine()
        const think = vi.fn()
            .mockResolvedValueOnce('Fehler aufgetreten: provider 500')
            .mockResolvedValueOnce('Erledigt.\nGOAL_DONE: drei große Ordner gefunden und notiert')
        expect(await runSelfGoalStep(engine, think)).toBe('failed')
        expect(await runSelfGoalStep(engine, think)).toBe('done')
        const { getGoalManager } = await import('./goal-manager.js')
        expect(getGoalManager().list(SELF_GOAL_OWNER).find(item => item.id === goal.id)?.status).toBe('completed')
    })

    it('failure detection', () => {
        expect(selfGoalFailure('')).toBe('leere Antwort')
        expect(selfGoalFailure('GOAL_DONE: alles geprüft, keine Warnungen')).toBeNull()
        expect(selfGoalFailure('Die Anfrage hat das Zeitlimit überschritten und wurde abgebrochen.')).toBeTruthy()
        expect(selfGoalFailure('Drei Warnungen gefunden, alle harmlos und dokumentiert.')).toBeNull()
    })
})
