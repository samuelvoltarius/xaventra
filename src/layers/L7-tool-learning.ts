/**
 * Layer 7 - Tool Usage Learning
 * 
 * Nova learns from her mistakes when using tools:
 * - Tracks tool call failures and successes
 * - Learns patterns from corrections
 * - Applies learned patterns to future tool calls
 * - Stores examples for few-shot learning
 * 
 * This enables Nova to get SMARTER over time.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { join, dirname } from 'node:path'

// ============================================
// Types
// ============================================

export interface ToolUsageExample {
    id: string
    toolName: string
    userRequest: string           // What the user asked
    extractedParams: Record<string, unknown>  // What Nova extracted
    wasCorrect: boolean
    correction?: {
        correctParams: Record<string, unknown>
        explanation: string
    }
    timestamp: number
    usedInPrompt: boolean  // Has this been used as few-shot example?
}

export interface ToolPattern {
    id: string
    toolName: string
    pattern: string              // Regex or keyword pattern
    parameterMapping: Record<string, string[]>  // How to extract params (correction history)
    examples: string[]           // Example user requests
    successRate: number
    learnedFrom: string[]        // Example IDs this was learned from
}

export interface LearningStats {
    totalExamples: number
    correctExamples: number
    correctedExamples: number
    patterns: number
    toolBreakdown: Record<string, { correct: number; incorrect: number }>
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const EXAMPLES_FILE = join(DATA_DIR, 'tool-examples.json')
const PATTERNS_FILE = join(DATA_DIR, 'tool-patterns.json')

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true })
    }
}

function loadExamples(): ToolUsageExample[] {
    try {
        if (existsSync(EXAMPLES_FILE)) {
            return JSON.parse(readFileSync(EXAMPLES_FILE, 'utf-8'))
        }
    } catch { }
    return []
}

function saveExamples(examples: ToolUsageExample[]): void {
    ensureDir()
    atomicWriteJsonSync(EXAMPLES_FILE, examples)
}

function loadPatterns(): ToolPattern[] {
    try {
        if (existsSync(PATTERNS_FILE)) {
            return JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'))
        }
    } catch { }
    return []
}

function savePatterns(patterns: ToolPattern[]): void {
    ensureDir()
    atomicWriteJsonSync(PATTERNS_FILE, patterns)
}

// ============================================
// Tool Usage Learner
// ============================================

class ToolUsageLearner {
    private examples: ToolUsageExample[] = []
    private patterns: ToolPattern[] = []

    constructor() {
        this.examples = loadExamples()
        this.patterns = loadPatterns()
        console.log(`[ToolLearner] Loaded ${this.examples.length} examples, ${this.patterns.length} patterns`)
    }

    /**
     * Record a tool usage (whether successful or not)
     */
    recordUsage(
        toolName: string,
        userRequest: string,
        extractedParams: Record<string, unknown>,
        wasCorrect: boolean
    ): ToolUsageExample {
        // SECURITY: Strip sensitive fields before persisting
        const sanitizedParams = { ...extractedParams }
        const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential', 'apiKey', 'api_key']
        for (const k of Object.keys(sanitizedParams)) {
            if (sensitiveKeys.some(s => k.toLowerCase().includes(s))) {
                sanitizedParams[k] = '[REDACTED]'
            }
        }

        const example: ToolUsageExample = {
            id: `ex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            toolName,
            userRequest,
            extractedParams: sanitizedParams,
            wasCorrect,
            timestamp: Date.now(),
            usedInPrompt: false,
        }

        this.examples.push(example)
        saveExamples(this.examples)

        console.log(`[ToolLearner] Recorded ${wasCorrect ? '✅' : '❌'} usage of ${toolName}`)
        return example
    }

    /**
     * Record a correction from the user
     */
    recordCorrection(
        exampleId: string,
        correctParams: Record<string, unknown>,
        explanation: string
    ): void {
        const example = this.examples.find(e => e.id === exampleId)
        if (!example) {
            console.log(`[ToolLearner] Example not found: ${exampleId}`)
            return
        }

        example.wasCorrect = false
        example.correction = { correctParams, explanation }
        saveExamples(this.examples)

        console.log(`[ToolLearner] 📝 Correction recorded for ${example.toolName}`)

        // Try to learn a pattern from this correction
        this.learnFromCorrection(example)
    }

    /**
     * Learn a pattern from a correction
     */
    private learnFromCorrection(example: ToolUsageExample): void {
        if (!example.correction) return

        // Look for similar past corrections for this tool
        const similarCorrections = this.examples.filter(e =>
            e.toolName === example.toolName &&
            e.correction &&
            e.id !== example.id
        )

        // Find common parameter patterns
        const paramDiffs: Record<string, string[]> = {}

        for (const [key, correctValue] of Object.entries(example.correction.correctParams)) {
            const extractedValue = example.extractedParams[key]
            if (extractedValue !== correctValue) {
                if (!paramDiffs[key]) paramDiffs[key] = []
                paramDiffs[key].push(`${extractedValue} → ${correctValue}`)
            }
        }

        // Create or update pattern
        const existingPattern = this.patterns.find(p =>
            p.toolName === example.toolName &&
            Object.keys(p.parameterMapping).some(k => paramDiffs[k])
        )

        if (existingPattern) {
            existingPattern.examples.push(example.userRequest)
            existingPattern.learnedFrom.push(example.id)
            savePatterns(this.patterns)
            console.log(`[ToolLearner] 🔄 Updated pattern: ${existingPattern.pattern}`)

            // NOTIFY: Updated existing pattern
            this.notifyLearning('pattern_updated', example.toolName,
                `Ich habe mein Verständnis für "${example.toolName}" verbessert!`)

        } else if (Object.keys(paramDiffs).length > 0) {
            // Create new pattern based on correction
            const newPattern: ToolPattern = {
                id: `pat_${Date.now()}`,
                toolName: example.toolName,
                pattern: this.extractPattern(example.userRequest),
                parameterMapping: paramDiffs,
                examples: [example.userRequest],
                successRate: 0,
                learnedFrom: [example.id],
            }
            this.patterns.push(newPattern)
            savePatterns(this.patterns)
            console.log(`[ToolLearner] 🆕 Learned new pattern for ${example.toolName}`)

            // NOTIFY: New pattern learned
            this.notifyLearning('pattern_new', example.toolName,
                `🎓 Ich habe etwas Neues gelernt! Bei "${example.toolName}" weiß ich jetzt, wie ich Parameter richtig extrahiere.`)
        }
    }

    /**
     * Notify about learning (via console and optional callback)
     */
    private onLearnCallback: ((type: string, tool: string, message: string) => void) | null = null

    setOnLearnCallback(callback: (type: string, tool: string, message: string) => void): void {
        this.onLearnCallback = callback
    }

    private notifyLearning(type: string, tool: string, message: string): void {
        console.log(`[ToolLearner] 📢 ${message}`)

        if (this.onLearnCallback) {
            this.onLearnCallback(type, tool, message)
        }
    }

    /**
     * Extract a pattern from a user request
     */
    private extractPattern(request: string): string {
        // Simple pattern extraction - look for key structural elements
        return request
            .replace(/\d+\.\d+\.\d+\.\d+/g, '{IP}')
            .replace(/\d{4,5}/g, '{PORT}')
            .replace(/\w+@/g, '{USER}@')
            .replace(/password[:\s]+\w+/gi, 'password: {PASSWORD}')
    }

    /**
     * Get similar examples for few-shot learning
     */
    getFewShotExamples(toolName: string, limit: number = 3): ToolUsageExample[] {
        // Get corrected examples for this tool (most useful for learning)
        const corrected = this.examples
            .filter(e => e.toolName === toolName && e.correction)
            .slice(-limit)

        // Also get successful examples
        const successful = this.examples
            .filter(e => e.toolName === toolName && e.wasCorrect && !e.correction)
            .slice(-limit)

        return [...corrected, ...successful].slice(0, limit)
    }

    /**
     * Build a learning prompt for the LLM
     */
    buildLearningPrompt(toolName: string): string {
        const examples = this.getFewShotExamples(toolName)
        if (examples.length === 0) return ''

        let prompt = `\n## Gelernte Beispiele für ${toolName}:\n\n`

        for (const ex of examples) {
            if (ex.correction) {
                prompt += `❌ FALSCH: "${ex.userRequest}"\n`
                prompt += `   Extrahiert: ${JSON.stringify(ex.extractedParams)}\n`
                prompt += `✅ RICHTIG: ${JSON.stringify(ex.correction.correctParams)}\n`
                prompt += `   Grund: ${ex.correction.explanation}\n\n`
            } else if (ex.wasCorrect) {
                prompt += `✅ KORREKT: "${ex.userRequest}"\n`
                prompt += `   Params: ${JSON.stringify(ex.extractedParams)}\n\n`
            }
        }

        return prompt
    }

    /**
     * Suggest parameter corrections based on learned patterns
     */
    suggestCorrections(
        toolName: string,
        userRequest: string,
        extractedParams: Record<string, unknown>
    ): Record<string, unknown> | null {
        // Find matching patterns
        for (const pattern of this.patterns) {
            if (pattern.toolName !== toolName) continue

            // Check if any examples are similar
            for (const example of pattern.examples) {
                const similarity = this.calculateSimilarity(userRequest, example)
                if (similarity > 0.7) {
                    // Found a similar request - apply the learned corrections
                    console.log(`[ToolLearner] 🎯 Found matching pattern with ${(similarity * 100).toFixed(0)}% similarity`)

                    // Get the correction from a similar example
                    const learnedExample = this.examples.find(e =>
                        pattern.learnedFrom.includes(e.id) && e.correction
                    )

                    if (learnedExample?.correction) {
                        return learnedExample.correction.correctParams
                    }
                }
            }
        }

        return null
    }

    /**
     * Simple string similarity
     */
    private calculateSimilarity(a: string, b: string): number {
        const wordsA = a.toLowerCase().split(/\s+/)
        const wordsB = b.toLowerCase().split(/\s+/)

        const common = wordsA.filter(w => wordsB.includes(w)).length
        return common / Math.max(wordsA.length, wordsB.length)
    }

    /**
     * Get learning statistics
     */
    getStats(): LearningStats {
        const toolBreakdown: Record<string, { correct: number; incorrect: number }> = {}

        for (const ex of this.examples) {
            if (!toolBreakdown[ex.toolName]) {
                toolBreakdown[ex.toolName] = { correct: 0, incorrect: 0 }
            }
            if (ex.wasCorrect) {
                toolBreakdown[ex.toolName].correct++
            } else {
                toolBreakdown[ex.toolName].incorrect++
            }
        }

        return {
            totalExamples: this.examples.length,
            correctExamples: this.examples.filter(e => e.wasCorrect).length,
            correctedExamples: this.examples.filter(e => e.correction).length,
            patterns: this.patterns.length,
            toolBreakdown,
        }
    }

    /**
     * Export learned knowledge (for backup/sharing)
     */
    exportLearning(): { examples: ToolUsageExample[]; patterns: ToolPattern[] } {
        return {
            examples: this.examples,
            patterns: this.patterns,
        }
    }
}

// ============================================
// Singleton
// ============================================

let instance: ToolUsageLearner | null = null

export function getToolUsageLearner(): ToolUsageLearner {
    if (!instance) {
        instance = new ToolUsageLearner()
    }
    return instance
}

// ============================================
// Helper: Auto-record from tool execution
// ============================================

export async function recordToolExecution(
    toolName: string,
    userRequest: string,
    params: Record<string, unknown>,
    result: unknown,
    verifiedSuccess?: boolean,
): Promise<void> {
    const learner = getToolUsageLearner()

    // Determine if execution was successful
    const wasError = verifiedSuccess === undefined
        ? Boolean(result && typeof result === 'object' && 'error' in result)
        : !verifiedSuccess

    learner.recordUsage(toolName, userRequest, params, !wasError)
}

export default {
    ToolUsageLearner,
    getToolUsageLearner,
    recordToolExecution,
}
