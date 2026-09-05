/**
 * Nova - Factory (Dev-Loop)
 * 
 * Automated code generation with:
 * - Sub-agent spawning for complex/long tasks
 * - Timeout detection
 * - Task decomposition
 * - Parallel execution
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

// ============================================
// Types
// ============================================

export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'tester' | 'fixer'

export interface SubAgent {
    id: string
    role: AgentRole
    taskId: string
    status: 'idle' | 'working' | 'done' | 'failed'
    startedAt?: number
    completedAt?: number
    result?: string
    error?: string
}

export interface FactoryTask {
    id: string
    description: string
    subtasks: FactorySubtask[]
    status: 'pending' | 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed'
    createdAt: number
    completedAt?: number
    timeout: number  // Max time in ms before spawning sub-agents
    result?: string
    error?: string
}

export interface FactorySubtask {
    id: string
    parentId: string
    description: string
    type: 'plan' | 'implement' | 'test' | 'review' | 'fix'
    status: 'pending' | 'in_progress' | 'completed' | 'failed'
    assignedAgent?: string
    result?: string
    error?: string
}

export interface FactoryConfig {
    taskTimeoutMs: number       // Default: 30s - spawn sub-agents after this
    maxSubAgents: number        // Default: 5
    enableAutoDecompose: boolean // Auto-break large tasks
    llmProvider?: string        // LLM to use for planning
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: FactoryConfig = {
    taskTimeoutMs: 30000,       // 30 seconds
    maxSubAgents: 5,
    enableAutoDecompose: true,
}

// ============================================
// Factory Class
// ============================================

export class Factory extends EventEmitter {
    private config: FactoryConfig
    private tasks: Map<string, FactoryTask> = new Map()
    private agents: Map<string, SubAgent> = new Map()
    private timeouts: Map<string, NodeJS.Timeout> = new Map()

    constructor(config: Partial<FactoryConfig> = {}) {
        super()
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    // ============================================
    // Task Submission
    // ============================================

    async submitTask(description: string, timeout?: number): Promise<FactoryTask> {
        const task: FactoryTask = {
            id: randomUUID(),
            description,
            subtasks: [],
            status: 'pending',
            createdAt: Date.now(),
            timeout: timeout || this.config.taskTimeoutMs,
        }

        this.tasks.set(task.id, task)
        this.emit('task:created', task)

        console.log(`[Factory] Task submitted: ${task.id}`)
        console.log(`[Factory] Description: ${description.slice(0, 100)}...`)

        // Start processing
        this.processTask(task.id)

        return task
    }

    // ============================================
    // Task Processing
    // ============================================

    private async processTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId)
        if (!task) return

        // Start timeout watcher
        this.startTimeoutWatcher(taskId)

        try {
            // Phase 1: Planning
            task.status = 'planning'
            this.emit('task:planning', task)

            const subtasks = await this.decomposeTask(task)
            task.subtasks = subtasks

            // Phase 2: Execution
            task.status = 'executing'
            this.emit('task:executing', task)

            // Execute subtasks (potentially in parallel with sub-agents)
            await this.executeSubtasks(task)

            // Phase 3: Review
            task.status = 'reviewing'
            this.emit('task:reviewing', task)

            await this.reviewResults(task)

            // Complete
            task.status = 'completed'
            task.completedAt = Date.now()
            task.result = this.combineResults(task)

            this.emit('task:completed', task)
            console.log(`[Factory] Task completed: ${taskId}`)

        } catch (err) {
            task.status = 'failed'
            task.error = err instanceof Error ? err.message : String(err)
            this.emit('task:failed', task)
            console.error(`[Factory] Task failed: ${taskId} - ${task.error}`)
        } finally {
            this.clearTimeoutWatcher(taskId)
        }
    }

    // ============================================
    // Timeout & Sub-Agent Spawning
    // ============================================

    private startTimeoutWatcher(taskId: string): void {
        const task = this.tasks.get(taskId)
        if (!task) return

        const timeout = setTimeout(() => {
            this.handleTimeout(taskId)
        }, task.timeout)

        this.timeouts.set(taskId, timeout)
    }

    private clearTimeoutWatcher(taskId: string): void {
        const timeout = this.timeouts.get(taskId)
        if (timeout) {
            clearTimeout(timeout)
            this.timeouts.delete(taskId)
        }
    }

    private async handleTimeout(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId)
        if (!task || task.status === 'completed' || task.status === 'failed') return

        console.log(`[Factory] ⏰ Task timeout! Spawning sub-agents for: ${taskId}`)
        this.emit('task:timeout', task)

        // Get incomplete subtasks
        const incompleteSubtasks = task.subtasks.filter(
            st => st.status === 'pending' || st.status === 'in_progress'
        )

        // Spawn sub-agents for each incomplete subtask
        for (const subtask of incompleteSubtasks.slice(0, this.config.maxSubAgents)) {
            const agent = this.spawnSubAgent(subtask)
            console.log(`[Factory] Spawned sub-agent: ${agent.id} (${agent.role}) for subtask: ${subtask.id}`)
        }
    }

    private spawnSubAgent(subtask: FactorySubtask): SubAgent {
        const roleMap: Record<string, AgentRole> = {
            'plan': 'planner',
            'implement': 'coder',
            'test': 'tester',
            'review': 'reviewer',
            'fix': 'fixer',
        }

        const agent: SubAgent = {
            id: randomUUID(),
            role: roleMap[subtask.type] || 'coder',
            taskId: subtask.id,
            status: 'working',
            startedAt: Date.now(),
        }

        this.agents.set(agent.id, agent)
        subtask.assignedAgent = agent.id

        this.emit('agent:spawned', agent)

        // Start agent work (async)
        this.runSubAgent(agent, subtask)

        return agent
    }

    private async runSubAgent(agent: SubAgent, subtask: FactorySubtask): Promise<void> {
        try {
            console.log(`[Factory] Sub-agent ${agent.id} working on: ${subtask.description.slice(0, 50)}...`)

            // Simulate work (in real implementation, this would call LLM)
            const result = await this.executeSubtaskWithLLM(subtask, agent.role)

            agent.status = 'done'
            agent.completedAt = Date.now()
            agent.result = result

            subtask.status = 'completed'
            subtask.result = result

            this.emit('agent:completed', agent)
            console.log(`[Factory] Sub-agent ${agent.id} completed`)

        } catch (err) {
            agent.status = 'failed'
            agent.error = err instanceof Error ? err.message : String(err)
            subtask.status = 'failed'
            subtask.error = agent.error

            this.emit('agent:failed', agent)
            console.error(`[Factory] Sub-agent ${agent.id} failed: ${agent.error}`)
        }
    }

    // ============================================
    // Task Decomposition (Planning)
    // ============================================

    private async decomposeTask(task: FactoryTask): Promise<FactorySubtask[]> {
        if (!this.config.enableAutoDecompose) {
            // Single subtask for the whole thing
            return [{
                id: randomUUID(),
                parentId: task.id,
                description: task.description,
                type: 'implement',
                status: 'pending',
            }]
        }

        // Decompose into standard phases
        const subtasks: FactorySubtask[] = [
            {
                id: randomUUID(),
                parentId: task.id,
                description: `Plan implementation for: ${task.description}`,
                type: 'plan',
                status: 'pending',
            },
            {
                id: randomUUID(),
                parentId: task.id,
                description: `Implement: ${task.description}`,
                type: 'implement',
                status: 'pending',
            },
            {
                id: randomUUID(),
                parentId: task.id,
                description: `Test implementation of: ${task.description}`,
                type: 'test',
                status: 'pending',
            },
            {
                id: randomUUID(),
                parentId: task.id,
                description: `Review code for: ${task.description}`,
                type: 'review',
                status: 'pending',
            },
        ]

        console.log(`[Factory] Decomposed task into ${subtasks.length} subtasks`)
        return subtasks
    }

    // ============================================
    // Subtask Execution
    // ============================================

    private async executeSubtasks(task: FactoryTask): Promise<void> {
        for (const subtask of task.subtasks) {
            if (subtask.status === 'completed') continue

            subtask.status = 'in_progress'
            this.emit('subtask:started', subtask)

            try {
                const result = await this.executeSubtaskWithLLM(subtask)
                subtask.status = 'completed'
                subtask.result = result
                this.emit('subtask:completed', subtask)
            } catch (err) {
                subtask.status = 'failed'
                subtask.error = err instanceof Error ? err.message : String(err)
                this.emit('subtask:failed', subtask)

                // Spawn fixer agent for failed subtasks
                const fixSubtask: FactorySubtask = {
                    id: randomUUID(),
                    parentId: task.id,
                    description: `Fix error in: ${subtask.description}. Error: ${subtask.error}`,
                    type: 'fix',
                    status: 'pending',
                }
                task.subtasks.push(fixSubtask)
                this.spawnSubAgent(fixSubtask)
            }
        }
    }

    private async executeSubtaskWithLLM(subtask: FactorySubtask, _role?: AgentRole): Promise<string> {
        const prompts: Record<string, string> = {
            plan: `Create a detailed implementation plan for: ${subtask.description}`,
            implement: `Write the code for: ${subtask.description}`,
            test: `Write tests for: ${subtask.description}`,
            review: `Review the code for: ${subtask.description}`,
            fix: `Fix the issue: ${subtask.description}`,
        }

        const prompt = prompts[subtask.type] || subtask.description

        // Call actual LLM
        try {
            const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
            const llm = await createNovaLLMClient({})
            const response = await llm.complete([
                { role: 'system', content: `Du bist ein ${_role || 'coder'} Agent. Antworte präzise und fokussiert.` },
                { role: 'user', content: prompt }
            ])
            return response.content || `[${subtask.type.toUpperCase()}] Completed`
        } catch (err) {
            console.log(`[Factory] LLM call failed, using placeholder: ${err}`)
            return `[${subtask.type.toUpperCase()}] Result for: ${prompt.slice(0, 50)}...`
        }
    }

    // ============================================
    // Review & Combine
    // ============================================

    private async reviewResults(task: FactoryTask): Promise<void> {
        const hasFailures = task.subtasks.some(st => st.status === 'failed')

        if (hasFailures) {
            const failures = task.subtasks.filter(st => st.status === 'failed')
            console.log(`[Factory] Task has ${failures.length} failed subtasks`)

            // Could trigger retry logic here
        }
    }

    private combineResults(task: FactoryTask): string {
        const results = task.subtasks
            .filter(st => st.status === 'completed' && st.result)
            .map(st => `## ${st.type.toUpperCase()}\n${st.result}`)
            .join('\n\n')

        return results
    }

    // ============================================
    // Status & Info
    // ============================================

    getTask(taskId: string): FactoryTask | undefined {
        return this.tasks.get(taskId)
    }

    getAgent(agentId: string): SubAgent | undefined {
        return this.agents.get(agentId)
    }

    getActiveAgents(): SubAgent[] {
        return Array.from(this.agents.values()).filter(a => a.status === 'working')
    }

    getAllTasks(): FactoryTask[] {
        return Array.from(this.tasks.values())
    }

    getStats(): {
        tasks: number
        activeAgents: number
        completedTasks: number
        failedTasks: number
    } {
        const tasks = Array.from(this.tasks.values())
        return {
            tasks: tasks.length,
            activeAgents: this.getActiveAgents().length,
            completedTasks: tasks.filter(t => t.status === 'completed').length,
            failedTasks: tasks.filter(t => t.status === 'failed').length,
        }
    }
}

// ============================================
// Factory Instance
// ============================================

let factoryInstance: Factory | null = null

export function getFactory(config?: Partial<FactoryConfig>): Factory {
    if (!factoryInstance) {
        factoryInstance = new Factory(config)
    }
    return factoryInstance
}

export function createFactory(config?: Partial<FactoryConfig>): Factory {
    return new Factory(config)
}

export default { Factory, getFactory, createFactory }
