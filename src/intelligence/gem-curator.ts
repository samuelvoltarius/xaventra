/**
 * Gem Curator — True-Recall-inspired Memory Curation
 *
 * Reads the last 24h of conversation sessions, sends them as
 * a holistic context block to the LLM, and extracts "gems":
 * decisions, preferences, facts, insights worth remembering.
 *
 * Gems are stored in ProgressiveMemory (topic-key upserts)
 * and optionally in VectorMemory (LanceDB) for semantic search.
 *
 * Inspired by: github.com/speedyfoxai/openclaw-true-recall
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { memSave, suggestTopicKey, initProgressiveMemory } from './progressive-memory.js'
import type { MemoryType } from './progressive-memory.js'

// ============================================
// Types
// ============================================

export interface Gem {
    gem: string              // The distilled insight
    context: string          // Brief context (what led to this)
    type: MemoryType         // decision, preference, fact, etc.
    importance: number       // 1-10
    categories: string[]     // Tags
    timestamp: string        // ISO 8601 from source session
    sessionFile: string      // Source session filename
    turnRange: string        // e.g. "12-15"
}

interface SessionTurn {
    ts: string
    channel: string
    role: 'user' | 'assistant' | 'system'
    content: string
}

interface CurationResult {
    gemsExtracted: number
    gemsStored: number
    gemsDeduplicated: number
    sessionFiles: number
    turnsProcessed: number
    duration: number
}

// ============================================
// State
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const SESSIONS_DIR = join(DATA_DIR, 'sessions')
const GEMS_DIR = join(DATA_DIR, 'memories', 'gems')
const STATE_PATH = join(DATA_DIR, 'gem-curator-state.json')

let internalLlm: any = null
let lastCurationTime = 0
let totalCurations = 0

// ============================================
// Init
// ============================================

export function initGemCurator(): void {
    if (!existsSync(GEMS_DIR)) mkdirSync(GEMS_DIR, { recursive: true })

    // Load state
    if (existsSync(STATE_PATH)) {
        try {
            const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
            lastCurationTime = state.lastCurationTime || 0
            totalCurations = state.totalCurations || 0
        } catch { /* fresh start */ }
    }

    initProgressiveMemory()
    console.log(`[GemCurator] ✅ Initialized — last curation: ${lastCurationTime ? new Date(lastCurationTime).toISOString() : 'never'}, total: ${totalCurations}`)
}

export function setInternalLLM(llm: any): void {
    internalLlm = llm
}

function saveState(): void {
    try {
        writeFileSync(STATE_PATH, JSON.stringify({
            lastCurationTime,
            totalCurations,
        }, null, 2))
    } catch { /* non-critical */ }
}

// ============================================
// Session Reader
// ============================================

function readRecentSessions(hoursBack: number = 24): { turns: SessionTurn[], files: string[] } {
    if (!existsSync(SESSIONS_DIR)) return { turns: [], files: [] }

    const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000)
    const allTurns: SessionTurn[] = []
    const files: string[] = []

    const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))

    for (const file of sessionFiles) {
        const filePath = join(SESSIONS_DIR, file)
        try {
            const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())
            let hasRecent = false

            for (const line of lines) {
                try {
                    const turn = JSON.parse(line) as SessionTurn
                    const turnTime = new Date(turn.ts).getTime()
                    if (turnTime >= cutoff) {
                        allTurns.push(turn)
                        hasRecent = true
                    }
                } catch { /* skip malformed line */ }
            }

            if (hasRecent) files.push(file)
        } catch { /* skip unreadable file */ }
    }

    // Sort chronologically
    allTurns.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    return { turns: allTurns, files }
}

// ============================================
// LLM Curation Prompt
// ============================================

