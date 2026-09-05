/**
 * Proactive Learning System
 * 
 * Nova asks user what to learn and improves continuously:
 * - After successful tasks: "Soll ich lernen wie ich das besser mache?"
 * - After failures: "Soll ich lernen wie man das Problem löst?"
 * - When idle: "Was soll ich für dich recherchieren?"
 * 
 * Learned knowledge is shared via Supabase Learning Hub.
 */

import { shareKnowledge, fetchSharedKnowledge } from './learning-hub.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Learning Queue
// ============================================

interface LearningRequest {
    topic: string
    reason: 'success' | 'failure' | 'user_request' | 'idle'
    context?: string
    priority: number
    userId: string
    channel: string
    createdAt: number
}

const learningQueue: LearningRequest[] = []
const recentlyAsked: Map<string, number> = new Map()  // topic -> timestamp

// Don't ask about same topic within 1 hour
const ASK_COOLDOWN_MS = 60 * 60 * 1000

// Local knowledge cache (persisted to disk)
const KNOWLEDGE_DIR = join(process.cwd(), '.nova-data')
const KNOWLEDGE_FILE = join(KNOWLEDGE_DIR, 'local-knowledge.json')
let localKnowledge: Map<string, string[]> = new Map()

// Load on startup
try {
    if (existsSync(KNOWLEDGE_FILE)) {
        const data = JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf-8'))
        localKnowledge = new Map(Object.entries(data))
        console.log(`[ProactiveLearning] Loaded ${localKnowledge.size} local knowledge topics`)
    }
} catch { /* fresh start */ }

function saveLocalKnowledge(): void {
    try {
        if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true })
        writeFileSync(KNOWLEDGE_FILE, JSON.stringify(Object.fromEntries(localKnowledge), null, 2))
    } catch { /* non-critical */ }
}

// ============================================
// Check if should ask user to learn
// ============================================

export function shouldAskToLearn(topic: string): boolean {
    const lastAsked = recentlyAsked.get(topic)
    if (lastAsked && Date.now() - lastAsked < ASK_COOLDOWN_MS) {
        return false
    }
    return true
}

// ============================================
// Generate learning prompt after tool execution
// ============================================

export function generatePostToolLearningPrompt(
    toolName: string,
    success: boolean,
    errorMsg?: string
): string | null {
    const topic = toolName.toLowerCase()

    if (!shouldAskToLearn(topic)) {
        return null
    }

    recentlyAsked.set(topic, Date.now())

    if (success) {
        // Only ask sometimes for successful operations (20% chance)
        if (Math.random() > 0.2) {
            return null
        }
        return `\n\n💡 _Das hat funktioniert! Soll ich mir merken wie ${toolName} optimal genutzt wird?_`
    } else {
        // Always offer to learn from failures
        return `\n\n🔧 _Fehler aufgetreten. Soll ich lernen wie man "${errorMsg?.slice(0, 50) || 'dieses Problem'}" löst?_`
    }
}

// ============================================
// Check if similar knowledge exists in Hub
// ============================================

export async function checkIfAlreadyLearned(topic: string): Promise<string[] | null> {
    const sharedKnowledge = await fetchSharedKnowledge()

    // Search for similar topics
    for (const [existingTopic, facts] of sharedKnowledge.entries()) {
        if (existingTopic.toLowerCase().includes(topic.toLowerCase()) ||
            topic.toLowerCase().includes(existingTopic.toLowerCase())) {
            console.log(`[ProactiveLearning] Found existing knowledge: ${existingTopic}`)
            return facts
        }
    }

    return null
}

// ============================================
// Queue learning request from user
// ============================================

export function queueLearningRequest(
    topic: string,
    reason: LearningRequest['reason'],
    userId: string,
    channel: string,
    context?: string
): void {
    const request: LearningRequest = {
        topic,
        reason,
        context,
        priority: reason === 'failure' ? 10 : reason === 'user_request' ? 8 : 5,
        userId,
        channel,
        createdAt: Date.now(),
    }

    learningQueue.push(request)
    learningQueue.sort((a, b) => b.priority - a.priority)

    // Keep queue limited
    if (learningQueue.length > 50) {
        learningQueue.pop()
    }

    console.log(`[ProactiveLearning] Queued: "${topic}" (reason: ${reason}, queue: ${learningQueue.length})`)
}

// ============================================
// Get next learning topic for idle time
// ============================================

export function getNextLearningTopic(): LearningRequest | null {
    return learningQueue.shift() || null
}

// ============================================
// Generate idle learning prompt
// ============================================

export function generateIdleLearningPrompt(): string {
    if (learningQueue.length > 0) {
        const next = learningQueue[0]
        // No quotes - breaks Telegram Markdown
        return `🧠 Ich habe gerade nichts zu tun. Soll ich ${next.topic} für dich recherchieren?`
    }

    return `🧠 Ich habe gerade nichts zu tun. Gibt es ein Thema, das ich für dich lernen soll?`
}

// ============================================
// Process user's learning response
// ============================================

