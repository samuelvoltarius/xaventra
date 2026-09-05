/**
 * Nova Journaling — Episodic Memory System
 *
 * Nova keeps a daily journal:
 * - What happened today?
 * - What was learned?
 * - What topics were discussed?
 * - Summary generated via internalLlm
 *
 * Persisted to .nova-data/journal/YYYY-MM-DD.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface JournalEvent {
    time: string          // HH:MM
    type: 'chat' | 'tool' | 'learning' | 'error' | 'milestone' | 'system'
    summary: string
    details?: string
    userId?: string
    channel?: string
}

export interface JournalEntry {
    date: string          // YYYY-MM-DD
    events: JournalEvent[]
    topics: string[]
    usersActive: string[]
    toolsUsed: string[]
    errorsEncountered: number
    dailySummary?: string  // Generated via internalLlm
    createdAt: number
    updatedAt: number
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const JOURNAL_DIR = join(DATA_DIR, 'journal')
const JOURNAL_MD_DIR = join(DATA_DIR, 'memories', 'journal')

let currentEntry: JournalEntry | null = null
let internalLlm: any = null

function ensureJournalDir(): void {
    if (!existsSync(JOURNAL_DIR)) {
        mkdirSync(JOURNAL_DIR, { recursive: true })
    }
    if (!existsSync(JOURNAL_MD_DIR)) {
        mkdirSync(JOURNAL_MD_DIR, { recursive: true })
    }
}

function getDateString(): string {
    return new Date().toISOString().split('T')[0]
}

function getTimeString(): string {
    return new Date().toTimeString().slice(0, 5)
}

function getJournalPath(date: string): string {
    return join(JOURNAL_DIR, `${date}.json`)
}

// ============================================
// Core Operations
// ============================================

export function getTodayEntry(): JournalEntry {
    const today = getDateString()

    if (currentEntry && currentEntry.date === today) {
        return currentEntry
    }

    const path = getJournalPath(today)
    if (existsSync(path)) {
        try {
            currentEntry = JSON.parse(readFileSync(path, 'utf-8'))
            return currentEntry!
        } catch { /* create new */ }
    }

    currentEntry = {
        date: today,
        events: [],
        topics: [],
        usersActive: [],
        toolsUsed: [],
        errorsEncountered: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    }

    return currentEntry
}

function saveEntry(): void {
    if (!currentEntry) return
    ensureJournalDir()
    currentEntry.updatedAt = Date.now()
    writeFileSync(getJournalPath(currentEntry.date), JSON.stringify(currentEntry, null, 2))

    // Also write markdown version for episodic memory
    saveMarkdownJournal(currentEntry)
}

/**
 * Write journal entry as a readable markdown file
 * Path: /memories/journal/YYYY-MM-DD.md
 */
function saveMarkdownJournal(entry: JournalEntry): void {
    try {
        const mdPath = join(JOURNAL_MD_DIR, `${entry.date}.md`)
        const lines: string[] = [
            `# Nova Tagebuch — ${entry.date}`,
            '',
            `> Aktive User: ${entry.usersActive.join(', ') || 'keine'}`,
            `> Topics: ${entry.topics.join(', ') || 'keine'}`,
            `> Tools: ${entry.toolsUsed.join(', ') || 'keine'}`,
            `> Fehler: ${entry.errorsEncountered}`,
            '',
        ]

        if (entry.dailySummary) {
            lines.push('## Zusammenfassung', '', entry.dailySummary, '')
        }

        lines.push('## Ereignisse', '')
        for (const event of entry.events) {
            const icon = event.type === 'error' ? '❌' : event.type === 'milestone' ? '🏆' : event.type === 'learning' ? '🎓' : event.type === 'tool' ? '🔧' : '💬'
            lines.push(`- **${event.time}** ${icon} ${event.summary}`)
            if (event.details) {
                lines.push(`  > ${event.details.slice(0, 200)}`)
            }
        }

        writeFileSync(mdPath, lines.join('\n'))
    } catch { /* non-critical */ }
}

// ============================================
// Event Recording
// ============================================

export function recordEvent(
    type: JournalEvent['type'],
    summary: string,
    details?: string,
    userId?: string,
    channel?: string
): void {
    const entry = getTodayEntry()

    entry.events.push({
        time: getTimeString(),
        type,
        summary,
        details: details?.slice(0, 500),
        userId,
        channel,
    })

    // Track unique users
    if (userId && !entry.usersActive.includes(userId)) {
        entry.usersActive.push(userId)
    }

    if (type === 'error') {
        entry.errorsEncountered++
    }

    saveEntry()
}

export function recordChat(userId: string, userMessage: string, novaResponse: string, channel: string): void {
    recordEvent('chat', `Chat mit ${userId}`, `User: ${userMessage.slice(0, 100)}`, userId, channel)

    // Extract topics from the conversation
    extractTopics(userMessage + ' ' + novaResponse)
}

export function recordToolUse(toolName: string, success: boolean, userId?: string): void {
    const entry = getTodayEntry()
    if (!entry.toolsUsed.includes(toolName)) {
        entry.toolsUsed.push(toolName)
    }
    recordEvent('tool', `${toolName}: ${success ? '✅' : '❌'}`, undefined, userId)
}

export function recordLearning(topic: string, details?: string): void {
    recordEvent('learning', `Gelernt: ${topic}`, details)
}

