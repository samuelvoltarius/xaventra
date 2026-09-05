/**
 * L23 — Instinct Layer
 * 
 * Develops unconscious behavioral rules from user corrections.
 * Instead of just storing facts, Nova builds "instincts" that
 * modify her system prompt at runtime.
 * 
 * Example: If user corrects "too technical" 5 times,
 * Nova develops instinct: "tone: casual" and adjusts automatically.
 * 
 * This layer makes Nova adapt to the user's personality
 * WITHOUT manual SOUL.md edits.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'instincts')
const INSTINCTS_FILE = join(DATA_DIR, 'active-instincts.json')

// ============================================
// Types
// ============================================

interface Instinct {
    id: string
    category: 'tone' | 'verbosity' | 'language' | 'behavior' | 'safety'
    trigger: string         // What triggers this instinct
    rule: string            // The actual behavioral rule
    strength: number        // 0-100, grows with reinforcement
    activations: number     // How often triggered
    createdAt: string
    lastActivated: string
    source: 'correction' | 'feedback' | 'pattern' | 'auto'
}

interface CorrectionEvent {
    timestamp: number
    userMessage: string
    correction: string
    category: string
}

// ============================================
// State
// ============================================

let instincts: Instinct[] = []
const recentCorrections: CorrectionEvent[] = []

// Correction patterns → instinct mapping
const CORRECTION_PATTERNS: Array<{
    patterns: RegExp[]
    category: Instinct['category']
    trigger: string
    rule: string
}> = [
        {
            patterns: [/zu technisch/i, /too technical/i, /einfacher/i, /simpler/i, /nicht so kompliziert/i],
            category: 'tone',
            trigger: 'User findet Antworten zu technisch',
            rule: 'Antworte informell und einfach. Vermeide Fachbegriffe. Erkläre wie einem Freund.',
        },
        {
            patterns: [/zu lang/i, /too long/i, /kürzer/i, /shorter/i, /fass dich kurz/i, /TL;DR/i],
            category: 'verbosity',
            trigger: 'User will kürzere Antworten',
            rule: 'Halte Antworten kurz und prägnant. Max 3-4 Sätze außer explizit mehr gewünscht.',
        },
        {
            patterns: [/zu kurz/i, /mehr detail/i, /erkläre mehr/i, /ausführlicher/i],
            category: 'verbosity',
            trigger: 'User will detailliertere Antworten',
            rule: 'Gib ausführliche Antworten mit Kontext und Beispielen.',
        },
        {
            patterns: [/auf deutsch/i, /in german/i, /nicht englisch/i, /sprich deutsch/i],
            category: 'language',
            trigger: 'User will Deutsch',
            rule: 'Antworte IMMER auf Deutsch, auch bei technischen Begriffen.',
        },
        {
            patterns: [/mach einfach/i, /ohne nachfragen/i, /tu es/i, /just do it/i, /frag nicht/i],
            category: 'behavior',
            trigger: 'User will weniger Rückfragen',
            rule: 'Handle proaktiv ohne Rückfragen. Tu es statt zu fragen.',
        },
        {
            patterns: [/vorsichtig/i, /erst fragen/i, /nicht automatisch/i, /bestätigung/i],
            category: 'behavior',
            trigger: 'User will Bestätigung vor Aktionen',
            rule: 'Frage vor jeder Aktion nach Bestätigung. Sei vorsichtig.',
        },
        {
            patterns: [/keine emojis/i, /weniger emojis/i, /zu viele emoji/i],
            category: 'tone',
            trigger: 'User mag keine Emojis',
            rule: 'Verwende keine oder sehr wenige Emojis.',
        },
        {
            patterns: [/sei lustig/i, /humor/i, /witz/i, /spaß/i],
            category: 'tone',
            trigger: 'User will Humor',
            rule: 'Sei humorvoll und locker. Mach gelegentliche Witze.',
        },
    ]

// ============================================
// Core Logic
// ============================================

/**
 * Process a user correction and develop instincts
 */
