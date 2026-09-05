/**
 * Nova - Pattern Detector
 * 
 * Identifies recurring patterns in user interactions
 * Detects frequently asked questions, common tasks, and behavioral patterns
 */

import { randomUUID } from 'node:crypto'

// ============================================
// Types
// ============================================

export interface Pattern {
    id: string
    pattern: string       // Normalized pattern string
    category: PatternCategory
    frequency: number     // How often this pattern occurs
    examples: string[]    // Original messages that matched
    response?: string     // Learned optimal response
    confidence: number    // 0-1 confidence score
    createdAt: number
    lastSeenAt: number
}

export type PatternCategory =
    | 'question'        // FAQ-style questions
    | 'command'         // User giving instructions
    | 'greeting'        // Hello/goodbye patterns
    | 'preference'      // User preferences
    | 'correction'      // Correction patterns
    | 'task'            // Task requests
    | 'other'

// ============================================
// Pattern Detection Constants
// ============================================

const CATEGORY_PATTERNS: Record<PatternCategory, RegExp[]> = {
    question: [
        /^(was|wer|wie|wo|wann|warum|welche)/i,
        /^(what|who|how|where|when|why|which)/i,
        /\?$/,
        /kannst du.*erklären/i,
        /can you explain/i,
    ],
    command: [
        /^(mach|tue|erstelle|schreibe|zeige|öffne)/i,
        /^(do|make|create|write|show|open)/i,
        /^(bitte|please)/i,
        /^\/\w+/,  // Slash commands
    ],
    greeting: [
        /^(hallo|hi|hey|guten|servus|moin)/i,
        /^(hello|hi|hey|good morning)/i,
        /^(tschüss|bye|auf wiedersehen)/i,
    ],
    preference: [
        /ich (mag|bevorzuge|will|möchte)/i,
        /i (like|prefer|want)/i,
        /bitte (immer|nie)/i,
    ],
    correction: [
        /das (war|ist) (falsch|nicht richtig)/i,
        /nein.*stimmt.*nicht/i,
    ],
    task: [
        /^(hilf mir|help me)/i,
        /kannst du (mir )?helfen/i,
        /ich brauche/i,
        /i need/i,
    ],
    other: [],
}

const MIN_FREQUENCY_THRESHOLD = 3  // Min occurrences to become a pattern
const SIMILARITY_THRESHOLD = 0.7   // Min similarity for pattern matching

// ============================================
// Pattern Detector Class
// ============================================

export class PatternDetector {
    private patterns: Map<string, Pattern> = new Map()
    private recentMessages: Array<{ message: string; timestamp: number }> = []
    private maxRecent = 100

    // ============================================
    // Message Processing
    // ============================================

    processMessage(message: string): Pattern | null {
        const normalized = this.normalize(message)
        if (normalized.length < 5) return null

        // Store in recent messages
        this.recentMessages.push({ message, timestamp: Date.now() })
        if (this.recentMessages.length > this.maxRecent) {
            this.recentMessages.shift()
        }

        // Check existing patterns
        const existingPattern = this.findMatchingPattern(normalized)
        if (existingPattern) {
            existingPattern.frequency++
            existingPattern.lastSeenAt = Date.now()
            if (existingPattern.examples.length < 10) {
                existingPattern.examples.push(message)
            }
            existingPattern.confidence = this.calculateConfidence(existingPattern)

            console.log(`[Nova Patterns] Updated pattern: "${existingPattern.pattern}" (freq: ${existingPattern.frequency})`)
            return existingPattern
        }

        // Check if this message appears frequently in recent history
        const frequency = this.countSimilarInRecent(normalized)
        if (frequency >= MIN_FREQUENCY_THRESHOLD) {
            const pattern = this.createPattern(message, normalized, frequency)
            this.patterns.set(pattern.id, pattern)
            console.log(`[Nova Patterns] New pattern detected: "${pattern.pattern}" (category: ${pattern.category})`)
            return pattern
        }

        return null
    }

    // ============================================
    // Pattern Matching
    // ============================================

    private findMatchingPattern(normalized: string): Pattern | null {
        for (const pattern of this.patterns.values()) {
            if (this.calculateSimilarity(normalized, pattern.pattern) >= SIMILARITY_THRESHOLD) {
                return pattern
            }
        }
        return null
    }

