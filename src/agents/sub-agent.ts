/**
 * Nova Sub-Agent Manager
 * 
 * Manages specialized sub-agents for specific tasks like research, coding, etc.
 */

import { EventEmitter } from 'node:events'

export interface SubAgent {
    id: string
    name: string
    type: 'research' | 'coding' | 'analysis' | 'search'
    status: 'idle' | 'running' | 'completed' | 'failed'
    result?: string
}

const activeAgents: Map<string, SubAgent> = new Map()

/**
 * Sub-Agent Manager with Event Emitter
 */
export class SubAgentManager extends EventEmitter {
    private fallbackMessage = 'Sub-Agent konnte keine Lösung finden.'

    constructor() {
        super()
    }

    /**
     * Spawn a search agent to find solutions
     */
    async spawnSearchAgent(
        context: { problem: string; tool?: string; params?: Record<string, unknown> },
        retryFn: (solution: string) => Promise<unknown>,
        reportFn: (message: string) => Promise<void>
    ): Promise<void> {
        const agent: SubAgent = {
            id: `search-${Date.now()}`,
            name: 'Search Agent',
            type: 'search',
            status: 'running',
        }

        activeAgents.set(agent.id, agent)
        await reportFn(`🔍 Search Agent gestartet für: ${context.problem}`)

        try {
            // Try Google search for solutions
            const { googleSearch } = await import('../tools/google-search.js')
            const results = await googleSearch(`${context.problem} solution fix`, 3)

            if (results && results.results?.length > 0) {
                agent.result = results.results.map((r: any) => r.title || r.text).join('\n')
                agent.status = 'completed'
                await reportFn(`✅ Gefunden: ${agent.result.slice(0, 200)}...`)
                this.emit('task-complete', { agent, result: agent.result })
            } else {
                agent.status = 'failed'
                agent.result = this.fallbackMessage
                this.emit('task-error', { agent, error: 'No results found' })
            }
        } catch (err) {
            console.error(`[SubAgent] Search failed: ${err}`)
            agent.status = 'failed'
            agent.result = `Search fehlgeschlagen: ${err}`
            this.emit('task-error', { agent, error: err })
        }

        activeAgents.set(agent.id, agent)
    }

    /**
     * Spawn a coding agent
     */
    async spawnCodingAgent(
        task: string,
        language: string = 'typescript'
    ): Promise<SubAgent> {
        const agent: SubAgent = {
            id: `coding-${Date.now()}`,
            name: 'Coding Agent',
            type: 'coding',
            status: 'running',
        }

        activeAgents.set(agent.id, agent)
        console.log(`[SubAgent] Coding agent started: ${task}`)

        // Use LLM for code generation
        try {
            const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
            const llm = await createNovaLLMClient({})

            const llmMessages = [
                { role: 'system' as const, content: `You are a ${language} expert. Generate clean, working code.` },
                { role: 'user' as const, content: task },
            ]
            const response = await llm.complete(llmMessages as any)

            agent.result = response.content || ''
            agent.status = 'completed'
            this.emit('task-complete', { agent, result: agent.result })
        } catch (err) {
            agent.status = 'failed'
            agent.result = `Code generation failed: ${err}`
            this.emit('task-error', { agent, error: err })
        }

        activeAgents.set(agent.id, agent)
        return agent
    }

    /**
     * Get fallback message
     */
    getFallbackMessage(): string {
        return this.fallbackMessage
    }

    /**
     * Get all active agents
     */
    getActiveAgents(): SubAgent[] {
        return Array.from(activeAgents.values())
    }

    /**
     * Get agent by ID
     */
    getAgent(id: string): SubAgent | undefined {
        return activeAgents.get(id)
    }
}

// Singleton
let manager: SubAgentManager | null = null

export function getSubAgentManager(): SubAgentManager {
    if (!manager) {
        manager = new SubAgentManager()
    }
    return manager
}

export default { SubAgentManager, getSubAgentManager }