const CURATOR_SYSTEM_PROMPT = `You are a Memory Curator. Your job is to read 24 hours of conversation and extract "gems" — the most important facts, decisions, preferences, and insights worth remembering long-term.

Rules:
- Extract ONLY truly important information (not small talk)
- Each gem should be self-contained and understandable without context
- Include brief context for each gem
- Assign an importance score (1-10): 10=life-changing, 7=important project decision, 4=useful preference, 1=minor detail
- Classify each gem by type: decision, preference, fact, architecture, learning, observation, pattern, config, goal
- Skip greetings, status checks, and routine exchanges
- If no gems found, return an empty array

Respond ONLY with valid JSON array. No markdown, no explanation.

Example output:
[
  {
    "gem": "User switched the project auth flow to OpenAI Codex credentials",
    "context": "During auth migration, the project standardized on the official Codex login import instead of older provider-specific flows",
    "type": "decision",
    "importance": 8,
    "categories": ["auth", "api", "nova"]
  },
  {
    "gem": "User prefers dark mode in all applications",
    "context": "Mentioned during UI design discussion for dashboard",
    "type": "preference",
    "importance": 4,
    "categories": ["ui", "personal"]
  }
]`

function buildCurationPrompt(turns: SessionTurn[]): string {
    // Limit to ~8000 tokens worth of content (~28k chars)
    const maxChars = 28000
    let totalChars = 0
    const selectedTurns: string[] = []

    for (const turn of turns) {
        const line = `[${turn.ts}] [${turn.channel}] ${turn.role}: ${turn.content}`
        if (totalChars + line.length > maxChars) break
        selectedTurns.push(line)
        totalChars += line.length
    }

    return `Here are the last 24 hours of conversations (${selectedTurns.length} turns):

${selectedTurns.join('\n')}

Extract the gems from these conversations. Return a JSON array.`
}

// ============================================
// Core Curation
// ============================================

export async function curate(hoursBack: number = 24): Promise<CurationResult> {
    const startTime = Date.now()
    const result: CurationResult = {
        gemsExtracted: 0,
        gemsStored: 0,
        gemsDeduplicated: 0,
        sessionFiles: 0,
        turnsProcessed: 0,
        duration: 0,
    }

    if (!internalLlm) {
        console.log('[GemCurator] ⚠️ No LLM available — skipping curation')
        return result
    }

    // 1. Read sessions
    const { turns, files } = readRecentSessions(hoursBack)
    result.sessionFiles = files.length
    result.turnsProcessed = turns.length

    if (turns.length < 4) {
        console.log(`[GemCurator] ℹ️ Only ${turns.length} turns in last ${hoursBack}h — too few to curate`)
        return result
    }

    console.log(`[GemCurator] 🔍 Curating ${turns.length} turns from ${files.length} session(s)...`)

    // 2. Build prompt and call LLM
    const userPrompt = buildCurationPrompt(turns)
    let gems: Gem[] = []

    try {
        const response = await internalLlm.complete(
            CURATOR_SYSTEM_PROMPT + '\n\n' + userPrompt
        )
        const text = typeof response === 'string'
            ? response
            : response?.text || response?.content || ''

        // Extract JSON array from response
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            if (Array.isArray(parsed)) {
                gems = parsed.map((g: any) => ({
                    gem: String(g.gem || ''),
                    context: String(g.context || ''),
                    type: validateType(g.type),
                    importance: Math.min(10, Math.max(1, Number(g.importance) || 5)),
                    categories: Array.isArray(g.categories) ? g.categories.map(String) : [],
                    timestamp: turns[0]?.ts || new Date().toISOString(),
                    sessionFile: files[0] || '',
                    turnRange: '',
                })).filter((g: Gem) => g.gem.length > 10)
            }
        }
    } catch (err) {
        console.log(`[GemCurator] ❌ LLM error: ${err}`)
        return result
    }

    result.gemsExtracted = gems.length
    console.log(`[GemCurator] 💎 Extracted ${gems.length} gems`)

    // 3. Store each gem via ProgressiveMemory (with dedup)
    for (const gem of gems) {
        const topicKey = suggestTopicKey(gem.type, gem.gem)

        const entry = memSave(gem.type, gem.gem, gem.context, {
            topicKey,
            scope: 'global',
            tags: [...gem.categories, 'gem', 'auto-curated'],
            importance: gem.importance,
        })

        if (entry.revisionCount > 1) {
            result.gemsDeduplicated++
        } else {
            result.gemsStored++
        }
    }

    // 4. Persist gems to JSON backup
    saveGemsToFile(gems)

    // 5. Update state
    lastCurationTime = Date.now()
    totalCurations++
    saveState()

    result.duration = Date.now() - startTime
    console.log(`[GemCurator] ✅ Curation complete: ${result.gemsStored} stored, ${result.gemsDeduplicated} deduped, ${result.duration}ms`)

    return result
}

