/**
 * User Pattern Tracker
 * 
 * Tracks user behavior patterns for smarter interactions:
 * - Active hours (when they message)
 * - Common topics and tool usage
 * - Unfinished tasks/topics
 * - Session count and message frequency
 * 
 * Persisted to .nova-data/user-patterns.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface UserPattern {
    userId: string
    // Activity patterns
    activeHours: Record<number, number>    // hour (0-23) → message count
    activeDays: Record<number, number>     // day (0=Sun, 6=Sat) → message count
    totalMessages: number
    firstSeen: number
    lastSeen: number

    // Topic patterns
    topTopics: Array<{ topic: string, count: number }>
    recentTopics: string[]                 // Last 10 topics (sliding window)

    // Tool patterns
    toolUsage: Record<string, number>      // tool name → usage count

    // Conversation memory
    lastConversationSummary: string | null
    unfinishedTopics: string[]
    preferences: Record<string, string>    // Key-value preferences learned over time
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const PATTERNS_FILE = join(DATA_DIR, 'user-patterns.json')

let patterns: Map<string, UserPattern> = new Map()
let isDirty = false

function loadPatterns(): void {
    try {
        if (existsSync(PATTERNS_FILE)) {
            const data = JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'))
            patterns = new Map(Object.entries(data))
        }
    } catch {
        patterns = new Map()
    }
}

function savePatterns(): void {
    if (!isDirty) return
    try {
        const obj: Record<string, UserPattern> = {}
        for (const [k, v] of patterns) obj[k] = v
        writeFileSync(PATTERNS_FILE, JSON.stringify(obj, null, 2))
        isDirty = false
    } catch (err) {
        console.warn(`[Patterns] Save failed: ${err}`)
    }
}

// Auto-save every 2 minutes
setInterval(savePatterns, 120_000)

// ============================================
// Topic Detection (Rule-based)
// ============================================

const TOPIC_PATTERNS: Array<{ topic: string, regex: RegExp }> = [
    { topic: 'Server/Deployment', regex: /server|deploy|docker|nginx|ssh|hetzner/i },
    { topic: 'Frontend/UI', regex: /frontend|react|css|tailwind|ui|design|layout|component/i },
    { topic: 'Backend/API', regex: /backend|api|endpoint|route|nest|express|database/i },
    { topic: 'Bug/Debug', regex: /bug|error|fix|debug|broken|fehler|kaputt/i },
    { topic: 'AI/LLM', regex: /llm|model|claude|openai|ollama|prompt|ai|embedding/i },
    { topic: 'File/Code', regex: /datei|file|code|script|function|klasse|class/i },
    { topic: 'Mission/Autonomy', regex: /mission|autonom|goal|ziel|verdien|earn|wallet/i },
    { topic: 'Config/Setup', regex: /config|setup|install|env|environment|setting/i },
    { topic: 'Test/QA', regex: /test|testing|jest|vitest|playwright|qa/i },
    { topic: 'Media', regex: /bild|image|video|audio|photo|kamera|screen/i },
    { topic: 'Memory/DB', regex: /memory|lance|datenbank|database|speicher|vector/i },
    { topic: 'Telegram/Chat', regex: /telegram|bot|nachricht|message|chat|kanal/i },
]

function detectTopics(message: string): string[] {
    return TOPIC_PATTERNS
        .filter(tp => tp.regex.test(message))
        .map(tp => tp.topic)
}

// ============================================
// Core API
// ============================================

/**
 * Record a user interaction (call on every message)
 */
export function trackInteraction(userId: string, message: string, toolsUsed: string[] = []): void {
    if (!patterns.size) loadPatterns()

    let pattern = patterns.get(userId)
    if (!pattern) {
        pattern = {
            userId,
            activeHours: {},
            activeDays: {},
            totalMessages: 0,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            topTopics: [],
            recentTopics: [],
            toolUsage: {},
            lastConversationSummary: null,
            unfinishedTopics: [],
            preferences: {},
        }
    }

    const now = new Date()
    const hour = now.getHours()
    const day = now.getDay()

    // Activity tracking
    pattern.activeHours[hour] = (pattern.activeHours[hour] || 0) + 1
    pattern.activeDays[day] = (pattern.activeDays[day] || 0) + 1
    pattern.totalMessages++
    pattern.lastSeen = Date.now()

    // Topic tracking
    const topics = detectTopics(message)
    for (const topic of topics) {
        pattern.recentTopics.push(topic)
        if (pattern.recentTopics.length > 10) pattern.recentTopics.shift()

        const existing = pattern.topTopics.find(t => t.topic === topic)
        if (existing) {
            existing.count++
        } else {
            pattern.topTopics.push({ topic, count: 1 })
        }
    }
    // Sort topTopics by count
    pattern.topTopics.sort((a, b) => b.count - a.count)
    if (pattern.topTopics.length > 20) pattern.topTopics = pattern.topTopics.slice(0, 20)

    // Tool tracking
    for (const tool of toolsUsed) {
        pattern.toolUsage[tool] = (pattern.toolUsage[tool] || 0) + 1
    }

    patterns.set(userId, pattern)
    isDirty = true
}

