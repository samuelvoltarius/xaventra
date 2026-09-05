/**
 * Nova - Layer 0: Agent Orchestrator
 * 
 * Core responsibility: Manage sub-agents so Nova can stay focused.
 * 
 * - Monitors ALL tasks for timeout
 * - Spawns sub-agents when tasks take too long
 * - Tracks sub-agent status in background
 * - Reports back to Nova only when relevant (success/failure)
 * - Nova stays focused on main conversation
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

// ============================================
// Types
// ============================================

export type AgentStatus = 'idle' | 'spawning' | 'working' | 'completed' | 'failed' | 'timeout'

export interface SubAgent {
    id: string
    role: string
    task: string
    status: AgentStatus
    priority: number
    createdAt: number
    startedAt?: number
    completedAt?: number
    result?: string
    error?: string
    parentTask?: string    // If spawned for a specific Nova task
    retryCount: number
    maxRetries: number
}

export interface TaskWatch {
    id: string
    description: string
    startedAt: number
    timeoutMs: number
    timedOut: boolean
    agentsSpawned: string[]
}

export interface OrchestratorConfig {
    defaultTimeoutMs: number     // Default: 30s
    maxAgentsPerTask: number     // Default: 3
    maxTotalAgents: number       // Default: 10
    agentRetries: number         // Default: 2
    checkIntervalMs: number      // Default: 5s
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: OrchestratorConfig = {
    defaultTimeoutMs: 30000,     // 30 seconds
    maxAgentsPerTask: 3,
    maxTotalAgents: 10,
    agentRetries: 2,
    checkIntervalMs: 5000,       // Check every 5 seconds
}

// ============================================
// Agent Orchestrator (Layer 0)
// ============================================

export class AgentOrchestrator extends EventEmitter {
    private config: OrchestratorConfig
    private agents: Map<string, SubAgent> = new Map()
    private taskWatches: Map<string, TaskWatch> = new Map()
    private checkInterval: NodeJS.Timeout | null = null
    private novaCallback?: (event: string, data: unknown) => void

    constructor(config: Partial<OrchestratorConfig> = {}) {
        super()
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    // ============================================
    // Start/Stop
    // ============================================

    start(): void {
        if (this.checkInterval) return

        console.log('[Layer0:Orchestrator] Starting agent monitoring...')

        this.checkInterval = setInterval(() => {
            this.checkTimeouts()
            this.checkAgentHealth()
        }, this.config.checkIntervalMs)

        this.emit('started')
    }

    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval)
            this.checkInterval = null
        }

        console.log('[Layer0:Orchestrator] Stopped')
        this.emit('stopped')
    }

    // ============================================
    // Register Nova Callback
    // ============================================

    /**
     * Nova registers a callback to receive important updates.
     * Layer 0 only calls this for:
     * - Task completed by sub-agent
     * - Task failed (after retries)
     * - Critical errors
     * 
     * Nova doesn't need to know about spawning, progress, etc.
     */
    registerNovaCallback(callback: (event: string, data: unknown) => void): void {
        this.novaCallback = callback
        console.log('[Layer0:Orchestrator] Nova callback registered')
    }

    private notifyNova(event: string, data: unknown): void {
        if (this.novaCallback) {
            try {
                this.novaCallback(event, data)
            } catch (err) {
                console.error('[Layer0:Orchestrator] Failed to notify Nova:', err)
            }
        }
        this.emit(`nova:${event}`, data)
    }

    // ============================================
    // Task Watching
    // ============================================

    /**
     * Start watching a task for timeout.
     * Called by Nova when it starts working on something.
     */
    watchTask(taskId: string, description: string, timeoutMs?: number): void {
        const watch: TaskWatch = {
            id: taskId,
            description,
            startedAt: Date.now(),
            timeoutMs: timeoutMs || this.config.defaultTimeoutMs,
            timedOut: false,
            agentsSpawned: [],
        }

        this.taskWatches.set(taskId, watch)
        console.log(`[Layer0:Orchestrator] Watching task: ${taskId} (timeout: ${watch.timeoutMs}ms)`)
    }

    /**
     * Mark task as complete (stop watching).
     */
    completeTask(taskId: string, result?: string): void {
        const watch = this.taskWatches.get(taskId)
        if (watch) {
            this.taskWatches.delete(taskId)
            console.log(`[Layer0:Orchestrator] Task completed: ${taskId}`)

            // If agents were spawned, notify about their work
            if (watch.agentsSpawned.length > 0) {
                this.notifyNova('task_completed_with_agents', {
                    taskId,
                    agentCount: watch.agentsSpawned.length,
                    result,
                })
            }
        }
    }

    /**
     * Cancel watching a task.
     */
    unwatchTask(taskId: string): void {
        this.taskWatches.delete(taskId)
    }

    // ============================================
    // Timeout Detection & Auto-Spawning
    // ============================================

    private checkTimeouts(): void {
        const now = Date.now()

        for (const [taskId, watch] of this.taskWatches) {
            if (watch.timedOut) continue

            const elapsed = now - watch.startedAt

            if (elapsed > watch.timeoutMs) {
                this.handleTaskTimeout(taskId, watch)
            }
        }
    }

    private handleTaskTimeout(taskId: string, watch: TaskWatch): void {
        console.log(`[Layer0:Orchestrator] ⏰ Task timeout: ${taskId}`)
        watch.timedOut = true

        // Don't spawn if we've hit the limit for this task
        if (watch.agentsSpawned.length >= this.config.maxAgentsPerTask) {
            console.log(`[Layer0:Orchestrator] Max agents already spawned for task: ${taskId}`)
            return
        }

        // Don't spawn if we've hit the global limit
        const activeAgents = this.getActiveAgents().length
        if (activeAgents >= this.config.maxTotalAgents) {
            console.log(`[Layer0:Orchestrator] Max total agents reached: ${activeAgents}`)
            return
        }

        // Spawn sub-agent to handle this task
        const agent = this.spawnAgent(watch.description, taskId)
        watch.agentsSpawned.push(agent.id)

        console.log(`[Layer0:Orchestrator] Spawned agent ${agent.id} for timed-out task`)

        // Extend timeout for the task (give agent time to work)
        watch.startedAt = Date.now()
        watch.timedOut = false
    }

    // ============================================
    // Sub-Agent Management
    // ============================================

    /**
     * Spawn a sub-agent to handle a task.
     * Layer 0 manages this - Nova doesn't need to know.
     */
    spawnAgent(task: string, parentTask?: string): SubAgent {
        const agent: SubAgent = {
            id: randomUUID(),
            role: this.determineRole(task),
            task,
            status: 'spawning',
            priority: 1,
            createdAt: Date.now(),
            parentTask,
            retryCount: 0,
            maxRetries: this.config.agentRetries,
        }

        this.agents.set(agent.id, agent)
        this.emit('agent:spawned', agent)

        // Start agent work
        this.runAgent(agent)

        return agent
    }

    private determineRole(task: string): string {
        const taskLower = task.toLowerCase()

        if (taskLower.includes('code') || taskLower.includes('implement') || taskLower.includes('write')) {
            return 'coder'
        }
        if (taskLower.includes('test') || taskLower.includes('verify')) {
            return 'tester'
        }
        if (taskLower.includes('review') || taskLower.includes('check')) {
            return 'reviewer'
        }
        if (taskLower.includes('fix') || taskLower.includes('bug') || taskLower.includes('error')) {
            return 'fixer'
        }
        if (taskLower.includes('research') || taskLower.includes('find') || taskLower.includes('search')) {
            return 'researcher'
        }

        return 'generalist'
    }

    private async runAgent(agent: SubAgent): Promise<void> {
        agent.status = 'working'
        agent.startedAt = Date.now()

        console.log(`[Layer0:Orchestrator] Agent ${agent.id} (${agent.role}) starting work...`)

        try {
            // Execute the task
            // In real implementation, this calls LLM with role-specific prompts
            const result = await this.executeAgentTask(agent)

            agent.status = 'completed'
            agent.completedAt = Date.now()
            agent.result = result

            console.log(`[Layer0:Orchestrator] Agent ${agent.id} completed successfully`)

            // Notify Nova about completion
            this.notifyNova('agent_completed', {
                agentId: agent.id,
                role: agent.role,
                task: agent.task,
                result,
                parentTask: agent.parentTask,
            })

        } catch (err) {
            const error = err instanceof Error ? err.message : String(err)

            // Retry logic
            if (agent.retryCount < agent.maxRetries) {
                agent.retryCount++
                console.log(`[Layer0:Orchestrator] Agent ${agent.id} failed, retrying (${agent.retryCount}/${agent.maxRetries})...`)

                // Wait a bit and retry
                setTimeout(() => this.runAgent(agent), 2000)
                return
            }

            agent.status = 'failed'
            agent.completedAt = Date.now()
            agent.error = error

            console.error(`[Layer0:Orchestrator] Agent ${agent.id} failed after ${agent.maxRetries} retries: ${error}`)

            // Notify Nova about failure
            this.notifyNova('agent_failed', {
                agentId: agent.id,
                role: agent.role,
                task: agent.task,
                error,
                parentTask: agent.parentTask,
            })
        }
    }

    private async executeAgentTask(agent: SubAgent): Promise<string> {
        // Call actual LLM with role-specific prompts
        const rolePrompts: Record<string, string> = {
            coder: 'Du bist ein erfahrener Programmierer. Schreibe sauberen, funktionalen Code.',
            tester: 'Du bist ein QA-Spezialist. Schreibe gründliche Tests.',
            reviewer: 'Du bist ein Code-Reviewer. Prüfe auf Bugs und Best Practices.',
            fixer: 'Du bist ein Debugging-Experte. Finde und behebe Fehler.',
            researcher: 'Du bist ein Recherche-Spezialist. Finde relevante Informationen.',
            generalist: 'Du bist ein vielseitiger Assistent.',
        }

        try {
            const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
            const llm = await createNovaLLMClient({})
            const response = await llm.complete([
                { role: 'system', content: rolePrompts[agent.role] || rolePrompts.generalist },
                { role: 'user', content: agent.task }
            ])
            return response.content || `[${agent.role.toUpperCase()}] Completed`
        } catch (err) {
            console.log(`[Layer0:Orchestrator] LLM call failed: ${err}`)
            throw err
        }
    }

    // ============================================
    // Agent Health Monitoring
    // ============================================

    private checkAgentHealth(): void {
        const now = Date.now()
        const AGENT_TIMEOUT = 120000 // 2 minutes max per agent

        for (const [agentId, agent] of this.agents) {
            if (agent.status !== 'working') continue

            if (agent.startedAt && (now - agent.startedAt) > AGENT_TIMEOUT) {
                console.log(`[Layer0:Orchestrator] Agent ${agentId} timed out`)
                agent.status = 'timeout'
                agent.error = 'Agent execution timeout'

                this.notifyNova('agent_timeout', {
                    agentId,
                    role: agent.role,
                    task: agent.task,
                    parentTask: agent.parentTask,
                })
            }
        }
    }

    // ============================================
    // Status & Reporting
    // ============================================

    getActiveAgents(): SubAgent[] {
        return Array.from(this.agents.values())
            .filter(a => a.status === 'working' || a.status === 'spawning')
    }

    getAllAgents(): SubAgent[] {
        return Array.from(this.agents.values())
    }

    getAgent(agentId: string): SubAgent | undefined {
        return this.agents.get(agentId)
    }

    getWatchedTasks(): TaskWatch[] {
        return Array.from(this.taskWatches.values())
    }

    getStats(): {
        totalAgents: number
        activeAgents: number
        completedAgents: number
        failedAgents: number
        watchedTasks: number
        timedOutTasks: number
    } {
        const agents = Array.from(this.agents.values())
        const tasks = Array.from(this.taskWatches.values())

        return {
            totalAgents: agents.length,
            activeAgents: agents.filter(a => a.status === 'working').length,
            completedAgents: agents.filter(a => a.status === 'completed').length,
            failedAgents: agents.filter(a => a.status === 'failed').length,
            watchedTasks: tasks.length,
            timedOutTasks: tasks.filter(t => t.timedOut).length,
        }
    }

    /**
     * Get a summary for Nova (concise, only what matters)
     */
    getSummaryForNova(): string {
        const stats = this.getStats()
        const active = this.getActiveAgents()

        if (active.length === 0) {
            return 'Keine Sub-Agenten aktiv.'
        }

        const lines = [
            `${stats.activeAgents} Sub-Agent(en) arbeiten:`,
            ...active.map(a => `  • ${a.role}: ${a.task.slice(0, 40)}...`),
        ]

        if (stats.completedAgents > 0) {
            lines.push(`${stats.completedAgents} erledigt, ${stats.failedAgents} fehlgeschlagen.`)
        }

        return lines.join('\n')
    }
}

// ============================================
// Singleton Instance
// ============================================

let orchestratorInstance: AgentOrchestrator | null = null

export function getOrchestrator(config?: Partial<OrchestratorConfig>): AgentOrchestrator {
    if (!orchestratorInstance) {
        orchestratorInstance = new AgentOrchestrator(config)
    }
    return orchestratorInstance
}

export function createOrchestrator(config?: Partial<OrchestratorConfig>): AgentOrchestrator {
    return new AgentOrchestrator(config)
}

export default { AgentOrchestrator, getOrchestrator, createOrchestrator }
