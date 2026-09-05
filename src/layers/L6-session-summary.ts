/**
 * L6 Session Summary — Tier 2 Memory
 * 
 * Compresses older conversation messages into a summary block
 * using the internal Ollama LLM. The summary is stored per user
 * and injected at the start of each LLM request.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pruneToolMessages } from '../memory/tool-result-pruner.js'
import { redactSecrets } from '../security/secret-redaction.js'

// ============================================
// Types
// ============================================

// Track sessions that need flushing before shutdown
const pendingSessions: Map<string, {
    userId: string
    channel: string
    history: Array<{ role: string; content: string }>
    messagesSinceLastSummary: number
}> = new Map()
const sessionGenerations = new Map<string, number>()

export function clearSessionSummary(userId: string): void {
    sessionGenerations.set(userId, (sessionGenerations.get(userId) || 0) + 1)
    for (const [key, value] of pendingSessions) if (value.userId === userId) pendingSessions.delete(key)
    rmSync(getSummaryPath(userId), { force: true })
}

const AUTO_SUMMARY_THRESHOLD = 10  // Summarize every 10 new messages

interface SessionSummary {
    userId: string
    channel: string
    summary: string
    messagesCompressed: number
    lastUpdated: string
    /** Stable marker of the newest raw message already folded into summary. */
    lastCompressedKey?: string
}

type SummaryMessage = { role: string; content: string; timestamp?: number }

function messageKey(message: SummaryMessage): string {
    return createHash('sha256')
        .update(`${message.role}\0${message.timestamp ?? ''}\0${message.content}`)
        .digest('hex')
        .slice(0, 20)
}

interface SummaryStore {
    [key: string]: SessionSummary
}

// ============================================
// Storage
// ============================================

const SUMMARY_DIR = join(process.cwd(), '.nova-data', 'summaries')

function ensureDir(): void {
    if (!existsSync(SUMMARY_DIR)) {
        mkdirSync(SUMMARY_DIR, { recursive: true })
    }
}

function getSummaryPath(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(SUMMARY_DIR, `${safe}.json`)
}

export function loadSummary(userId: string): SessionSummary | null {
    try {
        const path = getSummaryPath(userId)
        if (existsSync(path)) {
            return JSON.parse(readFileSync(path, 'utf-8'))
        }
    } catch { /* non-critical */ }
    return null
}

export function saveSummary(summary: SessionSummary): void {
    try {
        ensureDir()
        const path = getSummaryPath(summary.userId)
        writeFileSync(path, JSON.stringify(summary, null, 2))
        console.log(`[L6 Summary] Saved summary for ${summary.userId} (${summary.messagesCompressed} msgs compressed)`)
    } catch (err) {
        console.log(`[L6 Summary] Save error: ${err}`)
    }
}

// ============================================
// Token Estimation
// ============================================

/** Rough token count: ~4 chars per token (works for most languages) */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 10, 0) // +10 for role/formatting overhead
}

// ============================================
// Summary Generation
// ============================================

/**
 * Compress messages into a summary using internal LLM.
 * Falls back to extractive summary if LLM unavailable.
 */
export async function summarizeMessages(
    messages: Array<{ role: string; content: string }>,
    existingSummary?: string
): Promise<string> {
    const safeMessages = pruneToolMessages(messages).map(message => ({ ...message, content: redactSecrets(message.content) }))
    const conversation = safeMessages
        .map(m => `${m.role === 'user' ? 'User' : 'Nova'}: ${m.content.slice(0, 500)}`)
        .join('\n')

    const prompt = existingSummary
        ? `Hier ist eine bestehende Zusammenfassung eines Gesprächs:\n<existing_summary>\n${existingSummary}\n</existing_summary>\n\nHier sind neue Nachrichten:\n<messages>\n${conversation}\n</messages>\n\nAktualisiere die Zusammenfassung. Behalte ALLE wichtigen Fakten (Namen, IPs, Geräte, Entscheidungen, Befehle). Maximal 500 Wörter. Antworte NUR mit der aktualisierten Zusammenfassung.`
        : `Fasse dieses Gespräch zusammen. Behalte wichtige Fakten: Namen, IP-Adressen, Geräte, Entscheidungen, Befehle, Fehler und deren Lösungen. Speichere niemals Passwörter, Tokens oder andere Secrets. Maximal 500 Wörter.\n\n<messages>\n${conversation}\n</messages>\n\nAntworte NUR mit der Zusammenfassung.`

    // Try internal LLM first (cheapest — auto-resolved via model-resolver)
    try {
        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')

        const internalLLM = await createNovaLLMClient({})

        const response = await internalLLM.complete([
            { role: 'system', content: 'Du bist ein Zusammenfassungs-Assistent. Fasse Gespräche präzise zusammen. Behalte alle technischen Details, IPs, Namen, Geräte und Entscheidungen.' },
            { role: 'user', content: prompt },
        ], undefined, {
            maxTokens: 512,
            timeoutMs: 8_000,
            maxAttempts: 1,
        })

        if (response.content && response.content.trim().length > 20) {
            console.log(`[L6 Summary] LLM summary generated: ${response.content.length} chars`)
            return response.content.trim()
        }
    } catch (err) {
        console.log(`[L6 Summary] LLM summary failed, using extractive: ${err}`)
    }

    // Fallback: extractive summary (just keep key facts)
    return extractiveSummary(safeMessages, existingSummary)
}