/**
 * Get the user's behavior pattern
 */
export function getPattern(userId: string): UserPattern | null {
    if (!patterns.size) loadPatterns()
    return patterns.get(userId) || null
}

/**
 * Get peak active hours for a user
 */
export function getPeakHours(userId: string): number[] {
    const pattern = getPattern(userId)
    if (!pattern) return []

    return Object.entries(pattern.activeHours)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([hour]) => parseInt(hour))
}

/**
 * Get a context prompt based on user patterns
 */
export function getPatternPrompt(userId: string): string {
    const pattern = getPattern(userId)
    if (!pattern || pattern.totalMessages < 5) return '' // Need at least 5 messages for patterns

    const parts: string[] = []

    // Top topics
    const topTopics = pattern.topTopics.slice(0, 5).map(t => t.topic).join(', ')
    if (topTopics) {
        parts.push(`Häufige Themen: ${topTopics}`)
    }

    // Recent topics (what they've been working on)
    const uniqueRecent = [...new Set(pattern.recentTopics)].slice(0, 3)
    if (uniqueRecent.length > 0) {
        parts.push(`Aktuell beschäftigt mit: ${uniqueRecent.join(', ')}`)
    }

    // Activity pattern
    const peakHours = getPeakHours(userId)
    if (peakHours.length > 0) {
        parts.push(`Meistens aktiv um: ${peakHours.map(h => `${h}:00`).join(', ')} Uhr`)
    }

    // Session count
    if (pattern.totalMessages > 0) {
        parts.push(`Insgesamt ${pattern.totalMessages} Nachrichten seit ${new Date(pattern.firstSeen).toLocaleDateString('de-DE')}`)
    }

    // Unfinished topics
    if (pattern.unfinishedTopics.length > 0) {
        parts.push(`Offene Themen: ${pattern.unfinishedTopics.join(', ')}`)
    }

    if (parts.length === 0) return ''

    return `\n\n## USER-KONTEXT (${userId})\n${parts.map(p => `- ${p}`).join('\n')}\n`
}

/**
 * Mark a topic as unfinished (for follow-up)
 */
export function markUnfinished(userId: string, topic: string): void {
    const pattern = getPattern(userId)
    if (!pattern) return
    if (!pattern.unfinishedTopics.includes(topic)) {
        pattern.unfinishedTopics.push(topic)
        if (pattern.unfinishedTopics.length > 5) pattern.unfinishedTopics.shift()
        isDirty = true
    }
}

/**
 * Mark a topic as finished
 */
export function markFinished(userId: string, topic: string): void {
    const pattern = getPattern(userId)
    if (!pattern) return
    pattern.unfinishedTopics = pattern.unfinishedTopics.filter(t => t !== topic)
    isDirty = true
}

/**
 * Store a user preference
 */
export function setPreference(userId: string, key: string, value: string): void {
    const pattern = getPattern(userId)
    if (!pattern) return
    pattern.preferences[key] = value
    isDirty = true
}

/**
 * Get all hours where the user has been active (not just peak)
 */
export function getActiveHours(userId: string): number[] {
    const pattern = getPattern(userId)
    if (!pattern) return []
    return Object.entries(pattern.activeHours)
        .filter(([, count]) => count > 0)
        .map(([hour]) => parseInt(hour))
}

/**
 * Get recent topics the user discussed (for follow-up triggers)
 * Returns both recent topics and unfinished topics
 */
export function getRecentTopics(userId: string): string[] {
    const pattern = getPattern(userId)
    if (!pattern) return []
    // Combine unfinished topics (higher priority) with recent topics
    const combined = [...pattern.unfinishedTopics, ...pattern.recentTopics]
    return [...new Set(combined)].slice(0, 5)
}

/**
 * Flush patterns to disk
 */
export function flush(): void {
    savePatterns()
}

export default {
    trackInteraction,
    getPattern,
    getPeakHours,
    getActiveHours,
    getRecentTopics,
    getPatternPrompt,
    markUnfinished,
    markFinished,
    setPreference,
    flush,
}
