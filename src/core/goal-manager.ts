import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'

export type GoalStatus = 'planned' | 'active' | 'blocked' | 'completed' | 'failed' | 'cancelled'

export interface NovaGoal {
    id: string
    userId: string
    title: string
    parentId?: string
    dependencies: string[]
    priority: number
    deadline?: string
    status: GoalStatus
    nextAction?: string
    sourceMissionId?: string
    outcomeRunIds: string[]
    evidenceRefs: string[]
    progress: number
    createdAt: string
    updatedAt: string
}

interface GoalFile { version: 1; updatedAt: string; goals: NovaGoal[] }

export class GoalManager {
    private goals: NovaGoal[] = []

    constructor(private readonly path = getNovaDataDir('goals.json')) {
        try {
            if (existsSync(path)) this.goals = (JSON.parse(readFileSync(path, 'utf8')) as GoalFile).goals || []
        } catch { this.goals = [] }
    }

    create(input: Omit<NovaGoal, 'id' | 'status' | 'outcomeRunIds' | 'evidenceRefs' | 'progress' | 'createdAt' | 'updatedAt'> & { id?: string; status?: GoalStatus }): NovaGoal {
        const now = new Date().toISOString()
        const stable = input.sourceMissionId
            ? createHash('sha256').update(`${input.userId}\0${input.sourceMissionId}\0${input.title}`).digest('hex').slice(0, 24)
            : randomUUID()
        const existing = this.goals.find(goal => goal.id === (input.id || stable))
        if (existing) return structuredClone(existing)
        const goal: NovaGoal = {
            ...input,
            id: input.id || stable,
            status: input.status || (input.dependencies.length ? 'planned' : 'active'),
            priority: Math.max(0, Math.min(100, input.priority)),
            outcomeRunIds: [], evidenceRefs: [], progress: 0,
            createdAt: now, updatedAt: now,
        }
        this.goals.push(goal)
        this.persist()
        return structuredClone(goal)
    }

    createMissionPlan(input: { missionId: string; userId: string; goal: string; steps: Array<{ title: string; nextAction: string }>; priority?: number }): { root: NovaGoal; steps: NovaGoal[] } {
        const root = this.create({
            userId: input.userId, title: input.goal, dependencies: [], priority: input.priority ?? 70,
            nextAction: input.steps[0]?.nextAction, sourceMissionId: input.missionId,
        })
        const steps: NovaGoal[] = []
        for (let index = 0; index < input.steps.length; index++) {
            const prior = steps[index - 1]
            steps.push(this.create({
                userId: input.userId, title: input.steps[index].title, parentId: root.id,
                dependencies: prior ? [prior.id] : [], priority: Math.max(1, root.priority - index),
                nextAction: input.steps[index].nextAction, sourceMissionId: `${input.missionId}:step:${index + 1}`,
            }))
        }
        this.refreshReadiness(input.userId)
        return { root, steps: this.list(input.userId).filter(goal => goal.parentId === root.id) }
    }

    update(id: string, patch: Partial<Pick<NovaGoal, 'status' | 'nextAction' | 'deadline' | 'priority'>>, evidence?: { runId?: string; ref?: string }): NovaGoal | null {
        const goal = this.goals.find(item => item.id === id)
        if (!goal) return null
        Object.assign(goal, patch)
        if (patch.priority !== undefined) goal.priority = Math.max(0, Math.min(100, patch.priority))
        if (evidence?.runId) goal.outcomeRunIds = [...new Set([...goal.outcomeRunIds, evidence.runId])].slice(-50)
        if (evidence?.ref) goal.evidenceRefs = [...new Set([...goal.evidenceRefs, evidence.ref])].slice(-50)
        goal.progress = patch.status === 'completed' ? 1 : patch.status === 'failed' || patch.status === 'cancelled' ? goal.progress : Math.max(goal.progress, 0.05)
        goal.updatedAt = new Date().toISOString()
        if (goal.parentId) this.refreshParent(goal.parentId)
        this.refreshReadiness(goal.userId)
        this.persist()
        return structuredClone(goal)
    }

    next(userId: string): NovaGoal | null {
        this.refreshReadiness(userId)
        const parentIds = new Set(this.goals.map(goal => goal.parentId).filter(Boolean))
        const candidates = this.goals.filter(goal => goal.userId === userId && goal.status === 'active' && !parentIds.has(goal.id))
            .sort((a, b) => b.priority - a.priority || (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.createdAt.localeCompare(b.createdAt))
        return candidates[0] ? structuredClone(candidates[0]) : null
    }

    list(userId?: string): NovaGoal[] {
        return this.goals.filter(goal => !userId || goal.userId === userId).map(goal => structuredClone(goal))
    }

    getPrompt(userId: string): string {
        const next = this.next(userId)
        const active = this.list(userId).filter(goal => goal.status === 'active' || goal.status === 'blocked').slice(0, 8)
        if (!active.length) return ''
        return [
            'Verwaltete Ziele (Status nur aus Goal Manager):',
            ...active.map(goal => `- ${goal.status === 'active' ? '[aktiv]' : '[blockiert]'} ${goal.title}${goal.nextAction ? `; nächster Schritt: ${goal.nextAction}` : ''}`),
            ...(next ? [`Priorisierter nächster Schritt: ${next.nextAction || next.title}`] : []),
        ].join('\n')
    }

    getStats(userId?: string) {
        const goals = this.list(userId)
        return {
            total: goals.length,
            active: goals.filter(goal => goal.status === 'active').length,
            blocked: goals.filter(goal => goal.status === 'blocked').length,
            completed: goals.filter(goal => goal.status === 'completed').length,
        }
    }

    private refreshReadiness(userId: string): void {
        const byId = new Map(this.goals.map(goal => [goal.id, goal]))
        for (const goal of this.goals.filter(item => item.userId === userId && (item.status === 'planned' || item.status === 'blocked'))) {
            const dependencies = goal.dependencies.map(id => byId.get(id))
            if (dependencies.some(dep => dep?.status === 'failed' || dep?.status === 'cancelled')) goal.status = 'blocked'
            else if (dependencies.every(dep => dep?.status === 'completed')) goal.status = 'active'
        }
    }

    private refreshParent(parentId: string): void {
        const parent = this.goals.find(goal => goal.id === parentId)
        if (!parent) return
        const children = this.goals.filter(goal => goal.parentId === parentId)
        if (!children.length) return
        parent.progress = children.filter(goal => goal.status === 'completed').length / children.length
        if (children.every(goal => goal.status === 'completed')) parent.status = 'completed'
        else if (children.some(goal => goal.status === 'failed')) parent.status = 'failed'
        parent.updatedAt = new Date().toISOString()
    }

    private persist(): void {
        this.goals = this.goals.slice(-2_000)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: new Date().toISOString(), goals: this.goals } satisfies GoalFile)
    }
}

let singleton: GoalManager | null = null
export function getGoalManager(): GoalManager { return singleton ||= new GoalManager() }
export function setGoalManager(value: GoalManager): void { singleton = value }
