/**
 * Soul 2.0 — Adaptive Persona System
 *
 * Nova dynamically adjusts her tone based on:
 * 1. User sentiment (detected per message)
 * 2. Conversation context (technical vs casual)
 * 3. Time of day (morning briefing vs late night)
 * 4. Explicit user preference (via /persona or config)
 *
 * Modes: chill, focus, serious, empathic, hype
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Sentiment Analysis (keyword + pattern based)
// ============================================

export type Sentiment = 'positive' | 'negative' | 'neutral' | 'frustrated' | 'excited' | 'confused'

interface SentimentResult {
    sentiment: Sentiment
    confidence: number  // 0-1
    indicators: string[]
}

const SENTIMENT_PATTERNS: Record<Sentiment, RegExp[]> = {
    positive: [
        /danke|thank|super|perfekt|geil|toll|nice|awesome|cool|genial|❤️|🎉|👏|💪|😊|🥳|🔥/i,
        /das ist (super|perfekt|toll|genial|fantastisch)/i,
        /gut gemacht|well done|prima|bravo|exzellent/i,
    ],
    negative: [
        /schlecht|mist|shit|fuck|scheiße|kacke|doof|blöd|nervig|frustrierend/i,
        /das (geht|klappt|funktioniert) nicht/i,
        /😤|😡|🤬|💩|😞|😢/i,
    ],
    frustrated: [
        /warum (geht|klappt|funktioniert) das nicht/i,
        /schon wieder|immer noch|zum x-ten mal/i,
        /ich (hab|habe) (dir|das) doch (gesagt|erklärt)/i,
        /!{2,}|\.{3,}/,
        /\?\?+/,  // Multiple question marks
        /nichts (klappt|funktioniert|geht)/i,
        /WAS ZUM|WIESO|WARUM/,  // All caps = frustration
    ],
    excited: [
        /!{2,}.*[🔥🎉🚀💪😍🤩]/,
        /omg|oh mein gott|wahnsinn|unglaublich|krass/i,
        /endlich|finally|es funktioniert|it works/i,
        /🤯|🥰|😱|🤩/,
    ],
    confused: [
        /\?{2,}/,
        /verstehe (ich|das) nicht/i,
        /was meinst du|wie geht das|wo finde ich/i,
        /hä\??|häh\??|wat\??|huh\??/i,
        /🤔|😕|🤷/,
        /ich (check|checke|versteh) das nicht/i,
    ],
    neutral: [],  // Default
}

export function analyzeSentiment(message: string): SentimentResult {
    const indicators: string[] = []
    const scores: Partial<Record<Sentiment, number>> = {}

    for (const [sentiment, patterns] of Object.entries(SENTIMENT_PATTERNS)) {
        let matches = 0
        for (const pattern of patterns) {
            if (pattern.test(message)) {
                matches++
                const match = message.match(pattern)
                if (match) indicators.push(match[0])
            }
        }
        if (matches > 0) {
            scores[sentiment as Sentiment] = matches
        }
    }

    // Find dominant sentiment
    let dominant: Sentiment = 'neutral'
    let maxScore = 0
    for (const [s, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score
            dominant = s as Sentiment
        }
    }

    // ALL CAPS detection (frustration boost)
    const words = message.split(/\s+/)
    const capsWords = words.filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w))
    if (capsWords.length > 2) {
        scores.frustrated = (scores.frustrated || 0) + 2
        if ((scores.frustrated || 0) > maxScore) {
            dominant = 'frustrated'
            maxScore = scores.frustrated || 0
        }
    }

    // Short, punchy messages with "!" are often frustrated
    if (message.length < 30 && message.includes('!') && !message.match(/😊|❤️|🎉|💪/)) {
        if (dominant === 'neutral') dominant = 'frustrated'
    }

    const confidence = maxScore > 0 ? Math.min(maxScore / 3, 1) : 0.5

    return { sentiment: dominant, confidence, indicators }
}

// ============================================
// Persona Modes
// ============================================

export type PersonaMode = 'chill' | 'focus' | 'serious' | 'empathic' | 'hype'

interface PersonaModeConfig {
    name: string
    emoji: string
    instruction: string
    triggers: Sentiment[]
}

const PERSONA_MODES: Record<PersonaMode, PersonaModeConfig> = {
    chill: {
        name: 'Chill',
        emoji: '😎',
        instruction: 'Sei locker, entspannt, freundlich. Verwende Emojis sparsam aber natürlich. Kurze Sätze. Kein Overexplaining.',
        triggers: ['neutral', 'positive'],
    },
    focus: {
        name: 'Focus',
        emoji: '🎯',
        instruction: 'Sei präzise und technisch. Keine Emojis. Keine unnötigen Worte. Code und Fakten first. Direkt zur Lösung.',
        triggers: [],  // Explicitly activated by context
    },
    serious: {
        name: 'Serious',
        emoji: '💼',
        instruction: 'Sei professionell und sachlich. Strukturierte Antworten. Keine Slang-Ausdrücke. Business-Ton.',
        triggers: [],
    },
    empathic: {
        name: 'Empathic',
        emoji: '💚',
        instruction: 'Sei verständnisvoll und geduldig. Bestätige die Frustration des Users. Biete Hilfe an ohne zu drängen. Zeige dass du verstehst.',
        triggers: ['frustrated', 'negative'],
    },
    hype: {
        name: 'Hype',
        emoji: '🔥',
        instruction: 'Sei begeistert und energisch! Feiere Erfolge. Nutze Emojis großzügig. Sei enthusiastisch aber nicht cringe.',
        triggers: ['excited'],
    },
}

// ============================================
// Adaptive Persona State
// ============================================

const STATE_FILE = join(process.cwd(), '.nova-data', 'persona-state.json')

interface PersonaState {
    currentMode: PersonaMode
    lockedMode: PersonaMode | null  // If user explicitly set a mode
    recentSentiments: Array<{ sentiment: Sentiment; timestamp: number }>
    modeHistory: Array<{ mode: PersonaMode; timestamp: number; reason: string }>
}

let state: PersonaState = {
    currentMode: 'chill',
    lockedMode: null,
    recentSentiments: [],
    modeHistory: [],
}

function loadState(): void {
    try {
        if (existsSync(STATE_FILE)) {
            state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
        }
    } catch { /* fresh start */ }
}