/**
 * Simple extractive summary — no LLM needed.
 * Keeps sentences that contain key patterns (IPs, names, decisions).
 */
function extractiveSummary(
    messages: Array<{ role: string; content: string }>,
    existingSummary?: string
): string {
    const keyPatterns = [
        /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,  // IP addresses
        /(?:ssh|scp|rsync)\s/i,                  // SSH commands
        /(?:pi|raspberry|beamer|tv|projector)/i, // Devices
        /(?:heißt|name ist|ich bin)/i,           // Identity
        /(?:fehler|error|fix|lösung)/i,          // Problems/solutions
        /(?:install|apt|npm|pip)/i,              // Installations
        /(?:wichtig|merke|vergiss nicht)/i,       // Important notes
    ]

    const keyFacts: string[] = []
    for (const msg of messages) {
        const lines = msg.content.split(/[.\n]/).filter(l => l.trim().length > 10)
        for (const line of lines) {
            if (keyPatterns.some(p => p.test(line))) {
                const prefix = msg.role === 'user' ? 'User' : 'Nova'
                keyFacts.push(`${prefix}: ${line.trim().slice(0, 200)}`)
            }
        }
    }

    const newFacts = keyFacts.slice(0, 30).join('\n')
    if (existingSummary) {
        return `${existingSummary}\n\n--- Neuere Fakten ---\n${newFacts}`
    }
    return `Gesprächszusammenfassung:\n${newFacts}`
}

/**
 * Builds the memory view used by the foreground response path. This is pure,
 * bounded and never calls a model or writes the durable summary store.
 */
export function buildForegroundSummary(
    messages: Array<{ role: string; content: string }>,
    existingSummary?: string,
): string | null {
    if (messages.length === 0) return existingSummary || null
    return extractiveSummary(messages, existingSummary)
}

// ============================================
// Session Summary Manager
// ============================================

/**
 * Process session history: split into summary + hot context based on token budget.
 * Returns the messages to send to the LLM (summary block + recent messages).
 */
