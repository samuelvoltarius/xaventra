/**
 * Layer 9 - Idle Background Learning
 * 
 * When Nova is idle (no messages for 5+ minutes):
 * 1. Analyze what tools/commands user uses most
 * 2. Search for documentation/tutorials on those topics
 * 3. Store learned knowledge for future use
 * 4. Optionally notify user of what was learned
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// ============================================
// Types
// ============================================

interface UserPattern {
    tool: string
    count: number
    lastUsed: number
    errors: number
}

interface LearnedKnowledge {
    topic: string
    summary: string
    source: string
    learnedAt: number
}

// ============================================
// Idle Learning Manager
// ============================================

class IdleLearningManager {
    private lastActivity: number = Date.now()
    private idleThresholdMs: number = 5 * 60 * 1000 // 5 minutes
    private checkIntervalMs: number = 60 * 1000 // Check every minute
    private isLearning: boolean = false
    private patterns: Map<string, UserPattern> = new Map()
    private knowledge: LearnedKnowledge[] = []
    private dataPath: string = '.nova-learning/idle-knowledge.json'
    private intervalId?: NodeJS.Timeout
    private notifyCallback?: (message: string) => Promise<void>

    constructor() {
        this.loadData()
        console.log('[L9 IdleLearning] Manager initialized')
    }

    /**
     * Start the idle learning checker
     */
    start(): void {
        if (this.intervalId) return

        this.intervalId = setInterval(() => {
            this.checkAndLearn()
        }, this.checkIntervalMs)

        console.log('[L9 IdleLearning] Idle checker started')
    }

    /**
     * Set callback for notifying user during idle
     */
    setNotifyCallback(callback: (message: string) => Promise<void>): void {
        this.notifyCallback = callback
    }

    /**
     * Stop the idle learning checker
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = undefined
        }
    }

    /**
     * Record user activity (call this when user sends message)
     */
    recordActivity(): void {
        this.lastActivity = Date.now()
    }

    /**
     * Record tool usage for pattern analysis
     */
    recordToolUsage(tool: string, hadError: boolean = false): void {
        const existing = this.patterns.get(tool) || {
            tool,
            count: 0,
            lastUsed: Date.now(),
            errors: 0,
        }

        existing.count++
        existing.lastUsed = Date.now()
        if (hadError) existing.errors++

        this.patterns.set(tool, existing)
        this.saveData()
    }

    /**
     * Get topics that would be most useful to learn
     */
    private getTopicsToLearn(): string[] {
        const topics: string[] = []

        // Sort by usage count and error rate
        const sortedPatterns = Array.from(this.patterns.values())
            .sort((a, b) => {
                // Prioritize tools with high usage but also errors
                const scoreA = a.count + (a.errors * 2)
                const scoreB = b.count + (b.errors * 2)
                return scoreB - scoreA
            })

        // Take top 3 most used tools that we haven't learned about recently
        for (const pattern of sortedPatterns.slice(0, 3)) {
            const alreadyLearned = this.knowledge.some(k =>
                k.topic.toLowerCase().includes(pattern.tool.toLowerCase()) &&
                Date.now() - k.learnedAt < 24 * 60 * 60 * 1000 // Learned in last 24h
            )

            if (!alreadyLearned) {
                // Build search topic based on tool and errors
                if (pattern.errors > 0) {
                    topics.push(`${pattern.tool} common errors solutions`)
                } else {
                    topics.push(`${pattern.tool} best practices tips`)
                }
            }
        }

        return topics
    }

    /**
     * Check if we should start learning
     */
    private async checkAndLearn(): Promise<void> {
        const idleTime = Date.now() - this.lastActivity

        if (idleTime < this.idleThresholdMs || this.isLearning) {
            return
        }

        const topics = this.getTopicsToLearn()
        if (topics.length === 0) {
            console.log('[L9 IdleLearning] No new topics to learn')

            // Ask user what to learn if we have a notification callback
            if (this.notifyCallback) {
                try {
                    const { generateIdleLearningPrompt } = await import('../intelligence/proactive-learning.js')
                    const prompt = generateIdleLearningPrompt()
                    await this.notifyCallback(prompt)
                } catch { /* proactive learning not available */ }
            }
            return
        }

        console.log(`[L9 IdleLearning] Starting background learning (idle for ${Math.round(idleTime / 1000)}s)`)
        console.log(`[L9 IdleLearning] Topics to learn: ${topics.join(', ')}`)

        this.isLearning = true

        try {
            for (const topic of topics) {
                await this.learnAbout(topic)
            }
        } finally {
            this.isLearning = false
        }
    }

    /**
     * Learn about a specific topic
     */
    private async learnAbout(topic: string): Promise<void> {
        console.log(`[L9 IdleLearning] Learning about: ${topic}`)

        try {
            // Try to use tavily_search if available
            const { tavilySearchTool } = await import('../tools/tavily-search.js').catch(() => ({ tavilySearchTool: null }))

            if (!tavilySearchTool) {
                console.log('[L9 IdleLearning] No search tool available for learning')
                return
            }

            const result = await tavilySearchTool.handler({ query: topic, count: 3 }) as any

            if (result?.results?.length > 0) {
                // Extract key information
                const summary = result.results
                    .slice(0, 2)
                    .map((r: any) => `• ${r.title}: ${r.content?.slice(0, 100)}...`)
                    .join('\n')

                const knowledge: LearnedKnowledge = {
                    topic,
                    summary,
                    source: result.results[0]?.url || 'web search',
                    learnedAt: Date.now(),
                }

                this.knowledge.push(knowledge)
                this.saveData()

                console.log(`[L9 IdleLearning] ✅ Learned about ${topic}`)
            }
        } catch (err) {
            console.log(`[L9 IdleLearning] Failed to learn about ${topic}: ${err}`)
        }
    }

    /**
     * Get relevant knowledge for a query
     */
    getRelevantKnowledge(query: string): LearnedKnowledge[] {
        const lowerQuery = query.toLowerCase()
        return this.knowledge.filter(k =>
            k.topic.toLowerCase().includes(lowerQuery) ||
            k.summary.toLowerCase().includes(lowerQuery)
        )
    }

    /**
     * Get learning stats
     */
    getStats(): { patterns: UserPattern[]; knowledgeCount: number; isLearning: boolean } {
        return {
            patterns: Array.from(this.patterns.values()),
            knowledgeCount: this.knowledge.length,
            isLearning: this.isLearning,
        }
    }

    private loadData(): void {
        try {
            if (existsSync(this.dataPath)) {
                const data = JSON.parse(readFileSync(this.dataPath, 'utf-8'))
                this.knowledge = data.knowledge || []
                for (const pattern of data.patterns || []) {
                    this.patterns.set(pattern.tool, pattern)
                }
            }
        } catch (err) {
            console.log(`[L9 IdleLearning] Could not load data: ${err}`)
        }
    }

    private saveData(): void {
        try {
            const dir = this.dataPath.split('/').slice(0, -1).join('/')
            if (!existsSync(dir)) {
                require('fs').mkdirSync(dir, { recursive: true })
            }
            writeFileSync(this.dataPath, JSON.stringify({
                patterns: Array.from(this.patterns.values()),
                knowledge: this.knowledge,
            }, null, 2))
        } catch (err) {
            console.log(`[L9 IdleLearning] Could not save data: ${err}`)
        }
    }
}

// ============================================
// Internal LLM for smarter idle learning
// ============================================

let internalLlm: any = null

export function setInternalLLM(llm: any): void {
    internalLlm = llm
    console.log('[L9 IdleLearning] ✓ Internal LLM connected')
}

export function getInternalLLM(): any {
    return internalLlm
}

// ============================================
// Singleton
// ============================================

let instance: IdleLearningManager | null = null

export function getIdleLearningManager(): IdleLearningManager {
    if (!instance) {
        instance = new IdleLearningManager()
    }
    return instance
}

export default { getIdleLearningManager, setInternalLLM, getInternalLLM }
