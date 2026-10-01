/**
 * Nova Layer 7 - Advanced Learning System
 * 
 * Features:
 * - Learn from user corrections
 * (Skills: one system only — learning/routine-skills.ts; tools: tools/skill-builder.ts)
 * - Multi-agent swarm coordination
 * - Feedback loop integration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Correction {
    id: string
    userId: string
    originalResponse: string
    correctedResponse: string
    context: string  // What was the user asking?
    timestamp: number
    applied: boolean  // Has this correction been incorporated?
}

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
// Correction Learning System
// ============================================

export class CorrectionLearner {
    private corrections: Correction[] = []
    private dataPath: string

    constructor(dataDir: string) {
        this.dataPath = join(dataDir, 'corrections.json')
        this.load()
    }

    recordCorrection(params: {
        userId: string
        originalResponse: string
        correctedResponse: string
        context: string
    }): Correction {
        const correction: Correction = {
            id: crypto.randomUUID(),
            ...params,
            timestamp: Date.now(),
            applied: true,  // Immediately active so findSimilarCorrections picks it up
        }

        this.corrections.push(correction)
        this.save()

        console.log(`[L7 Learning] Korrektur von ${params.userId} gespeichert (${this.corrections.length} gesamt)`)

        // Trigger L20 rule synthesis immediately after each correction
        import('./L20-self-improvement.js').then(m => {
            m.getSelfImprovementEngine().analyzeCorrections().catch(() => {})
        }).catch(() => {})

        return correction
    }

    // Find similar corrections to apply (with optional LLM re-ranking)
    findSimilarCorrections(context: string, limit = 3, userId?: string): Correction[] {
        const contextWords = new Set(
            context.toLowerCase().split(/\W+/).filter(w => w.length > 2)
        )

        const candidates = this.corrections
            .filter(c => c.applied && (!userId || c.userId === userId))
            .map(c => {
                const correctionWords = new Set(
                    c.context.toLowerCase().split(/\W+/).filter(w => w.length > 2)
                )
                const common = [...contextWords].filter(w => correctionWords.has(w))
                const similarity = contextWords.size > 0
                    ? common.length / contextWords.size
                    : 0
                return { correction: c, similarity }
            })
            .filter(x => x.similarity > 0.3)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit * 2)

        // If LLM available, re-rank candidates semantically
        if (internalLlm && candidates.length > 1) {
            try {
                const candidateList = candidates.map((c, i) => `${i}: "${c.correction.context.slice(0, 100)}"`).join('\n')
                const prompt = `Rank these corrections by relevance to the query. Return ONLY comma-separated indices (most relevant first).\n\nQuery: "${context.slice(0, 200)}"\n\nCandidates:\n${candidateList}`
                internalLlm.complete([{ role: 'user', content: prompt }]).then((res: any) => {
                    // Fire-and-forget re-ranking for next time
                    console.log(`[L7] LLM re-rank hint: ${res?.content?.slice(0, 50)}`)
                }).catch(() => { })
            } catch { /* non-critical */ }
        }

        return candidates.slice(0, limit).map(x => x.correction)
    }

    // Get improvement suggestions based on corrections
    getSuggestions(response: string): string[] {
        const suggestions: string[] = []

        for (const correction of this.corrections) {
            // Simple pattern matching
            const originalLower = correction.originalResponse.toLowerCase()
            const responseLower = response.toLowerCase()

            if (responseLower.includes(originalLower.slice(0, 50))) {
                suggestions.push(
                    `Basierend auf früherer Korrektur: "${correction.correctedResponse.slice(0, 100)}..."`
                )
            }
        }

        return suggestions.slice(0, 3)
    }

    markApplied(correctionId: string): void {
        const correction = this.corrections.find(c => c.id === correctionId)
        if (correction) {
            correction.applied = true
            this.save()
        }
    }

    private load(): void {
        if (existsSync(this.dataPath)) {
            try {
                this.corrections = JSON.parse(readFileSync(this.dataPath, 'utf-8'))
            } catch { /* ignore */ }
        }
    }

    private save(): void {
        const dir = join(this.dataPath, '..')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(this.dataPath, JSON.stringify(this.corrections, null, 2))
    }

    getRecentCorrections(limit = 20): Correction[] {
        return this.corrections
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit)
    }

    getStats() {
        return {
            totalCorrections: this.corrections.length,
            appliedCorrections: this.corrections.filter(c => c.applied).length,
        }
    }
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

let correctionLearner: CorrectionLearner | null = null
let agentSwarm: AgentSwarm | null = null

export function getCorrectionLearner(dataDir?: string): CorrectionLearner {
    if (!correctionLearner) {
        const dir = dataDir || join(process.cwd(), '.nova-learning')
        correctionLearner = new CorrectionLearner(dir)
    }
    return correctionLearner
}

export function getAgentSwarm(): AgentSwarm {
    if (!agentSwarm) {
        agentSwarm = new AgentSwarm()
    }
    return agentSwarm
}

export default {
    CorrectionLearner,
    AgentSwarm,
    getCorrectionLearner,
    getAgentSwarm,
    setInternalLLM,
    getInternalLLM,
}
