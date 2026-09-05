/**
 * Nova - Teaching Interface
 * 
 * Allows users to explicitly teach Nova new skills, facts, and behaviors.
 * 
 * Usage:
 * - "Lerne: X bedeutet Y"
 * - "Merke dir: Wenn X, dann Y"
 * - "Vergiss: X"
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Teaching {
    id: string
    type: 'fact' | 'skill' | 'rule' | 'preference' | 'correction'
    content: string
    context?: string
    createdAt: number
    source: 'user' | 'self-learned'
    confidence: number
    usageCount: number
    lastUsed?: number
}

export interface TeachingConfig {
    storageDir: string
    autoSave: boolean
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: TeachingConfig = {
    storageDir: '.nova-teachings',
    autoSave: true,
}

// ============================================
// Teaching Manager
// ============================================

export class TeachingManager {
    private config: TeachingConfig
    private teachings: Map<string, Teaching> = new Map()

    constructor(config: Partial<TeachingConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.load()
    }

    // ============================================
    // Teaching Methods
    // ============================================

    /**
     * Teach Nova a new fact.
     * "Lerne: Die Hauptstadt von Österreich ist Wien"
     */
    teachFact(content: string, context?: string): Teaching {
        return this.add({
            type: 'fact',
            content,
            context,
            source: 'user',
        })
    }

    /**
     * Teach Nova a skill/how-to.
     * "Lerne wie man: Docker Container startet"
     */
    teachSkill(content: string, context?: string): Teaching {
        return this.add({
            type: 'skill',
            content,
            context,
            source: 'user',
        })
    }

    /**
     * Teach Nova a rule/behavior.
     * "Merke dir: Antworte immer auf Deutsch"
     */
    teachRule(content: string, context?: string): Teaching {
        return this.add({
            type: 'rule',
            content,
            context,
            source: 'user',
        })
    }

    /**
     * Teach Nova a preference.
     * "Ich bevorzuge: Kurze Antworten"
     */
    teachPreference(content: string, context?: string): Teaching {
        return this.add({
            type: 'preference',
            content,
            context,
            source: 'user',
        })
    }

    /**
     * Correct Nova's behavior.
     * "Das war falsch. Richtig ist: X"
     */
    teachCorrection(content: string, context?: string): Teaching {
        return this.add({
            type: 'correction',
            content,
            context,
            source: 'user',
        })
    }

    // ============================================
    // Internal Methods
    // ============================================

    private add(params: {
        type: Teaching['type']
        content: string
        context?: string
        source: Teaching['source']
    }): Teaching {
        const id = `teach_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        const teaching: Teaching = {
            id,
            type: params.type,
            content: params.content,
            context: params.context,
            createdAt: Date.now(),
            source: params.source,
            confidence: 1.0,
            usageCount: 0,
        }

        this.teachings.set(id, teaching)
        console.log(`[Teaching] Learned ${params.type}: ${params.content.slice(0, 50)}...`)

        if (this.config.autoSave) {
            this.save()
        }

        return teaching
    }

    // ============================================
    // Retrieval
    // ============================================

    /**
     * Find relevant teachings for a query.
     */
    findRelevant(query: string): Teaching[] {
        const queryLower = query.toLowerCase()
        const results: Teaching[] = []

        for (const teaching of this.teachings.values()) {
            const contentLower = teaching.content.toLowerCase()
            const contextLower = (teaching.context || '').toLowerCase()

            if (contentLower.includes(queryLower) ||
                queryLower.includes(contentLower.slice(0, 20)) ||
                contextLower.includes(queryLower)) {
                results.push(teaching)
            }
        }

        // Sort by confidence and usage
        return results.sort((a, b) => {
            const scoreA = a.confidence * (1 + a.usageCount * 0.1)
            const scoreB = b.confidence * (1 + b.usageCount * 0.1)
            return scoreB - scoreA
        })
    }

    /**
     * Get all teachings of a type.
     */
    getByType(type: Teaching['type']): Teaching[] {
        return Array.from(this.teachings.values())
            .filter(t => t.type === type)
    }

    /**
     * Get all teachings.
     */
    getAll(): Teaching[] {
        return Array.from(this.teachings.values())
    }

    /**
     * Mark a teaching as used (increases confidence).
     */
    markUsed(id: string): void {
        const teaching = this.teachings.get(id)
        if (teaching) {
            teaching.usageCount++
            teaching.lastUsed = Date.now()
            if (this.config.autoSave) this.save()
        }
    }

    // ============================================
    // Forgetting
    // ============================================

    /**
     * Forget a specific teaching.
     */
    forget(id: string): boolean {
        const deleted = this.teachings.delete(id)
        if (deleted && this.config.autoSave) {
            this.save()
        }
        return deleted
    }

    /**
     * Forget teachings matching a query.
     */
    forgetMatching(query: string): number {
        const toForget = this.findRelevant(query)
        for (const t of toForget) {
            this.teachings.delete(t.id)
        }
        if (toForget.length > 0 && this.config.autoSave) {
            this.save()
        }
        return toForget.length
    }

    // ============================================
    // Parse Natural Language
    // ============================================

    /**
     * Parse a natural language teaching command.
     */
    parseAndTeach(input: string): Teaching | null {

        // Patterns for teaching
        const patterns: Array<{
            regex: RegExp
            type: Teaching['type']
        }> = [
                { regex: /^lerne:?\s*(.+)/i, type: 'fact' },
                { regex: /^merke dir:?\s*(.+)/i, type: 'rule' },
                { regex: /^merke:?\s*(.+)/i, type: 'rule' },
                { regex: /^lerne wie man:?\s*(.+)/i, type: 'skill' },
                { regex: /^ich bevorzuge:?\s*(.+)/i, type: 'preference' },
                { regex: /^ich mag:?\s*(.+)/i, type: 'preference' },
                { regex: /^richtig ist:?\s*(.+)/i, type: 'correction' },
                { regex: /^das stimmt nicht[.,]?\s*(.+)/i, type: 'correction' },
                { regex: /^vergiss nicht:?\s*(.+)/i, type: 'fact' },
                { regex: /^remember:?\s*(.+)/i, type: 'fact' },
                { regex: /^learn:?\s*(.+)/i, type: 'fact' },
            ]

        for (const { regex, type } of patterns) {
            const match = input.match(regex)
            if (match && match[1]) {
                return this.add({
                    type,
                    content: match[1].trim(),
                    source: 'user',
                })
            }
        }

        // Check for forget commands
        const forgetPatterns = [
            /^vergiss:?\s*(.+)/i,
            /^forget:?\s*(.+)/i,
            /^lösche:?\s*(.+)/i,
        ]

        for (const regex of forgetPatterns) {
            const match = input.match(regex)
            if (match && match[1]) {
                const count = this.forgetMatching(match[1].trim())
                console.log(`[Teaching] Forgot ${count} teachings matching: ${match[1]}`)
                return null
            }
        }

        return null
    }

    // ============================================
    // Build Context
    // ============================================

    /**
     * Build a context string from relevant teachings for the LLM.
     */
    buildContext(query: string): string {
        const relevant = this.findRelevant(query)
        if (relevant.length === 0) return ''

        const sections: Record<string, string[]> = {
            fact: [],
            rule: [],
            preference: [],
            skill: [],
            correction: [],
        }

        for (const t of relevant.slice(0, 10)) {
            sections[t.type].push(`- ${t.content}`)
        }

        const parts: string[] = []

        if (sections.rule.length > 0) {
            parts.push(`**Regeln:**\n${sections.rule.join('\n')}`)
        }
        if (sections.preference.length > 0) {
            parts.push(`**Präferenzen:**\n${sections.preference.join('\n')}`)
        }
        if (sections.fact.length > 0) {
            parts.push(`**Fakten:**\n${sections.fact.join('\n')}`)
        }
        if (sections.correction.length > 0) {
            parts.push(`**Korrekturen:**\n${sections.correction.join('\n')}`)
        }

        return parts.join('\n\n')
    }

    // ============================================
    // Persistence
    // ============================================

    private save(): void {
        try {
            if (!existsSync(this.config.storageDir)) {
                mkdirSync(this.config.storageDir, { recursive: true })
            }

            const path = join(this.config.storageDir, 'teachings.json')
            const data = Array.from(this.teachings.values())
            writeFileSync(path, JSON.stringify(data, null, 2))
        } catch (err) {
            console.error('[Teaching] Save failed:', err)
        }
    }

    private load(): void {
        try {
            const path = join(this.config.storageDir, 'teachings.json')
            if (existsSync(path)) {
                const data = JSON.parse(readFileSync(path, 'utf-8')) as Teaching[]
                for (const t of data) {
                    this.teachings.set(t.id, t)
                }
                console.log(`[Teaching] Loaded ${this.teachings.size} teachings`)
            }
        } catch (err) {
            console.error('[Teaching] Load failed:', err)
        }
    }

    // ============================================
    // Stats
    // ============================================

    getStats(): {
        total: number
        byType: Record<string, number>
        bySource: Record<string, number>
        mostUsed: Teaching[]
    } {
        const byType: Record<string, number> = {}
        const bySource: Record<string, number> = {}

        for (const t of this.teachings.values()) {
            byType[t.type] = (byType[t.type] || 0) + 1
            bySource[t.source] = (bySource[t.source] || 0) + 1
        }

        const mostUsed = Array.from(this.teachings.values())
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, 5)

        return {
            total: this.teachings.size,
            byType,
            bySource,
            mostUsed,
        }
    }
}

// ============================================
// Global Instance
// ============================================

let teachingInstance: TeachingManager | null = null

export function getTeachingManager(): TeachingManager {
    if (!teachingInstance) {
        teachingInstance = new TeachingManager()
    }
    return teachingInstance
}

export function createTeachingManager(config?: Partial<TeachingConfig>): TeachingManager {
    return new TeachingManager(config)
}

export default { TeachingManager, getTeachingManager, createTeachingManager }