export async function processLearningResponse(
    response: string,
    userId: string,
    channel: string
): Promise<{ shouldLearn: boolean; topic?: string }> {
    const lower = response.toLowerCase()

    // Positive responses
    if (lower.match(/^(ja|yes|ok|mach|lern|sure|go)/)) {
        const pending = learningQueue.find(r => r.userId === userId)
        if (pending) {
            return { shouldLearn: true, topic: pending.topic }
        }
        return { shouldLearn: true }
    }

    // Negative responses
    if (lower.match(/^(nein|no|nicht|skip|later)/)) {
        // Remove from queue
        const idx = learningQueue.findIndex(r => r.userId === userId)
        if (idx >= 0) {
            learningQueue.splice(idx, 1)
        }
        return { shouldLearn: false }
    }

    // User specified a topic
    if (lower.includes('lern') || lower.includes('recherchier')) {
        const topicMatch = response.match(/(?:lern|recherchier)[^\w]*(.+)/i)
        if (topicMatch) {
            return { shouldLearn: true, topic: topicMatch[1].trim() }
        }
    }

    return { shouldLearn: false }
}

// ============================================
// Execute learning and share with Hub
// ============================================

export async function executeAndShareLearning(
    topic: string,
    facts: string[]
): Promise<boolean> {
    if (facts.length === 0) {
        console.log('[ProactiveLearning] No facts to share')
        return false
    }

    console.log(`[ProactiveLearning] Sharing ${facts.length} facts about: ${topic}`)
    return await shareKnowledge(topic, facts)
}

// ============================================
// Knowledge check helper
// ============================================

export function hasKnowledgeAbout(topic: string): boolean {
    const lower = topic.toLowerCase()
    for (const key of localKnowledge.keys()) {
        if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
            return true
        }
    }
    return false
}

export function storeKnowledge(topic: string, facts: string[]): void {
    const existing = localKnowledge.get(topic) || []
    const merged = [...new Set([...existing, ...facts])].slice(0, 30)
    localKnowledge.set(topic, merged)
    saveLocalKnowledge()
}

export function getLocalKnowledge(): Map<string, string[]> {
    return new Map(localKnowledge)
}

// ============================================
// Add topic from error (for automatic learning)
// ============================================

export function addTopicFromError(error: string, context?: string): void {
    const topic = `error: ${error.slice(0, 50)}`
    queueLearningRequest(topic, 'failure', 'system', 'internal', context)
}

// ============================================
// Learn during idle (background learning)
// ============================================

export async function learnDuringIdle(): Promise<{ learned: boolean; topic?: string }> {
    const next = getNextLearningTopic()
    if (!next) {
        console.log('[ProactiveLearning] No topics in queue for idle learning')
        return { learned: false }
    }

    console.log(`[ProactiveLearning] Idle learning: ${next.topic}`)

    // Check if already learned by collective
    const existing = await checkIfAlreadyLearned(next.topic)
    if (existing) {
        console.log(`[ProactiveLearning] Already learned by collective: ${next.topic}`)
        return { learned: true, topic: `${next.topic} (von Kollektiv)` }
    }

    // Actually learn about the topic via web search
    try {
        // Try Tavily search first
        const { tavilySearchTool } = await import('../tools/tavily-search.js').catch(() => ({ tavilySearchTool: null }))

        let searchResults: any[] = []

        if (tavilySearchTool) {
            const result = await tavilySearchTool.handler({ query: next.topic, count: 3 }) as any
            searchResults = result?.results || []
        } else {
            // Fallback to web_search via registry
            const { getToolRegistry } = await import('../tools/complete-registry.js')
            const registry = getToolRegistry()
            const result = await registry.execute('web_search', { query: next.topic }) as any
            searchResults = result?.results || []
        }

        if (searchResults.length === 0) {
            console.log(`[ProactiveLearning] No search results for: ${next.topic}`)
            return { learned: false, topic: next.topic }
        }

        // Extract key facts from search results
        const facts = searchResults
            .slice(0, 3)
            .map((r: any) => r.content || r.snippet || r.description || '')
            .filter((s: string) => s.length > 20)
            .map((s: string) => s.slice(0, 500))

        if (facts.length > 0) {
            // Share with collective
            await shareKnowledge(next.topic, facts)
            console.log(`[ProactiveLearning] ✅ Learned ${facts.length} facts about: ${next.topic}`)
            return { learned: true, topic: next.topic }
        }
    } catch (err) {
        console.log(`[ProactiveLearning] Learning error: ${err}`)
    }

    return { learned: false, topic: next.topic }
}

// ============================================
// Get recently learned topic (for proactive sharing)
// ============================================

export function getRecentlyLearned(): { topic: string; factCount: number } | null {
    if (localKnowledge.size === 0) return null
    // Return the last entry (most recently added)
    const entries = [...localKnowledge.entries()]
    const last = entries[entries.length - 1]
    if (!last) return null
    return { topic: last[0], factCount: last[1].length }
}

// ============================================
// Get learning stats
// ============================================

export function getLearningStats(): { learnedTopics: number; totalTopics: number; knowledgeItems: number } {
    return {
        learnedTopics: learningQueue.filter(r => r.reason === 'success').length,
        totalTopics: learningQueue.length,
        knowledgeItems: learningQueue.reduce((sum, r) => sum + (r.context?.length || 0) / 100, 0) | 0,
    }
}

export default {
    generatePostToolLearningPrompt,
    checkIfAlreadyLearned,
    queueLearningRequest,
    getNextLearningTopic,
    generateIdleLearningPrompt,
    processLearningResponse,
    executeAndShareLearning,
    shouldAskToLearn,
    hasKnowledgeAbout,
    storeKnowledge,
    getLocalKnowledge,
    getRecentlyLearned,
    addTopicFromError,
    learnDuringIdle,
    getLearningStats,
}