    findPatternForMessage(message: string): Pattern | null {
        const normalized = this.normalize(message)
        return this.findMatchingPattern(normalized)
    }

    // ============================================
    // Pattern Creation
    // ============================================

    private createPattern(original: string, normalized: string, frequency: number): Pattern {
        return {
            id: randomUUID(),
            pattern: normalized,
            category: this.detectCategory(original),
            frequency,
            examples: [original],
            confidence: 0.3 + (frequency * 0.1),
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
        }
    }

    private detectCategory(message: string): PatternCategory {
        for (const [category, regexes] of Object.entries(CATEGORY_PATTERNS)) {
            if (regexes.some(r => r.test(message))) {
                return category as PatternCategory
            }
        }
        return 'other'
    }

    // ============================================
    // Similarity Calculation
    // ============================================

    private calculateSimilarity(a: string, b: string): number {
        // Jaccard similarity on words
        const wordsA = new Set(a.split(/\s+/))
        const wordsB = new Set(b.split(/\s+/))

        const intersection = new Set([...wordsA].filter(x => wordsB.has(x)))
        const union = new Set([...wordsA, ...wordsB])

        if (union.size === 0) return 0
        return intersection.size / union.size
    }

    private calculateConfidence(pattern: Pattern): number {
        // Confidence based on frequency and recency
        const freqScore = Math.min(pattern.frequency / 10, 0.5)
        const recencyScore = this.calculateRecencyScore(pattern.lastSeenAt)
        return Math.min(freqScore + recencyScore + 0.2, 1.0)
    }

    private calculateRecencyScore(timestamp: number): number {
        const hoursSince = (Date.now() - timestamp) / (1000 * 60 * 60)
        return Math.max(0, 0.3 - (hoursSince * 0.01))
    }

    // ============================================
    // Helpers
    // ============================================

    private normalize(message: string): string {
        return message
            .toLowerCase()
            .replace(/[^\w\säöüß]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
    }

    private countSimilarInRecent(normalized: string): number {
        return this.recentMessages.filter(m =>
            this.calculateSimilarity(this.normalize(m.message), normalized) >= SIMILARITY_THRESHOLD
        ).length
    }

    // ============================================
    // Pattern Management
    // ============================================

    setPatternResponse(patternId: string, response: string): boolean {
        const pattern = this.patterns.get(patternId)
        if (pattern) {
            pattern.response = response
            pattern.confidence = Math.min(pattern.confidence + 0.2, 1.0)
            console.log(`[Nova Patterns] Set response for pattern: "${pattern.pattern}"`)
            return true
        }
        return false
    }

    getAllPatterns(): Pattern[] {
        return Array.from(this.patterns.values())
    }

    getHighConfidencePatterns(minConfidence = 0.7): Pattern[] {
        return this.getAllPatterns().filter(p => p.confidence >= minConfidence)
    }

    getPatternsByCategory(category: PatternCategory): Pattern[] {
        return this.getAllPatterns().filter(p => p.category === category)
    }

    // ============================================
    // Statistics
    // ============================================

    getStats(): {
        totalPatterns: number
        byCategory: Record<PatternCategory, number>
        highConfidence: number
        withResponse: number
    } {
        const patterns = this.getAllPatterns()
        const categories: Record<PatternCategory, number> = {
            question: 0, command: 0, greeting: 0, preference: 0, correction: 0, task: 0, other: 0,
        }

        for (const p of patterns) {
            categories[p.category]++
        }

        return {
            totalPatterns: patterns.length,
            byCategory: categories,
            highConfidence: patterns.filter(p => p.confidence >= 0.7).length,
            withResponse: patterns.filter(p => p.response).length,
        }
    }

    // ============================================
    // Persistence
    // ============================================

    exportToJSON(): string {
        return JSON.stringify({
            patterns: Array.from(this.patterns.entries()),
        }, null, 2)
    }

    importFromJSON(json: string): void {
        try {
            const data = JSON.parse(json)
            if (data.patterns) {
                this.patterns = new Map(data.patterns)
            }
            console.log(`[Nova Patterns] Imported ${this.patterns.size} patterns`)
        } catch (err) {
            console.error('[Nova Patterns] Failed to import:', err)
        }
    }
}

// ============================================
// Factory
// ============================================

export function createPatternDetector(): PatternDetector {
    return new PatternDetector()
}

export default { PatternDetector, createPatternDetector }