function saveState(): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    } catch { /* non-critical */ }
}

// Initialize
loadState()

// ============================================
// Mode Selection Logic
// ============================================

export function selectPersonaMode(
    message: string,
    context?: { isCodeRelated?: boolean; isBusiness?: boolean }
): { mode: PersonaMode; reason: string; sentiment: SentimentResult } {
    const sentiment = analyzeSentiment(message)

    // Record sentiment
    state.recentSentiments.push({ sentiment: sentiment.sentiment, timestamp: Date.now() })
    if (state.recentSentiments.length > 20) {
        state.recentSentiments = state.recentSentiments.slice(-20)
    }

    // If user locked a mode, respect it
    if (state.lockedMode) {
        return { mode: state.lockedMode, reason: `User-locked: ${state.lockedMode}`, sentiment }
    }

    let selectedMode: PersonaMode = 'chill'
    let reason = 'Default'

    // Context-based selection
    if (context?.isCodeRelated) {
        selectedMode = 'focus'
        reason = 'Code/tech context detected'
    } else if (context?.isBusiness) {
        selectedMode = 'serious'
        reason = 'Business context detected'
    }

    // Sentiment override (stronger signal)
    if (sentiment.confidence > 0.5) {
        for (const [mode, config] of Object.entries(PERSONA_MODES)) {
            if (config.triggers.includes(sentiment.sentiment)) {
                selectedMode = mode as PersonaMode
                reason = `Sentiment: ${sentiment.sentiment} (confidence: ${sentiment.confidence.toFixed(2)})`
                break
            }
        }
    }

    // Frustration pattern: multiple frustrated messages in a row → empathic
    const recentFrustrated = state.recentSentiments
        .filter(s => Date.now() - s.timestamp < 300_000) // Last 5 min
        .filter(s => s.sentiment === 'frustrated')
    if (recentFrustrated.length >= 2) {
        selectedMode = 'empathic'
        reason = 'Repeated frustration detected'
    }

    // Time-of-day hint (late night = chill)
    const hour = new Date().getHours()
    if (hour >= 22 || hour < 6) {
        if (selectedMode === 'serious') {
            selectedMode = 'chill'
            reason = 'Late night → chill mode'
        }
    }

    // Update state
    if (state.currentMode !== selectedMode) {
        state.modeHistory.push({ mode: selectedMode, timestamp: Date.now(), reason })
        if (state.modeHistory.length > 50) {
            state.modeHistory = state.modeHistory.slice(-50)
        }
        state.currentMode = selectedMode
    }

    saveState()
    return { mode: selectedMode, reason, sentiment }
}

// ============================================
// Build Persona Context for System Prompt
// ============================================

export function buildPersonaContext(mode: PersonaMode): string {
    const config = PERSONA_MODES[mode]
    return `\n## 🎭 AKTIVER PERSONA-MODUS: ${config.name} ${config.emoji}\n${config.instruction}\n`
}

export function getCurrentMode(): PersonaMode {
    return state.lockedMode || state.currentMode
}

export function lockMode(mode: PersonaMode): void {
    state.lockedMode = mode
    state.currentMode = mode
    saveState()
    console.log(`[Soul 2.0] Mode locked: ${mode}`)
}

export function unlockMode(): void {
    state.lockedMode = null
    saveState()
    console.log('[Soul 2.0] Mode unlocked (adaptive)')
}

export function getPersonaModes(): Record<string, { name: string; emoji: string }> {
    const modes: Record<string, { name: string; emoji: string }> = {}
    for (const [key, config] of Object.entries(PERSONA_MODES)) {
        modes[key] = { name: config.name, emoji: config.emoji }
    }
    return modes
}

// ============================================
// Context Detection Helpers
// ============================================

export function detectContext(message: string): { isCodeRelated: boolean; isBusiness: boolean } {
    const lower = message.toLowerCase()

    const codeIndicators = [
        /\b(code|function|class|import|export|const|let|var|npm|git|docker|api|endpoint)\b/,
        /\b(bug|error|exception|stack.*trace|debug|compile|build|deploy)\b/,
        /\b(typescript|javascript|python|react|node|sql|database|query)\b/,
        /```/,  // Code block
        /\.(ts|js|py|json|yaml|yml|md|css|html)\b/,
    ]

    const businessIndicators = [
        /\b(angebot|rechnung|invoice|proposal|meeting|deadline|budget|client|kunde)\b/i,
        /\b(business|enterprise|management|project|timeline|milestone|stakeholder)\b/i,
        /\b(email|mail|call|termin|presentation)\b/i,
    ]

    return {
        isCodeRelated: codeIndicators.some(p => p.test(lower)),
        isBusiness: businessIndicators.some(p => p.test(lower)),
    }
}

export default {
    analyzeSentiment,
    selectPersonaMode,
    buildPersonaContext,
    getCurrentMode,
    lockMode,
    unlockMode,
    getPersonaModes,
    detectContext,
}