export async function processSessionForLLM(
    userId: string,
    channel: string,
    history: SummaryMessage[],
    tokenBudget: number = 12000,
    allowRefresh: boolean = true,
): Promise<{
    summaryMessage: { role: 'system'; content: string } | null
    hotMessages: Array<{ role: string; content: string }>
    summarized: boolean
}> {
    const generation = sessionGenerations.get(userId) || 0
    // Load existing summary
    const existing = loadSummary(userId)
    const existingSummaryText = existing?.summary || null

    // Calculate token budget for hot context (leave room for summary + system prompt)
    const summaryReserve = existingSummaryText ? estimateTokens(existingSummaryText) + 200 : 0
    const hotBudget = tokenBudget - summaryReserve

    // Walk backwards through history to fill hot context.
    // HARD CAP on message count: even with a big token budget, keeping 60+ old
    // messages in context distracts the model — it mixes up old answers with the
    // current question ("disk space" → returns old folder listing). A focused
    // window of recent messages keeps the model on the CURRENT task.
    // Older messages are compressed into the summary below.
    const MAX_HOT_MESSAGES = 14  // ~7 exchanges — enough memory, sharp focus
    const prunedHistory = pruneToolMessages(history)
    const hotMessages: Array<{ role: string; content: string }> = []
    let hotTokens = 0
    let splitIndex = history.length

    for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(prunedHistory[i].content) + 10
        if (hotTokens + msgTokens > hotBudget || hotMessages.length >= MAX_HOT_MESSAGES) {
            splitIndex = i + 1
            break
        }
        hotTokens += msgTokens
        hotMessages.unshift(prunedHistory[i])
        if (i === 0) splitIndex = 0
    }

    // If there are messages outside the hot window, summarize them
    const coldMessages = history.slice(0, splitIndex)
    let summaryMessage: { role: 'system'; content: string } | null = null
    let summarized = false

    if (coldMessages.length > 5) {
        // We have messages to summarize
        try {
            let unsummarized = coldMessages
            if (existing?.lastCompressedKey) {
                const markerIndex = coldMessages.findIndex(message => messageKey(message) === existing.lastCompressedKey)
                if (markerIndex >= 0) unsummarized = coldMessages.slice(markerIndex + 1)
            }

            // Foreground chat must never wait for a summary model. Reuse the
            // durable summary and append a bounded extractive view of newly
            // cold messages. The fire-and-forget tracker refreshes the durable
            // summary separately after the response path has completed.
            if (!allowRefresh) {
                const foregroundSummary = buildForegroundSummary(unsummarized, existingSummaryText || undefined)
                summaryMessage = foregroundSummary ? {
                    role: 'system' as const,
                    content: `<summary>\nZusammenfassung des bisherigen Gesprächs:\n${foregroundSummary}\n</summary>`,
                } : null
                return { summaryMessage, hotMessages, summarized: false }
            }

            // Nothing new crossed from hot context into cold storage. Reuse the
            // existing summary instead of recursively summarizing old messages.
            if (unsummarized.length === 0 && existingSummaryText) {
                summaryMessage = {
                    role: 'system' as const,
                    content: `<summary>\nZusammenfassung des bisherigen Gesprächs:\n${existingSummaryText}\n</summary>`,
                }
                return { summaryMessage, hotMessages, summarized: false }
            }

            // Compact in batches instead of starting a summary LLM call whenever
            // a single message crosses the hot-window boundary.
            if (existingSummaryText && unsummarized.length < 6) {
                summaryMessage = {
                    role: 'system' as const,
                    content: `<summary>\nZusammenfassung des bisherigen Gesprächs:\n${existingSummaryText}\n</summary>`,
                }
                return { summaryMessage, hotMessages, summarized: false }
            }

            const newSummary = await summarizeMessages(unsummarized, existingSummaryText || undefined)
            if ((sessionGenerations.get(userId) || 0) !== generation) {
                return { summaryMessage: null, hotMessages: [], summarized: false }
            }

            // Save the summary
            saveSummary({
                userId,
                channel,
                summary: newSummary,
                messagesCompressed: unsummarized.length + (existing?.messagesCompressed || 0),
                lastUpdated: new Date().toISOString(),
                lastCompressedKey: messageKey(coldMessages[coldMessages.length - 1]),
            })

            summaryMessage = {
                role: 'system' as const,
                content: `<summary>\nZusammenfassung des bisherigen Gesprächs:\n${newSummary}\n</summary>`,
            }
            summarized = true
        } catch (err) {
            console.log(`[L6 Summary] Summarization failed: ${err}`)
        }
    } else if (existingSummaryText) {
        // No new cold messages, but we have an existing summary
        summaryMessage = {
            role: 'system' as const,
            content: `<summary>\nZusammenfassung des bisherigen Gesprächs:\n${existingSummaryText}\n</summary>`,
        }
    }

    return { summaryMessage, hotMessages, summarized }
}

// ============================================
// Auto-Save & Flush (Shutdown Hook)
// ============================================

/**
 * Track a session for auto-save. Called after each message.
 */
export function trackSession(
    userId: string,
    channel: string,
    history: Array<{ role: string; content: string }>
): void {
    const key = `${channel}:${userId}`
    const existing = pendingSessions.get(key)
    const count = (existing?.messagesSinceLastSummary || 0) + 1
    pendingSessions.set(key, { userId, channel, history, messagesSinceLastSummary: count })

    // Auto-summarize if threshold reached
    if (count >= AUTO_SUMMARY_THRESHOLD) {
        console.log(`[L6 Summary] Auto-save triggered for ${userId} (${count} new messages)`)
        pendingSessions.set(key, { ...pendingSessions.get(key)!, messagesSinceLastSummary: 0 })
        // Fire and forget — don't block the response
        processSessionForLLM(userId, channel, history).catch(err => {
            console.log(`[L6 Summary] Auto-save error: ${err}`)
        })
    }
}

/**
 * Flush all pending sessions — call before shutdown/restart.
 * Summarizes all active sessions synchronously.
 */
export async function flushAllSessions(): Promise<void> {
    const entries = Array.from(pendingSessions.entries())
    if (entries.length === 0) {
        console.log('[L6 Summary] No sessions to flush')
        return
    }

    console.log(`[L6 Summary] Flushing ${entries.length} sessions before shutdown...`)

    for (const [key, session] of entries) {
        if (session.history.length > 5) {
            try {
                await processSessionForLLM(session.userId, session.channel, session.history)
                console.log(`[L6 Summary] ✅ Flushed: ${key}`)
            } catch (err) {
                console.log(`[L6 Summary] ❌ Flush failed for ${key}: ${err}`)
            }
        }
    }

    pendingSessions.clear()
    console.log('[L6 Summary] All sessions flushed')
}
