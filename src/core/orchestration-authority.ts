import { getOrchestrator, type OrchestratorConfig } from '../resilience/orchestrator.js'
import {
    cancelSubagent,
    listSubagents,
    spawnParallel,
    spawnSubagent,
    spawnSubagentsParallel,
    type SubagentTask,
} from '../agents/subagent-orchestrator.js'

/**
 * Single public authority for task supervision and subagent execution.
 * Legacy implementations remain internal adapters and no longer own daemon state.
 */
export class OrchestrationAuthority {
    private supervisor

    constructor(config?: Partial<OrchestratorConfig>) {
        this.supervisor = getOrchestrator(config)
    }

    start() { return this.supervisor.start() }
    stop() { return this.supervisor.stop() }
    registerNovaCallback(callback: (event: string, data: unknown) => Promise<void>) {
        return this.supervisor.registerNovaCallback(callback)
    }
    watchTask(...args: Parameters<typeof this.supervisor.watchTask>) {
        return this.supervisor.watchTask(...args)
    }
    completeTask(...args: Parameters<typeof this.supervisor.completeTask>) {
        return this.supervisor.completeTask(...args)
    }
    getStats() { return this.supervisor.getStats() }
    getActiveAgents() { return this.supervisor.getActiveAgents() }
    getWatchedTasks() { return this.supervisor.getWatchedTasks() }

    spawn(task: SubagentTask) { return spawnSubagent(task) }
    spawnParallel(tasks: SubagentTask[]) { return spawnParallel(tasks) }
    spawnToolTasks(tasks: Parameters<typeof spawnSubagentsParallel>[0]) { return spawnSubagentsParallel(tasks) }
    cancel(id: string) { return cancelSubagent(id) }
    list() { return listSubagents() }
}

let authority: OrchestrationAuthority | null = null

export function getOrchestrationAuthority(config?: Partial<OrchestratorConfig>): OrchestrationAuthority {
    if (!authority) authority = new OrchestrationAuthority(config)
    return authority
}

