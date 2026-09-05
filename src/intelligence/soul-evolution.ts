/**
 * Self-Evolving SOUL — Automaton-inspired
 *
 * Nova's SOUL.md evolves over time based on:
 * - Learned facts and corrections
 * - Dream cycle insights
 * - User interaction patterns
 * - Self-reflection
 *
 * Every evolution is git-versioned via audit log.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const SOUL_PATH = join(process.cwd(), 'SOUL.md')
const EVOLUTION_LOG = join(process.cwd(), '.nova-data', 'soul-evolution.json')

interface SoulEvolution {
    version: number
    timestamp: number
    trigger: 'dream' | 'correction' | 'learning' | 'reflection' | 'manual'
    changes: string[]
    previousHash: string
}

interface SoulState {
    evolutions: SoulEvolution[]
    currentVersion: number
    lastEvolvedAt: number
    totalEvolutions: number
}

let state: SoulState = {
    evolutions: [],
    currentVersion: 1,
    lastEvolvedAt: 0,
    totalEvolutions: 0,
}

function loadState(): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        if (existsSync(EVOLUTION_LOG)) {
            state = JSON.parse(readFileSync(EVOLUTION_LOG, 'utf-8'))
        }
    } catch { }
}

function saveState(): void {
    try {
        writeFileSync(EVOLUTION_LOG, JSON.stringify(state, null, 2))
    } catch { }
}

function hashContent(content: string): string {
    const { createHash } = require('node:crypto')
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Read current SOUL.md
 */
export function readSoul(): string {
    try {
        if (existsSync(SOUL_PATH)) {
            return readFileSync(SOUL_PATH, 'utf-8')
        }
    } catch { }
    return ''
}

/**
 * Evolve SOUL.md with new insights
 * Called from dream cycle, learning, corrections
 */
export function evolveSoul(
    trigger: SoulEvolution['trigger'],
    newInsights: string[],
    llmSummarize?: (prompt: string) => Promise<string>
): void {
    loadState()

    const currentSoul = readSoul()
    if (!currentSoul) return

    const prevHash = hashContent(currentSoul)

    // Don't evolve more than once per hour
    if (Date.now() - state.lastEvolvedAt < 60 * 60 * 1000) return

    // Append insights to the SOUL
    const insightBlock = newInsights.map(i => `- ${i}`).join('\n')
    const evolutionSection = `\n\n<!-- Evolution v${state.currentVersion + 1} | ${new Date().toISOString()} | ${trigger} -->\n## Gelernt (Auto-Evolution)\n${insightBlock}\n`

    // Check if soul already has an evolution section
    const marker = '## Gelernt (Auto-Evolution)'
    let updatedSoul: string

    if (currentSoul.includes(marker)) {
        // Append to existing section
        const parts = currentSoul.split(marker)
        updatedSoul = parts[0] + marker + parts[1] + '\n' + insightBlock
    } else {
        // Add new section at the end
        updatedSoul = currentSoul + evolutionSection
    }

    // Write updated SOUL
    writeFileSync(SOUL_PATH, updatedSoul)

    // Log evolution
    const evolution: SoulEvolution = {
        version: state.currentVersion + 1,
        timestamp: Date.now(),
        trigger,
        changes: newInsights,
        previousHash: prevHash,
    }

    state.evolutions.push(evolution)
    state.currentVersion++
    state.lastEvolvedAt = Date.now()
    state.totalEvolutions++

    // Keep only last 50 evolutions in memory
    if (state.evolutions.length > 50) {
        state.evolutions = state.evolutions.slice(-50)
    }

    saveState()
    console.log(`[SoulEvolution] 🧬 SOUL.md evolved to v${state.currentVersion} (${trigger}: +${newInsights.length} insights)`)
}

/**
 * Get evolution history
 */
export function getSoulHistory(): string {
    loadState()

    if (state.evolutions.length === 0) return 'Keine Evolution bisher.'

    const recent = state.evolutions.slice(-10)
    return `🧬 **SOUL Evolution** (v${state.currentVersion}, ${state.totalEvolutions} total)

${recent.map(e => {
        const date = new Date(e.timestamp).toLocaleDateString('de')
        return `v${e.version} [${date}] ${e.trigger}: ${e.changes.slice(0, 2).join(', ')}${e.changes.length > 2 ? '...' : ''}`
    }).join('\n')}`
}

/**
 * Hook into dream cycle — called from subconscious-reflector
 */
export function dreamEvolution(insights: string[]): void {
    if (insights.length > 0) {
        evolveSoul('dream', insights)
    }
}
