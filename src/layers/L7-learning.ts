/**
 * Nova Layer 7 - Advanced Learning System
 * 
 * Features:
 * (User corrections: memory/correction-memory.ts; skills: learning/routine-skills.ts; tools: tools/skill-builder.ts)
 * - Multi-agent swarm coordination
 * - Feedback loop integration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface AgentInstance {
    id: string
    name: string
    role: string
    status: 'idle' | 'thinking' | 'executing' | 'waiting'
    currentTask?: string
    channel: string
    userId?: string
    createdAt: number
    lastActive: number
}

export interface SwarmMessage {
    from: string  // Agent ID
    to: string    // Agent ID or 'all'
    type: 'request' | 'response' | 'broadcast' | 'delegate'
    content: string
    data?: unknown
    timestamp: number
}

// ============================================
// Multi-Agent Swarm System
// ============================================

export class AgentSwarm {
    private agents: Map<string, AgentInstance> = new Map()
    private messageQueue: SwarmMessage[] = []
    private handlers: Map<string, (msg: SwarmMessage) => Promise<void>> = new Map()

    // Register a new agent in the swarm
    registerAgent(params: {
        name: string
        role: string
        channel: string
        userId?: string
    }): AgentInstance {
        const agent: AgentInstance = {
            id: crypto.randomUUID(),
            name: params.name,
            role: params.role,
            status: 'idle',
            channel: params.channel,
            userId: params.userId,
            createdAt: Date.now(),
            lastActive: Date.now(),
        }

        this.agents.set(agent.id, agent)
        console.log(`[Swarm] Agent registriert: ${agent.name} (${agent.role})`)
        return agent
    }

    // Remove agent from swarm
    unregisterAgent(agentId: string): void {
        this.agents.delete(agentId)
    }

    // Send message between agents
    sendMessage(msg: Omit<SwarmMessage, 'timestamp'>): void {
        const fullMsg: SwarmMessage = {
            ...msg,
            timestamp: Date.now(),
        }

        this.messageQueue.push(fullMsg)

        // Deliver to handler if registered
        if (msg.to === 'all') {
            for (const [id, handler] of this.handlers) {
                if (id !== msg.from) {
                    handler(fullMsg).catch(console.error)
                }
            }
        } else {
            const handler = this.handlers.get(msg.to)
            if (handler) {
                handler(fullMsg).catch(console.error)
            }
        }
    }

    // Register message handler for an agent
    onMessage(agentId: string, handler: (msg: SwarmMessage) => Promise<void>): void {
        this.handlers.set(agentId, handler)
    }

    // Delegate task to best available agent
    delegateTask(task: string, requiredRole?: string): AgentInstance | null {
        for (const agent of this.agents.values()) {
            if (agent.status === 'idle') {
                if (!requiredRole || agent.role === requiredRole) {
                    agent.status = 'thinking'
                    agent.currentTask = task
                    agent.lastActive = Date.now()
                    return agent
                }
            }
        }
        return null
    }

    // Mark task complete
    completeTask(agentId: string): void {
        const agent = this.agents.get(agentId)
        if (agent) {
            agent.status = 'idle'
            agent.currentTask = undefined
            agent.lastActive = Date.now()
        }
    }

    // Get all agents
    getAgents(): AgentInstance[] {
        return Array.from(this.agents.values())
    }

    // Get agent by ID
    getAgent(agentId: string): AgentInstance | undefined {
        return this.agents.get(agentId)
    }

    getStats() {
        const agents = this.getAgents()
        return {
            totalAgents: agents.length,
            idleAgents: agents.filter(a => a.status === 'idle').length,
            busyAgents: agents.filter(a => a.status !== 'idle').length,
            messageCount: this.messageQueue.length,
        }
    }
}

// ============================================
// Internal LLM for smarter learning
// ============================================

let internalLlm: any = null

export function setInternalLLM(llm: any): void {
    internalLlm = llm
    console.log('[L7 Learning] ✓ Internal LLM connected')
}

export function getInternalLLM(): any {
    return internalLlm
}

// ============================================
// Global Instances
// ============================================

let agentSwarm: AgentSwarm | null = null

export function getAgentSwarm(): AgentSwarm {
    if (!agentSwarm) {
        agentSwarm = new AgentSwarm()
    }
    return agentSwarm
}

export default {
    AgentSwarm,
    getAgentSwarm,
    setInternalLLM,
    getInternalLLM,
}
