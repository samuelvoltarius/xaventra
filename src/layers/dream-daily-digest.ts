// Dream Daily Digest — consolidates all dream results into 1 daily summary
// Instead of reporting each dream individually, collects throughout the day
// and sends ONE comprehensive Telegram message at the end

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isInternalOutboundArtifact, sanitizeInternalOutboundArtifacts } from '../core/outbound-content-guard.js'

const DATA_DIR = join(process.cwd(), '.nova-data', 'reflector')

interface DigestEntry {
    timestamp: string
    insights: string[]
    suggestions: string[]
    contradictions: string[]
    durationMs: number
    redTeamScore: number
}

interface DailyDigest {
    date: string  // YYYY-MM-DD
    entries: DigestEntry[]
    sent: boolean
}

let currentDigest: DailyDigest | null = null

// Add a dream result to today's digest
export function addToDailyDigest(result: {
    insights: string[]
    suggestions: string[]
    contradictions: string[]
    durationMs: number
}): void {
    const today = new Date().toISOString().slice(0, 10)

    if (!currentDigest || currentDigest.date !== today) {
        currentDigest = { date: today, entries: [], sent: false }
        loadDigest()
    }

    // Extract Red-Team score from insights
    let rtScore = -1
    for (const i of result.insights) {
        const match = i.match(/Score:\s*(\d+)\/100/)
        if (match) rtScore = parseInt(match[1])
    }

    currentDigest.entries.push({
        timestamp: new Date().toISOString(),
        insights: result.insights,
        suggestions: result.suggestions,
        contradictions: result.contradictions,
        durationMs: result.durationMs,
        redTeamScore: rtScore,
    })

    saveDigest()
}

// Build the daily summary message
export function buildDailyDigest(): string | null {
    if (!currentDigest || currentDigest.entries.length === 0) return null

    const totalDreams = currentDigest.entries.length
    const totalDuration = currentDigest.entries.reduce((s, e) => s + e.durationMs, 0)

    // Aggregate insights (deduplicate)
    const allInsights = new Set<string>()
    const allSuggestions = new Set<string>()
    const allContradictions = new Set<string>()

    for (const entry of currentDigest.entries) {
        entry.insights.forEach(i => {
            const clean = sanitizeInternalOutboundArtifacts(i)
            if (clean && !isInternalOutboundArtifact(i)) allInsights.add(clean)
        })
        entry.suggestions.forEach(s => {
            const clean = sanitizeInternalOutboundArtifacts(s)
            if (clean && !isInternalOutboundArtifact(s)) allSuggestions.add(clean)
        })
        entry.contradictions.forEach(c => {
            const clean = sanitizeInternalOutboundArtifacts(c)
            if (clean && !isInternalOutboundArtifact(c)) allContradictions.add(clean)
        })
    }

    // Filter out "all clear" noise
    const criticalInsights = [...allInsights].filter(i =>
        !i.includes('alle clean') && !i.includes('Alle Angriffsvektoren blockiert')
    )

    // If nothing interesting happened, don't report
    if (criticalInsights.length === 0 && allSuggestions.size === 0 && allContradictions.size === 0) {
        return null
    }

    // Best/worst Red-Team score
    const rtScores = currentDigest.entries.map(e => e.redTeamScore).filter(s => s >= 0)
    const bestRT = rtScores.length > 0 ? Math.max(...rtScores) : -1
    const worstRT = rtScores.length > 0 ? Math.min(...rtScores) : -1

    const lines = [
        `*Nova Tagesbericht* (${currentDigest.date})`,
        `${totalDreams} Traumzyklen, ${totalDuration}ms Gesamtdauer`,
        '',
    ]

    if (criticalInsights.length > 0) {
        lines.push('*Erkenntnisse:*')
        for (const i of criticalInsights.slice(0, 8)) {
            lines.push(`  - ${i}`)
        }
    }

    if (allSuggestions.size > 0) {
        lines.push('', '*Vorschlaege:*')
        for (const s of [...allSuggestions].slice(0, 5)) {
            lines.push(`  - ${s}`)
        }
    }

    if (allContradictions.size > 0) {
        lines.push('', '*Widersprueche:*')
        for (const c of [...allContradictions].slice(0, 3)) {
            lines.push(`  - ${c}`)
        }
    }

    if (bestRT >= 0) {
        lines.push('', `Red-Team: Best ${bestRT}/100, Worst ${worstRT}/100`)
    }

    return lines.join('\n')
}

// Mark digest as sent
export function markDigestSent(): void {
    if (currentDigest) {
        currentDigest.sent = true
        saveDigest()
    }
}

export function isDigestSent(): boolean {
    return currentDigest?.sent ?? false
}

function saveDigest(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'daily-digest.json'), JSON.stringify(currentDigest, null, 2))
    } catch { /* non-critical */ }
}

function loadDigest(): void {
    try {
        const path = join(DATA_DIR, 'daily-digest.json')
        if (existsSync(path)) {
            const data = JSON.parse(readFileSync(path, 'utf-8'))
            const today = new Date().toISOString().slice(0, 10)
            if (data.date === today) {
                currentDigest = data
            }
        }
    } catch { /* start fresh */ }
}