export function processCorrection(userMessage: string, novaResponse: string): void {
    for (const pattern of CORRECTION_PATTERNS) {
        if (pattern.patterns.some(p => p.test(userMessage))) {
            const event: CorrectionEvent = {
                timestamp: Date.now(),
                userMessage: userMessage.slice(0, 200),
                correction: pattern.trigger,
                category: pattern.category,
            }
            recentCorrections.push(event)

            // Check if we have enough corrections to form an instinct
            const sameCategory = recentCorrections.filter(c =>
                c.category === pattern.category &&
                c.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000  // Last 7 days
            )

            if (sameCategory.length >= 2) {
                addOrReinforceInstinct(pattern.category, pattern.trigger, pattern.rule, 'correction')
            }
        }
    }
}

/**
 * Add a new instinct or reinforce an existing one
 */
function addOrReinforceInstinct(
    category: Instinct['category'],
    trigger: string,
    rule: string,
    source: Instinct['source']
): void {
    const existing = instincts.find(i => i.category === category && i.trigger === trigger)

    if (existing) {
        // Reinforce existing instinct
        existing.strength = Math.min(100, existing.strength + 10)
        existing.activations++
        existing.lastActivated = new Date().toISOString()
        console.log(`[Instincts] 💪 Reinforced: "${trigger}" (Stärke: ${existing.strength})`)
    } else {
        // Create new instinct
        const instinct: Instinct = {
            id: `inst-${Date.now().toString(36)}`,
            category,
            trigger,
            rule,
            strength: 20,  // Start at 20%
            activations: 1,
            createdAt: new Date().toISOString(),
            lastActivated: new Date().toISOString(),
            source,
        }
        instincts.push(instinct)
        console.log(`[Instincts] 🧬 New instinct: "${trigger}" (${category})`)
    }

    saveInstincts()
}

/**
 * Get active instincts as system prompt modifier
 * Only instincts with strength >= 30 are applied
 */
export function getInstinctPrompt(): string {
    const active = instincts.filter(i => i.strength >= 30)
    if (active.length === 0) return ''

    const lines = ['## INSTINKTE (automatisch gelernt)', '']
    for (const instinct of active) {
        lines.push(`- **${instinct.trigger}** → ${instinct.rule}`)
    }

    return lines.join('\n')
}

/**
 * Decay instincts that haven't been reinforced recently
 * Called during dream cycles
 */
export function decayInstincts(): number {
    let decayed = 0
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000  // 14 days

    for (const instinct of instincts) {
        const lastActive = new Date(instinct.lastActivated).getTime()
        if (lastActive < cutoff && instinct.strength > 10) {
            instinct.strength -= 5
            decayed++
        }
    }

    // Remove dead instincts
    instincts = instincts.filter(i => i.strength > 0)

    if (decayed > 0) {
        saveInstincts()
        console.log(`[Instincts] 📉 ${decayed} instincts decayed`)
    }

    return decayed
}

/**
 * Manually add an instinct (via admin command)
 */
export function addInstinct(category: Instinct['category'], trigger: string, rule: string): void {
    addOrReinforceInstinct(category, trigger, rule, 'auto')
}

/**
 * Get all instincts for debugging/display
 */
export function getInstincts(): Instinct[] {
    return [...instincts]
}

// ============================================
// Persistence
// ============================================

function saveInstincts(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(INSTINCTS_FILE, JSON.stringify(instincts, null, 2))
    } catch { /* non-critical */ }
}

function loadInstincts(): void {
    try {
        if (existsSync(INSTINCTS_FILE)) {
            instincts = JSON.parse(readFileSync(INSTINCTS_FILE, 'utf-8'))
            console.log(`[Instincts] ✅ ${instincts.length} Instinkte geladen`)
        }
    } catch {
        instincts = []
    }
}

/**
 * Initialize instinct layer
 */
export function initInstincts(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    loadInstincts()
    console.log(`[Instincts] ✅ L23 initialized — ${instincts.length} active instincts`)
}
