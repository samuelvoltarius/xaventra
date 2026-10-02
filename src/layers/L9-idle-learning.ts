/**
 * Layer 9 - Idle Background Learning — the one idle learner (2.82, 2.86).
 *
 * When Nova is idle (no messages for 5+ minutes):
 * 1. Take the most used tools (by name only)
 * 2. Search for documentation/tutorials on those tools
 * 3. Store learned knowledge for future use (injected as "GELERNTES WISSEN")
 *
 * 2.86 Punkt 6: the second learner (the former proactive learning module)
 * is gone. It appended "Soll ich lernen …?" to tool results and sent SSH and
 * autonomy error texts (host, user) to Tavily. Rules here:
 * - topics come only from tool names, never from free error text;
 * - every query is redacted (no hosts, IPs, users, paths, tokens);
 * - search prefers the local SearXNG when configured, otherwise the governed
 *   search chain (`createGovernedWebSearch`) — never Tavily directly;
 * - no question to the owner while idle.
 * The old `.nova-data/local-knowledge.json` was never read; it is moved aside
 * once as `.migriert` on start (not deleted).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getNovaDataDir, getNovaLearningDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { markMigrated } from '../planner/migration-files.js'

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

interface IdleHit { title?: string; url?: string; snippet?: string }

// ============================================
// Privacy: redacted queries, local search first
// ============================================

/**
 * Removes everything private from an idle search query: secrets, URLs,
 * user@host and e-mail addresses, IPv4/IPv6 addresses, file paths, host
 * names and long token-like strings. What remains are plain words.
 */
export function redactIdleSearchQuery(text: string): string {
    return redactSecrets(String(text ?? ''))
        .replace(/\[REDACTED[^\]]*\]/g, ' ')
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
        .replace(/\S+@\S+/g, ' ')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, ' ')
        .replace(/(?:^|\s)\S*[0-9a-f]*:[0-9a-f]*:[0-9a-f:]*\S*/gi, ' ')
        .replace(/(?:^|\s)(?:[A-Za-z]:)?[\\/]\S*/g, ' ')
        .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, ' ')
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, ' ')
        .replace(/[^\p{L}\p{N}_ .+#-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
}

/** SearXNG (local, private) when configured, otherwise the governed search chain. */
async function idleSearch(query: string): Promise<{ tool: string; hits: IdleHit[] }> {
    const { getSearXNGUrl, searxngSearch } = await import('../tools/searxng-search.js')
    const base = getSearXNGUrl()
    if (base) {
        const result = await searxngSearch(query, base, { count: 3 })
        if (!result.error && result.results.length > 0) {
            return { tool: 'searxng', hits: result.results.map(item => ({ title: item.title, url: item.url, snippet: item.content })) }
        }
    }
    const { createGovernedWebSearch } = await import('../install/software-freshness.js')
    return createGovernedWebSearch().search(query)
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
    private dataPath: string = getNovaLearningDir('idle-knowledge.json')
    private intervalId?: NodeJS.Timeout

    constructor() {
        this.loadData()
        console.log('[L9 IdleLearning] Manager initialized')
    }

    /**
     * Start the idle learning checker
     */
    start(): void {
        if (this.intervalId) return

        // 2.86: the never-read store of the removed second learner is moved aside once.
        const moved = markMigrated(getNovaDataDir('local-knowledge.json'))
        if (moved) console.log(`[L9 IdleLearning] local-knowledge.json (nie gelesen) → ${moved}`)

        this.intervalId = setInterval(() => {
            this.checkAndLearn()
        }, this.checkIntervalMs)

        console.log('[L9 IdleLearning] Idle checker started')
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
     * Get topics that would be most useful to learn (tool names only)
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
            // 2.86: no question to the owner ("Soll ich X recherchieren?") while idle.
            console.log('[L9 IdleLearning] No new topics to learn')
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
        const query = redactIdleSearchQuery(topic)
        if (!query) return
        console.log(`[L9 IdleLearning] Learning about: ${query}`)

        try {
            const { tool, hits } = await idleSearch(query)

            if (hits.length > 0) {
                // Extract key information
                const summary = hits
                    .slice(0, 2)
                    .map(hit => `• ${hit.title || hit.url || 'Treffer'}: ${String(hit.snippet || '').slice(0, 100)}...`)
                    .join('\n')

                const knowledge: LearnedKnowledge = {
                    topic: query,
                    summary,
                    source: hits[0]?.url || tool,
                    learnedAt: Date.now(),
                }

                this.knowledge.push(knowledge)
                this.saveData()

                console.log(`[L9 IdleLearning] ✅ Learned about ${query} (${tool})`)
            }
        } catch (err) {
            console.log(`[L9 IdleLearning] Failed to learn about ${query}: ${err}`)
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
            const dir = dirname(this.dataPath)
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true })
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
