/**
 * Nova - Task Queue
 * 
 * Async task management with:
 * - Priority levels (urgent, high, normal, low)
 * - Task categories (code, file, research, message, system)
 * - Status tracking (pending, in_progress, completed, failed)
 * - Persistence to disk
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
export type TaskCategory = 'code' | 'file' | 'research' | 'message' | 'system' | 'other'

export interface Task {
    id: string
    description: string
    priority: TaskPriority
    category: TaskCategory
    status: TaskStatus

    // Metadata
    createdAt: number
    startedAt?: number
    completedAt?: number

    // Context
    createdBy?: string      // User/channel that created the task
    assignedTo?: string     // Agent/handler processing the task

    // Results
    result?: string
    error?: string

    // Dependencies
    dependsOn?: string[]    // Task IDs this depends on
    blockedBy?: string[]    // Tasks blocking this one
}

export interface TaskStats {
    total: number
    pending: number
    inProgress: number
    completed: number
    failed: number
    byPriority: Record<TaskPriority, number>
    byCategory: Record<TaskCategory, number>
}

// ============================================
// Priority Weight (for sorting)
// ============================================

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
    urgent: 4,
    high: 3,
    normal: 2,
    low: 1,
}

// ============================================
// Task Queue Class
// ============================================

export class TaskQueue {
    private tasks: Map<string, Task> = new Map()
    private dataDir: string
    private filePath: string

    constructor(dataDir = '.nova-tasks') {
        this.dataDir = dataDir
        this.filePath = join(dataDir, 'tasks.json')
        this.load()
    }

    // ============================================
    // Task Creation
    // ============================================

    createTask(params: {
        description: string
        priority?: TaskPriority
        category?: TaskCategory
        createdBy?: string
        dependsOn?: string[]
    }): Task {
        const task: Task = {
            id: randomUUID(),
            description: params.description,
            priority: params.priority || 'normal',
            category: params.category || 'other',
            status: 'pending',
            createdAt: Date.now(),
            createdBy: params.createdBy,
            dependsOn: params.dependsOn,
        }

        // Check if blocked by dependencies
        if (params.dependsOn && params.dependsOn.length > 0) {
            const blockedBy = params.dependsOn.filter(depId => {
                const depTask = this.tasks.get(depId)
                return depTask && depTask.status !== 'completed'
            })
            if (blockedBy.length > 0) {
                task.blockedBy = blockedBy
            }
        }

        this.tasks.set(task.id, task)
        this.save()

        console.log(`[TaskQueue] Created task: ${task.id} (${task.priority}/${task.category})`)
        return task
    }

    // ============================================
    // Task Status Updates
    // ============================================

    startTask(taskId: string, assignedTo?: string): Task | null {
        const task = this.tasks.get(taskId)
        if (!task) return null

        if (task.status !== 'pending') {
            console.log(`[TaskQueue] Task ${taskId} not pending (${task.status})`)
            return task
        }

        // Check blocked
        if (task.blockedBy && task.blockedBy.length > 0) {
            console.log(`[TaskQueue] Task ${taskId} blocked by: ${task.blockedBy.join(', ')}`)
            return task
        }

        task.status = 'in_progress'
        task.startedAt = Date.now()
        task.assignedTo = assignedTo

        this.save()
        console.log(`[TaskQueue] Started task: ${taskId}`)
        return task
    }

    completeTask(taskId: string, result?: string): Task | null {
        const task = this.tasks.get(taskId)
        if (!task) return null

        task.status = 'completed'
        task.completedAt = Date.now()
        task.result = result

        // Unblock dependent tasks
        this.unblockDependents(taskId)

        this.save()
        console.log(`[TaskQueue] Completed task: ${taskId}`)
        return task
    }

    failTask(taskId: string, error: string): Task | null {
        const task = this.tasks.get(taskId)
        if (!task) return null

        task.status = 'failed'
        task.completedAt = Date.now()
        task.error = error

        this.save()
        console.log(`[TaskQueue] Failed task: ${taskId} - ${error}`)
        return task
    }

    cancelTask(taskId: string): Task | null {
        const task = this.tasks.get(taskId)
        if (!task) return null

        task.status = 'cancelled'
        task.completedAt = Date.now()

        this.save()
        console.log(`[TaskQueue] Cancelled task: ${taskId}`)
        return task
    }

    private unblockDependents(completedTaskId: string): void {
        for (const task of this.tasks.values()) {
            if (task.blockedBy) {
                task.blockedBy = task.blockedBy.filter(id => id !== completedTaskId)
                if (task.blockedBy.length === 0) {
                    delete task.blockedBy
                }
            }
        }
    }

    // ============================================
    // Task Retrieval
    // ============================================

    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId)
    }

    getNextTask(): Task | null {
        const pendingTasks = Array.from(this.tasks.values())
            .filter(t => t.status === 'pending' && !t.blockedBy)
            .sort((a, b) => {
                // Sort by priority (desc), then by creation time (asc)
                const priorityDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]
                if (priorityDiff !== 0) return priorityDiff
                return a.createdAt - b.createdAt
            })

        return pendingTasks[0] || null
    }

    getAllTasks(): Task[] {
        return Array.from(this.tasks.values())
    }

    getTasksByStatus(status: TaskStatus): Task[] {
        return Array.from(this.tasks.values()).filter(t => t.status === status)
    }

    getTasksByPriority(priority: TaskPriority): Task[] {
        return Array.from(this.tasks.values()).filter(t => t.priority === priority)
    }

    getTasksByCategory(category: TaskCategory): Task[] {
        return Array.from(this.tasks.values()).filter(t => t.category === category)
    }

    getPendingTasks(): Task[] {
        return this.getTasksByStatus('pending')
            .filter(t => !t.blockedBy)
            .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
    }

    // ============================================
    // Statistics
    // ============================================

    getStats(): TaskStats {
        const all = Array.from(this.tasks.values())

        const stats: TaskStats = {
            total: all.length,
            pending: all.filter(t => t.status === 'pending').length,
            inProgress: all.filter(t => t.status === 'in_progress').length,
            completed: all.filter(t => t.status === 'completed').length,
            failed: all.filter(t => t.status === 'failed').length,
            byPriority: {
                urgent: all.filter(t => t.priority === 'urgent').length,
                high: all.filter(t => t.priority === 'high').length,
                normal: all.filter(t => t.priority === 'normal').length,
                low: all.filter(t => t.priority === 'low').length,
            },
            byCategory: {
                code: all.filter(t => t.category === 'code').length,
                file: all.filter(t => t.category === 'file').length,
                research: all.filter(t => t.category === 'research').length,
                message: all.filter(t => t.category === 'message').length,
                system: all.filter(t => t.category === 'system').length,
                other: all.filter(t => t.category === 'other').length,
            },
        }

        return stats
    }

    // ============================================
    // Cleanup
    // ============================================

    pruneOldTasks(maxAgeDays = 30): number {
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)
        let pruned = 0

        for (const [id, task] of this.tasks) {
            if (
                (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') &&
                task.completedAt &&
                task.completedAt < cutoff
            ) {
                this.tasks.delete(id)
                pruned++
            }
        }

        if (pruned > 0) {
            this.save()
            console.log(`[TaskQueue] Pruned ${pruned} old tasks`)
        }

        return pruned
    }

    // ============================================
    // Persistence
    // ============================================

    private load(): void {
        try {
            if (existsSync(this.filePath)) {
                const data = JSON.parse(readFileSync(this.filePath, 'utf-8'))
                this.tasks = new Map(Object.entries(data))
                console.log(`[TaskQueue] Loaded ${this.tasks.size} tasks`)
            }
        } catch (err) {
            console.error('[TaskQueue] Failed to load:', err)
        }
    }

    private save(): void {
        try {
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true })
            }

            const data = Object.fromEntries(this.tasks)
            writeFileSync(this.filePath, JSON.stringify(data, null, 2))
        } catch (err) {
            console.error('[TaskQueue] Failed to save:', err)
        }
    }
}

// ============================================
// Factory Function
// ============================================

let globalQueue: TaskQueue | null = null

export function getTaskQueue(): TaskQueue {
    if (!globalQueue) {
        globalQueue = new TaskQueue()
    }
    return globalQueue
}

export function createTaskQueue(dataDir?: string): TaskQueue {
    return new TaskQueue(dataDir)
}

export default { TaskQueue, getTaskQueue, createTaskQueue }