// ============================================
// Helpers
// ============================================

function validateType(type: string): MemoryType {
    const valid: MemoryType[] = ['fact', 'preference', 'decision', 'architecture', 'bugfix', 'learning', 'observation', 'pattern', 'config', 'goal']
    return valid.includes(type as MemoryType) ? type as MemoryType : 'observation'
}

function saveGemsToFile(gems: Gem[]): void {
    try {
        const date = new Date().toISOString().split('T')[0]
        const filePath = join(GEMS_DIR, `${date}.json`)

        // Append to existing file for the day
        let existing: Gem[] = []
        if (existsSync(filePath)) {
            try { existing = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { /* fresh */ }
        }

        existing.push(...gems)
        writeFileSync(filePath, JSON.stringify(existing, null, 2))
    } catch { /* non-critical */ }
}

// ============================================
// Scheduling
// ============================================

/**
 * Should we run curation now?
 * - At least 24h since last curation
 * - OR manual trigger (force = true)
 */
export function shouldCurate(force: boolean = false): boolean {
    if (force) return true
    if (!internalLlm) return false

    const hoursSinceLast = (Date.now() - lastCurationTime) / (1000 * 60 * 60)
    return hoursSinceLast >= 24
}

/**
 * Get curated gems context for system prompt injection.
 * Returns recent gems formatted for LLM context.
 */
export function getGemContext(maxGems: number = 10): string {
    const date = new Date().toISOString().split('T')[0]
    const recent: Gem[] = []

    // Load last 3 days of gems
    for (let i = 0; i < 3; i++) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        const path = join(GEMS_DIR, `${d.toISOString().split('T')[0]}.json`)
        if (existsSync(path)) {
            try {
                const gems = JSON.parse(readFileSync(path, 'utf-8')) as Gem[]
                recent.push(...gems)
            } catch { /* skip */ }
        }
    }

    if (recent.length === 0) return ''

    // Sort by importance (desc), take top N
    const top = recent
        .sort((a, b) => b.importance - a.importance)
        .slice(0, maxGems)

    const lines = top.map(g =>
        `💎 [${g.type}] ${g.gem} (importance: ${g.importance}/10)`
    )

    return `\n[Curated Gems — letzte 3 Tage]\n${lines.join('\n')}`
}

/**
 * Get stats about the gem curator.
 */
export function getGemStats(): {
    totalCurations: number
    lastCuration: string
    recentGems: number
} {
    let recentGems = 0
    for (let i = 0; i < 7; i++) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        const path = join(GEMS_DIR, `${d.toISOString().split('T')[0]}.json`)
        if (existsSync(path)) {
            try {
                const gems = JSON.parse(readFileSync(path, 'utf-8'))
                recentGems += Array.isArray(gems) ? gems.length : 0
            } catch { /* skip */ }
        }
    }

    return {
        totalCurations,
        lastCuration: lastCurationTime ? new Date(lastCurationTime).toISOString() : 'never',
        recentGems,
    }
}

// ============================================
// Export
// ============================================

export default {
    initGemCurator,
    setInternalLLM,
    curate,
    shouldCurate,
    getGemContext,
    getGemStats,
}
