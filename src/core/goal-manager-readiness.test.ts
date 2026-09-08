import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalManager, type GoalStatus } from './goal-manager.js'
import { atomicWriteJsonSync } from './atomic-storage.js'

const roots: string[] = []
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'xaventra-goal-readiness-'))
    roots.push(root)
    const path = join(root, 'goals.json')
    return { path, manager: new GoalManager(path) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const input = { userId: 'fixture-user', title: 'Inspect fixture', dependencies: [], priority: 50 }

describe('Goal readiness preserves explicit lifecycle decisions', () => {
    it('does not resume a blocked goal on selection, prompt generation or reload', () => {
        const { manager, path } = fixture()
        const goal = manager.create({ ...input, status: 'blocked' })
        expect(manager.next(input.userId)).toBeNull()
        expect(manager.getPrompt(input.userId)).not.toContain('Priorisierter nächster Schritt')
        const restored = new GoalManager(path)
        expect(restored.next(input.userId)).toBeNull()
        expect(restored.list(input.userId)[0].status).toBe('blocked')
        restored.update(goal.id, { status: 'active' })
        expect(restored.next(input.userId)?.id).toBe(goal.id)
    })

    it('does not let completion of a prerequisite undo an explicit block', () => {
        const { manager, path } = fixture()
        const prerequisite = manager.create(input)
        const goal = manager.create({ ...input, title: 'Wait for operator', dependencies: [prerequisite.id] })
        manager.update(goal.id, { status: 'blocked' })
        manager.update(prerequisite.id, { status: 'completed' })
        expect(new GoalManager(path).next(input.userId)).toBeNull()
        expect(manager.list(input.userId).find(item => item.id === goal.id)?.status).toBe('blocked')
    })

    it('can unblock a dependency-only failure after explicit prerequisite recovery', () => {
        const { manager, path } = fixture()
        const prerequisite = manager.create(input)
        const goal = manager.create({ ...input, title: 'Dependent', dependencies: [prerequisite.id] })
        manager.update(prerequisite.id, { status: 'failed' })
        expect(manager.list(input.userId).find(item => item.id === goal.id)?.status).toBe('blocked')
        const restored = new GoalManager(path)
        restored.update(prerequisite.id, { status: 'completed' })
        expect(restored.next(input.userId)?.id).toBe(goal.id)
    })

    it.each<GoalStatus>(['blocked', 'cancelled', 'failed', 'completed'])(
        'does not schedule children or overwrite a %s parent when a child completes', status => {
            const { manager, path } = fixture()
            const plan = manager.createMissionPlan({ missionId: 'fixture', userId: input.userId, goal: 'Parent',
                steps: [{ title: 'First', nextAction: 'inspect' }, { title: 'Second', nextAction: 'inspect' }] })
            manager.update(plan.root.id, { status })
            expect(manager.next(input.userId)).toBeNull()
            manager.update(plan.steps[0].id, { status: 'completed' })
            expect(manager.next(input.userId)).toBeNull()
            manager.update(plan.steps[1].id, { status: 'completed' })
            expect(new GoalManager(path).list(input.userId).find(goal => goal.id === plan.root.id)?.status).toBe(status)
        },
    )

    it('rejects unresolved prerequisites even for explicitly active goals', () => {
        const { manager } = fixture()
        manager.create({ ...input, status: 'active', dependencies: ['missing'] })
        expect(manager.next(input.userId)).toBeNull()
    })

    it('rejects cyclic parent graphs without looping', () => {
        const { manager } = fixture()
        manager.create({ ...input, id: 'a', parentId: 'b' })
        manager.create({ ...input, id: 'b', parentId: 'a' })
        manager.create({ ...input, id: 'leaf', parentId: 'a' })
        expect(manager.next(input.userId)).toBeNull()
    })

    it('keeps a replayed completed mission completed', () => {
        const { manager, path } = fixture()
        const mission = { missionId: 'fixture', userId: input.userId, goal: 'Parent',
            steps: [{ title: 'First', nextAction: 'inspect' }] }
        const plan = manager.createMissionPlan(mission)
        manager.update(plan.steps[0].id, { status: 'completed' })
        const restored = new GoalManager(path)
        expect(restored.createMissionPlan(mission).root.status).toBe('completed')
        expect(restored.next(input.userId)).toBeNull()
    })

    it('does not infer a resumable reason for legacy blocked records', () => {
        const { manager, path } = fixture()
        const goal = manager.create({ ...input, status: 'blocked' })
        delete goal.blockedBy
        atomicWriteJsonSync(path, { version: 1, goals: [goal] })
        const restored = new GoalManager(path)
        restored.update(goal.id, { priority: 90, nextAction: 'still waiting' })
        expect(restored.next(input.userId)).toBeNull()
        expect(restored.list(input.userId)[0].status).toBe('blocked')
    })

    it('lets an explicit block override an automatic dependency block', () => {
        const { manager } = fixture()
        const dependency = manager.create(input)
        const goal = manager.create({ ...input, dependencies: [dependency.id] })
        manager.update(dependency.id, { status: 'failed' })
        manager.update(goal.id, { status: 'blocked' })
        manager.update(dependency.id, { status: 'completed' })
        expect(manager.next(input.userId)).toBeNull()
    })

    it('persists readiness changes discovered on reading a legacy planned record', () => {
        const { manager, path } = fixture()
        const goal = manager.create({ ...input, status: 'planned' })
        expect(manager.next(input.userId)?.id).toBe(goal.id)
        expect(new GoalManager(path).list(input.userId)[0].status).toBe('active')
    })

    it('does not select orphaned descendants', () => {
        const { manager } = fixture()
        manager.create({ ...input, parentId: 'missing' })
        expect(manager.next(input.userId)).toBeNull()
    })
})
