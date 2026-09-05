/**
 * Feedback Learner
 * 
 * Collects user feedback (👍/👎) and learns from it.
 * Stores patterns that work and patterns to avoid.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface FeedbackEntry {
    id: string
    userMessage: string
    assistantResponse: string
    toolsUsed: string[]
    rating: 'positive' | 'negative'
    correction?: string  // User's correction if negative
    timestamp: number
}

export interface LearnedPattern {
    trigger: string  // What the user asked
    goodResponse: string  // What worked
    badResponses: string[]  // What didn't work
    confidence: number  // 0-100 based on feedback count
}

// ============================================
// Storage
// ============================================

const FEEDBACK_DIR = '.nova-feedback'
let feedbackCache: FeedbackEntry[] = []
let patternsCache: Map<string, LearnedPattern> = new Map()

function ensureDir(): void {
    const dir = join(process.cwd(), FEEDBACK_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function getFeedbackPath(): string {
    ensureDir()
    return join(process.cwd(), FEEDBACK_DIR, 'feedback.json')
}

function getPatternsPath(): string {
    ensureDir()
    return join(process.cwd(), FEEDBACK_DIR, 'patterns.json')
}

/**
 * Load feedback from disk
 */
export function loadFeedback(): FeedbackEntry[] {
    const path = getFeedbackPath()
    if (existsSync(path)) {
        try {
            feedbackCache = JSON.parse(readFileSync(path, 'utf-8'))
        } catch {
            feedbackCache = []
        }
    }
    return feedbackCache
}

/**
 * Save feedback to disk
 */
function saveFeedback(): void {
    writeFileSync(getFeedbackPath(), JSON.stringify(feedbackCache, null, 2))
}

/**
 * Load learned patterns
 */
export function loadPatterns(): Map<string, LearnedPattern> {
    const path = getPatternsPath()
    if (existsSync(path)) {
        try {
            const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, LearnedPattern>
            patternsCache = new Map(Object.entries(data))
        } catch {
            patternsCache = new Map()
        }
    }
    return patternsCache
}

/**
 * Save patterns to disk
 */
function savePatterns(): void {
    const data = Object.fromEntries(patternsCache)
    writeFileSync(getPatternsPath(), JSON.stringify(data, null, 2))
}

// ============================================
// Main API
// ============================================

/**
 * Record user feedback
 */
export function recordFeedback(
    userMessage: string,
    assistantResponse: string,
    rating: 'positive' | 'negative',
    toolsUsed: string[] = [],
    correction?: string
): FeedbackEntry {
    loadFeedback()

    const entry: FeedbackEntry = {
        id: crypto.randomUUID().slice(0, 8),
        userMessage,
        assistantResponse,
        toolsUsed,
        rating,
        correction,
        timestamp: Date.now(),
    }

    feedbackCache.push(entry)
    saveFeedback()

    // Update patterns
    updatePatterns(entry)

    console.log(`[Feedback] Recorded ${rating} feedback for: "${userMessage.slice(0, 30)}..."`)
    return entry
}

/**
 * Update learned patterns based on feedback
 */
function updatePatterns(entry: FeedbackEntry): void {
    loadPatterns()

    // Normalize trigger (remove specifics, keep intent)
    const trigger = normalizeQuery(entry.userMessage)

    let pattern = patternsCache.get(trigger)
    if (!pattern) {
        pattern = {
            trigger,
            goodResponse: '',
            badResponses: [],
            confidence: 0,
        }
    }

    if (entry.rating === 'positive') {
        pattern.goodResponse = entry.assistantResponse
        pattern.confidence = Math.min(100, pattern.confidence + 10)
    } else {
        pattern.badResponses.push(entry.assistantResponse)
        if (entry.correction) {
            pattern.goodResponse = entry.correction
        }
        pattern.confidence = Math.max(0, pattern.confidence - 5)
    }

    patternsCache.set(trigger, pattern)
    savePatterns()
}

/**
 * Normalize query for pattern matching
 */
function normalizeQuery(query: string): string {
    return query
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/\d+/g, 'N')  // Replace numbers
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50)
}

/**
 * Get learned response for a query
 */
export function getLearnedResponse(query: string): string | null {
    loadPatterns()
    const normalized = normalizeQuery(query)
    const pattern = patternsCache.get(normalized)

    if (pattern && pattern.confidence >= 50 && pattern.goodResponse) {
        console.log(`[Feedback] Found learned pattern (confidence: ${pattern.confidence})`)
        return pattern.goodResponse
    }
    return null
}

/**
 * Check if response should be avoided
 */
export function shouldAvoid(query: string, response: string): boolean {
    loadPatterns()
    const normalized = normalizeQuery(query)
    const pattern = patternsCache.get(normalized)

    if (pattern && pattern.badResponses.includes(response)) {
        return true
    }
    return false
}

/**
 * Get feedback stats
 */
export function getStats(): { total: number; positive: number; negative: number; patterns: number } {
    loadFeedback()
    loadPatterns()

    return {
        total: feedbackCache.length,
        positive: feedbackCache.filter(f => f.rating === 'positive').length,
        negative: feedbackCache.filter(f => f.rating === 'negative').length,
        patterns: patternsCache.size,
    }
}

/**
 * Get prompt addition for feedback awareness
 */
export function getFeedbackPrompt(): string {
    const stats = getStats()
    if (stats.total === 0) return ''

    return `

## FEEDBACK-BASIERTES LERNEN
Du hast ${stats.total} Feedback-Einträge (${stats.positive}👍, ${stats.negative}👎).
${stats.patterns} Patterns gelernt. Nutze dieses Wissen!`
}

export default {
    recordFeedback,
    getLearnedResponse,
    shouldAvoid,
    getStats,
    getFeedbackPrompt,
}
