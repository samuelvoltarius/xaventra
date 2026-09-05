/**
 * Nova - Feedback Collector
 * 
 * Captures and stores user feedback for self-improvement
 * Tracks corrections, positive/negative feedback, and learns from patterns
 */

import { randomUUID } from 'node:crypto'

// ============================================
// Types
// ============================================

export type FeedbackType = 'correction' | 'positive' | 'negative' | 'preference'

export interface Feedback {
    id: string
    type: FeedbackType
    timestamp: number

    // Context
    userMessage: string
    botResponse: string

    // Correction details
    correction?: string

    // Metadata
    channel?: string
    userId?: string
    processed: boolean
}

export interface FeedbackStats {
    total: number
    corrections: number
    positive: number
    negative: number
    preferences: number
    unprocessed: number
}

// ============================================
// Feedback Triggers (Regex patterns)
// ============================================

const CORRECTION_TRIGGERS = [
    /das (war|ist) (falsch|nicht richtig|inkorrekt)/i,
    /nein,?\s*(das|es)\s*(stimmt|ist)\s*nicht/i,
    /that('s| is| was) (wrong|incorrect|not right)/i,
    /eigentlich\s*(ist|war|sollte)/i,
    /ich meinte/i,
    /korrektur:/i,
    /besser wäre/i,
]

const POSITIVE_TRIGGERS = [
    /danke|thanks|thank you/i,
    /perfekt|perfect|genau|exactly/i,
    /super|great|toll|awesome/i,
    /richtig|correct|stimmt/i,
    /👍|✅|🎉|❤️/,
]

const NEGATIVE_TRIGGERS = [
    /schlecht|bad|terrible/i,
    /das hilft nicht/i,
    /unbrauchbar|useless/i,
    /verstehst.*nicht/i,
    /👎|❌|😤/,
]

const PREFERENCE_TRIGGERS = [
    /ich (mag|bevorzuge|will|möchte) (lieber|eher)/i,
    /i (prefer|like|want)/i,
    /bitte (immer|nie|nicht)/i,
    /in zukunft/i,
    /merk dir/i,
    /remember that/i,
]

// ============================================
// Feedback Collector Class
// ============================================

export class FeedbackCollector {
    private feedbackStore: Map<string, Feedback> = new Map()
    private learnedCorrections: Map<string, string> = new Map()

    // ============================================
    // Detection
    // ============================================

    detectFeedbackType(message: string): FeedbackType | null {
        if (CORRECTION_TRIGGERS.some(r => r.test(message))) return 'correction'
        if (POSITIVE_TRIGGERS.some(r => r.test(message))) return 'positive'
        if (NEGATIVE_TRIGGERS.some(r => r.test(message))) return 'negative'
        if (PREFERENCE_TRIGGERS.some(r => r.test(message))) return 'preference'
        return null
    }

    // ============================================
    // Collection
    // ============================================

    collectFeedback(params: {
        type: FeedbackType
        userMessage: string
        botResponse: string
        correction?: string
        channel?: string
        userId?: string
    }): Feedback {
        const feedback: Feedback = {
            id: randomUUID(),
            type: params.type,
            timestamp: Date.now(),
            userMessage: params.userMessage,
            botResponse: params.botResponse,
            correction: params.correction,
            channel: params.channel,
            userId: params.userId,
            processed: false,
        }

        this.feedbackStore.set(feedback.id, feedback)
        console.log(`[Nova Learning] Collected ${feedback.type} feedback: ${feedback.id}`)

        // Auto-process corrections
        if (feedback.type === 'correction' && feedback.correction) {
            this.processCorrection(feedback)
        }

        return feedback
    }

    // ============================================
    // Processing
    // ============================================

    private processCorrection(feedback: Feedback): void {
        if (!feedback.correction) return

        // Extract the key pattern from user message
        const pattern = this.extractPattern(feedback.userMessage)
        const scope = feedback.userId || 'global'

        // Store the correction inside the immutable principal scope. A
        // correction from one user must never become another user's answer.
        this.learnedCorrections.set(`${scope}::${pattern}`, feedback.correction)
        feedback.processed = true

        console.log(`[Nova Learning] Learned correction: "${pattern}" → "${feedback.correction.slice(0, 50)}..."`)
    }

    private extractPattern(message: string): string {
        // Normalize: lowercase, remove punctuation, collapse spaces
        return message
            .toLowerCase()
            .replace(/[^\w\säöüß]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100) // Limit pattern length
    }

    // ============================================
    // Retrieval
    // ============================================

    getLearnedResponse(message: string, userId?: string): string | undefined {
        const pattern = this.extractPattern(message)
        const scope = userId || 'global'
        const scopedPattern = `${scope}::${pattern}`

        // Exact match
        if (this.learnedCorrections.has(scopedPattern)) {
            return this.learnedCorrections.get(scopedPattern)
        }

        // Fuzzy match (check if pattern is contained)
        for (const [storedKey, response] of this.learnedCorrections) {
            const separator = storedKey.indexOf('::')
            if (separator < 0 || storedKey.slice(0, separator) !== scope) continue
            const storedPattern = storedKey.slice(separator + 2)
            if (pattern.includes(storedPattern) || storedPattern.includes(pattern)) {
                return response
            }
        }

        return undefined
    }

    getAllFeedback(): Feedback[] {
        return Array.from(this.feedbackStore.values())
    }

    getUnprocessedFeedback(): Feedback[] {
        return this.getAllFeedback().filter(f => !f.processed)
    }

    getFeedbackById(id: string): Feedback | undefined {
        return this.feedbackStore.get(id)
    }

    // ============================================
    // Statistics
    // ============================================

    getStats(): FeedbackStats {
        const all = this.getAllFeedback()
        return {
            total: all.length,
            corrections: all.filter(f => f.type === 'correction').length,
            positive: all.filter(f => f.type === 'positive').length,
            negative: all.filter(f => f.type === 'negative').length,
            preferences: all.filter(f => f.type === 'preference').length,
            unprocessed: all.filter(f => !f.processed).length,
        }
    }

    getLearnedCorrectionsCount(): number {
        return this.learnedCorrections.size
    }

    // ============================================
    // Persistence (simple JSON)
    // ============================================

    exportToJSON(): string {
        return JSON.stringify({
            feedback: Array.from(this.feedbackStore.entries()),
            corrections: Array.from(this.learnedCorrections.entries()),
        }, null, 2)
    }

    importFromJSON(json: string): void {
        try {
            const data = JSON.parse(json)

            if (data.feedback) {
                this.feedbackStore = new Map(data.feedback)
            }
            if (data.corrections) {
                this.learnedCorrections = new Map(
                    (data.corrections as Array<[string, string]>).map(([key, value]) => [
                        key.includes('::') ? key : `legacy::${key}`,
                        value,
                    ]),
                )
            }

            console.log(`[Nova Learning] Imported ${this.feedbackStore.size} feedback entries, ${this.learnedCorrections.size} corrections`)
        } catch (err) {
            console.error('[Nova Learning] Failed to import:', err)
        }
    }
}

// ============================================
// Factory
// ============================================

export function createFeedbackCollector(): FeedbackCollector {
    return new FeedbackCollector()
}

export default { FeedbackCollector, createFeedbackCollector }
