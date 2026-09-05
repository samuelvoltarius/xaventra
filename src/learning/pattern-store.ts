/**
 * Nova Pattern Store
 * 
 * Detects and stores behavioral patterns for proactive scheduling.
 * After 3 identical patterns → suggest automation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Pattern {
    id: string
    userId: string
    channel: string
    action: string           // Normalized action (e.g., "news", "weather")
    timeHint?: string        // Extracted time (e.g., "09:00")
    count: number
    firstSeen: number
    lastSeen: number
    automated: boolean
    cronExpression?: string  // If automated
}

export interface PatternSuggestion {
    patternId: string
    action: string
    timeHint?: string
    count: number
    message: string
}

// ============================================
// Pattern Store
// ============================================

const PATTERN_FILE = '.nova-data/patterns.json'
const AUTOMATION_THRESHOLD = 3

export class PatternStore {
    private patterns: Map<string, Pattern> = new Map()
    private dataDir: string

    constructor(dataDir: string = process.cwd()) {
        this.dataDir = dataDir
        this.load()
    }

    // ============================================
    // Persistence
    // ============================================

    private getFilePath(): string {
        return join(this.dataDir, PATTERN_FILE)
    }

    private load(): void {
        const filePath = this.getFilePath()
        if (existsSync(filePath)) {
            try {
                const data = JSON.parse(readFileSync(filePath, 'utf-8'))
                // Handle both array format and empty object
                const patterns = Array.isArray(data.patterns) ? data.patterns :
                    Array.isArray(data) ? data : []
                for (const p of patterns) {
                    if (p && p.id) {
                        this.patterns.set(p.id, p)
                    }
                }
                console.log(`[PatternStore] Loaded ${this.patterns.size} patterns`)
            } catch (err) {
                console.log(`[PatternStore] Starting fresh (${err})`)
            }
        }
    }

    private save(): void {
        const dir = join(this.dataDir, '.nova-data')
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        const data = {
            version: 1,
            patterns: Array.from(this.patterns.values()),
        }
        writeFileSync(this.getFilePath(), JSON.stringify(data, null, 2))
    }

    // ============================================
    // Pattern Detection
    // ============================================

    /**
     * Record a user action and detect patterns
     */
    recordAction(
        userId: string,
        channel: string,
        message: string
    ): PatternSuggestion | null {
        const normalized = this.normalizeAction(message)
        if (!normalized) return null

        const { action, timeHint } = normalized
        const patternKey = `${userId}:${channel}:${action}:${timeHint || 'any'}`

        let pattern = this.patterns.get(patternKey)

        if (!pattern) {
            pattern = {
                id: patternKey,
                userId,
                channel,
                action,
                timeHint,
                count: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                automated: false,
            }
        }

        pattern.count++
        pattern.lastSeen = Date.now()
        this.patterns.set(patternKey, pattern)
        this.save()

        console.log(`[PatternStore] Pattern "${action}" count: ${pattern.count}`)

        // Check if we should suggest automation
        if (pattern.count === AUTOMATION_THRESHOLD && !pattern.automated) {
            return {
                patternId: pattern.id,
                action: pattern.action,
                timeHint: pattern.timeHint,
                count: pattern.count,
                message: this.buildSuggestionMessage(pattern),
            }
        }

        return null
    }

    /**
     * Mark a pattern as automated (user confirmed)
     */
    enableAutomation(patternId: string, cronExpression: string): boolean {
        const pattern = this.patterns.get(patternId)
        if (!pattern) return false

        pattern.automated = true
        pattern.cronExpression = cronExpression
        this.patterns.set(patternId, pattern)
        this.save()

        console.log(`[PatternStore] ✅ Automation enabled: ${patternId} → ${cronExpression}`)
        return true
    }

    /**
     * Get all automated patterns (for scheduler)
     */
    getAutomatedPatterns(): Pattern[] {
        return Array.from(this.patterns.values()).filter(p => p.automated && p.cronExpression)
    }

    // ============================================
    // Action Normalization
    // ============================================

    private normalizeAction(message: string): { action: string; timeHint?: string } | null {
        const lower = message.toLowerCase()

        // Extract time hints (e.g., "um 9 Uhr", "at 9am")
        let timeHint: string | undefined
        const timeMatch = lower.match(/um (\d{1,2})(?::(\d{2}))?\s*(?:uhr)?/i) ||
            lower.match(/at (\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?/i)
        if (timeMatch) {
            const hour = parseInt(timeMatch[1], 10)
            const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0
            timeHint = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
        }

        // Detect action types
        if (/nachrichten|news|schlagzeilen/i.test(lower)) {
            return { action: 'news', timeHint }
        }
        if (/wetter|weather|temperatur/i.test(lower)) {
            return { action: 'weather', timeHint }
        }
        if (/erinner|remind/i.test(lower)) {
            return { action: 'reminder', timeHint }
        }
        if (/zusammenfassung|summary|digest/i.test(lower)) {
            return { action: 'summary', timeHint }
        }

        return null  // Not a recognizable pattern
    }

    private buildSuggestionMessage(pattern: Pattern): string {
        const actionNames: Record<string, string> = {
            news: 'Nachrichten abrufen',
            weather: 'Wetter abfragen',
            reminder: 'Erinnerung senden',
            summary: 'Zusammenfassung erstellen',
        }

        const actionName = actionNames[pattern.action] || pattern.action
        const timeStr = pattern.timeHint ? ` um ${pattern.timeHint} Uhr` : ''

        return `🔄 Ich habe bemerkt, dass du "${actionName}"${timeStr} schon ${pattern.count}x angefragt hast. Soll ich das automatisieren? Antworte mit "Ja, automatisiere das!" um einen täglichen Job zu erstellen.`
    }
}

// ============================================
// Singleton
// ============================================

let instance: PatternStore | null = null

export function getPatternStore(): PatternStore {
    if (!instance) {
        instance = new PatternStore()
    }
    return instance
}

export default { PatternStore, getPatternStore }