export function recordMilestone(description: string): void {
    recordEvent('milestone', description)
}

export function recordError(error: string, context?: string): void {
    recordEvent('error', error, context)
}

// ============================================
// Topic Extraction
// ============================================

function extractTopics(text: string): void {
    const entry = getTodayEntry()
    const textLower = text.toLowerCase()

    // Simple keyword-based topic detection
    const topicPatterns: Array<{ pattern: RegExp; topic: string }> = [
        { pattern: /code|programm|typescript|javascript/i, topic: 'Coding' },
        { pattern: /deploy|server|docker|container/i, topic: 'Deployment' },
        { pattern: /debug|fehler|error|bug|fix/i, topic: 'Debugging' },
        { pattern: /design|ui|ux|frontend|css/i, topic: 'Design' },
        { pattern: /datenbank|database|prisma|sql/i, topic: 'Database' },
        { pattern: /test|vitest|jest|playwright/i, topic: 'Testing' },
        { pattern: /memory|gedächtnis|lernen|learn/i, topic: 'Memory & Learning' },
        { pattern: /api|endpoint|rest|graphql/i, topic: 'API Development' },
        { pattern: /security|auth|login|password/i, topic: 'Security' },
        { pattern: /nova|daemon|layer|autonomy/i, topic: 'Nova Development' },
        { pattern: /config|setting|einstellung/i, topic: 'Configuration' },
        { pattern: /hund|dog|pet|tier/i, topic: 'Personal (Pets)' },
        { pattern: /foto|photo|bild|image/i, topic: 'Photography' },
    ]

    for (const { pattern, topic } of topicPatterns) {
        if (pattern.test(textLower) && !entry.topics.includes(topic)) {
            entry.topics.push(topic)
        }
    }

    saveEntry()
}

// ============================================
// Daily Summary Generation
// ============================================

export function setInternalLLM(llm: any): void {
    internalLlm = llm
}

export async function generateDailySummary(): Promise<string | null> {
    const entry = getTodayEntry()

    if (entry.events.length === 0) return null

    // Build summary from events
    const eventSummary = entry.events
        .slice(-20) // Last 20 events
        .map(e => `${e.time} [${e.type}] ${e.summary}`)
        .join('\n')

    if (internalLlm) {
        try {
            const prompt = `Du bist Nova, eine KI-Assistentin. Fasse den heutigen Tag zusammen (2-3 Sätze, Deutsch):

Datum: ${entry.date}
Aktive User: ${entry.usersActive.join(', ') || 'keine'}
Topics: ${entry.topics.join(', ') || 'keine'}
Tools genutzt: ${entry.toolsUsed.join(', ') || 'keine'}
Fehler: ${entry.errorsEncountered}

Events:
${eventSummary}

Zusammenfassung (kurz, persönlich, aus Novas Sicht):`

            const result = await internalLlm.complete(prompt)
            const summary = typeof result === 'string' ? result : result?.text || result?.content || ''

            if (summary) {
                entry.dailySummary = summary.trim()
                saveEntry()
                return entry.dailySummary
            }
        } catch {
            // Fallback to template
        }
    }

    // Template fallback
    const summary = `Heute (${entry.date}): ${entry.events.length} Events, ${entry.usersActive.length} User aktiv. Topics: ${entry.topics.join(', ') || 'keine'}. ${entry.errorsEncountered} Fehler.`
    entry.dailySummary = summary
    saveEntry()
    return summary
}

// ============================================
// History Query
// ============================================

export function getRecentEntries(days: number = 7): JournalEntry[] {
    ensureJournalDir()
    const files = readdirSync(JOURNAL_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, days)

    return files.map(f => {
        try {
            return JSON.parse(readFileSync(join(JOURNAL_DIR, f), 'utf-8')) as JournalEntry
        } catch {
            return null
        }
    }).filter(Boolean) as JournalEntry[]
}

export function getJournalContextForPrompt(query: string): string {
    const recent = getRecentEntries(3)
    if (recent.length === 0) return ''

    const summaries = recent.map(e =>
        `📅 ${e.date}: ${e.dailySummary || `${e.events.length} Events, Topics: ${e.topics.join(', ')}`}`
    )

    return `\n[Journal — Letzte Tage]\n${summaries.join('\n')}`
}

// ============================================
// Stats
// ============================================

export function getStats(): {
    todayEvents: number
    todayTopics: string[]
    totalDays: number
    todayUsers: string[]
} {
    ensureJournalDir()
    const entry = getTodayEntry()
    const totalDays = readdirSync(JOURNAL_DIR).filter(f => f.endsWith('.json')).length

    return {
        todayEvents: entry.events.length,
        todayTopics: entry.topics,
        totalDays,
        todayUsers: entry.usersActive,
    }
}

// ============================================
// Init
// ============================================

export function initJournal(): void {
    ensureJournalDir()
    getTodayEntry()
    console.log(`[Journal] 📔 Tagebuch bereit (${getDateString()})`)
}

export default {
    initJournal,
    recordEvent,
    recordChat,
    recordToolUse,
    recordLearning,
    recordMilestone,
    recordError,
    generateDailySummary,
    getRecentEntries,
    getJournalContextForPrompt,
    setInternalLLM,
    getStats,
}
