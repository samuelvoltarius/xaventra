/**
 * Emotion Tracker
 * 
 * Rule-based emotion detection from message patterns.
 * No LLM calls — purely pattern-matched for zero latency.
 * 
 * Detects: frustrated, rushed, happy, confused, neutral, stressed
 * Maintains a sliding window of last 5 messages per user.
 */

// ============================================
// Types
// ============================================

export type EmotionType = 'frustrated' | 'rushed' | 'happy' | 'confused' | 'neutral' | 'stressed' | 'excited' | 'calm'

export interface EmotionSignal {
    emotion: EmotionType
    confidence: number    // 0-1
    reason: string        // Why this emotion was detected
    timestamp: number
}

export interface UserEmotionalState {
    currentEmotion: EmotionType
    confidence: number
    trend: 'improving' | 'stable' | 'declining'
    recentSignals: EmotionSignal[]
}

// ============================================
// Detection Patterns
// ============================================

const PATTERNS: Array<{
    emotion: EmotionType
    test: (msg: string) => boolean
    confidence: number
    reason: string
}> = [
        // === FRUSTRATED ===
        {
            emotion: 'frustrated',
            test: (msg) => /!!+/.test(msg) || /\?\?\?+/.test(msg),
            confidence: 0.8,
            reason: 'Mehrfache Ausrufe-/Fragezeichen'
        },
        {
            emotion: 'frustrated',
            test: (msg) => /geht nicht|funktioniert nicht|klappt nicht|doesn'?t work|broken|kaputt|fehler|error|bug/i.test(msg),
            confidence: 0.7,
            reason: 'Fehler-/Problemwörter erkannt'
        },
        {
            emotion: 'frustrated',
            test: (msg) => /immer noch|schon wieder|wieder nicht|nochmal|again|still broken/i.test(msg),
            confidence: 0.85,
            reason: 'Wiederholungs-Frustration'
        },
        {
            emotion: 'frustrated',
            test: (msg) => msg.toUpperCase() === msg && msg.length > 10 && /[A-Z]/.test(msg),
            confidence: 0.75,
            reason: 'CAPS LOCK — User schreit'
        },

        // === RUSHED ===
        {
            emotion: 'rushed',
            test: (msg) => {
                // High typo density: unusual character sequences
                const words = msg.split(/\s+/)
                if (words.length < 3) return false
                const typoWords = words.filter(w =>
                    w.length > 2 && !/^[a-zäöüß0-9@#/\\.-]+$/i.test(w) === false &&
                    /[a-z]{2,}/i.test(w) &&
                    !/^(https?:|www\.)/.test(w)
                )
                // Check for common typo patterns
                return /\b(amch|mach|hcek|cheack|fxi|fxie|gib|gbi|udn|udn|nciht|auhc|nochc|berits|wiedr|dsa|dsa|mti|mti)\b/i.test(msg)
            },
            confidence: 0.7,
            reason: 'Viele Tippfehler → User tippt hastig'
        },
        {
            emotion: 'rushed',
            test: (msg) => msg.length < 15 && !msg.endsWith('?') && /^[a-zäöüß\s]+$/i.test(msg),
            confidence: 0.5,
            reason: 'Sehr kurze Nachricht ohne Satzzeichen'
        },
        {
            emotion: 'rushed',
            test: (msg) => /schnell|asap|dringend|urgent|sofort|jetzt|quick|hurry/i.test(msg),
            confidence: 0.8,
            reason: 'Dringlichkeitswörter'
        },

        // === HAPPY / EXCITED ===
        {
            emotion: 'happy',
            test: (msg) => /😊|😄|🎉|👍|❤️|🙏|💪|🔥|✨|😁|🥳|💯|👏/u.test(msg),
            confidence: 0.8,
            reason: 'Positive Emojis'
        },
        {
            emotion: 'happy',
            test: (msg) => /super|perfekt|genial|geil|nice|awesome|great|love it|toll|wunderbar|klasse|mega|top/i.test(msg),
            confidence: 0.75,
            reason: 'Positive Wörter'
        },
        {
            emotion: 'excited',
            test: (msg) => /wow|krass|alter|omg|oh mein gott|unglaublich|wahnsinn|amazing|insane/i.test(msg),
            confidence: 0.8,
            reason: 'Begeisterungswörter'
        },

        // === CONFUSED ===
        {
            emotion: 'confused',
            test: (msg) => /versteh.*nicht|kapier.*nicht|was meinst|hä\??|wie das|don'?t understand|what do you mean/i.test(msg),
            confidence: 0.8,
            reason: 'Verständnisfrage'
        },
        {
            emotion: 'confused',
            test: (msg) => msg.trim().endsWith('?') && msg.length < 30,
            confidence: 0.4,
            reason: 'Kurze Frage'
        },
        {
            emotion: 'confused',
            test: (msg) => /warum|wieso|weshalb|why|how come/i.test(msg) && msg.endsWith('?'),
            confidence: 0.6,
            reason: 'Warum-Frage'
        },

        // === STRESSED ===
        {
            emotion: 'stressed',
            test: (msg) => /deadline|zeitdruck|muss fertig|müssen.*fertig|bis morgen|bis heute|before tomorrow/i.test(msg),
            confidence: 0.85,
            reason: 'Zeitdruck erkannt'
        },

        // === CALM ===
        {
            emotion: 'calm',
            test: (msg) => msg.length > 50 && /bitte|könntest|wäre nett|when you have time|keine eile|no rush/i.test(msg),
            confidence: 0.6,
            reason: 'Höfliche, ausführliche Nachricht'
        },
    ]

// ============================================
// Per-User State (Sliding Window)
// ============================================

const userStates = new Map<string, EmotionSignal[]>()
const MAX_SIGNALS = 5

/**
 * Analyze a message and update the user's emotional state
 */
export function analyzeEmotion(userId: string, message: string): EmotionSignal {
    const signals = userStates.get(userId) || []

    // Run all patterns, pick highest confidence match
    let bestSignal: EmotionSignal = {
        emotion: 'neutral',
        confidence: 0.3,
        reason: 'Keine besonderen Muster erkannt',
        timestamp: Date.now(),
    }

    for (const pattern of PATTERNS) {
        try {
            if (pattern.test(message) && pattern.confidence > bestSignal.confidence) {
                bestSignal = {
                    emotion: pattern.emotion,
                    confidence: pattern.confidence,
                    reason: pattern.reason,
                    timestamp: Date.now(),
                }
            }
        } catch { /* pattern failed, skip */ }
    }

    // Update sliding window
    signals.push(bestSignal)
    if (signals.length > MAX_SIGNALS) {
        signals.shift()
    }
    userStates.set(userId, signals)

    return bestSignal
}

/**
 * Get the overall emotional state for a user (weighted average of recent signals)
 */
export function getEmotionalState(userId: string): UserEmotionalState {
    const signals = userStates.get(userId) || []

    if (signals.length === 0) {
        return {
            currentEmotion: 'neutral',
            confidence: 0.3,
            trend: 'stable',
            recentSignals: [],
        }
    }

    // Weight recent signals more heavily
    const weights = signals.map((_, i) => 1 + i) // [1, 2, 3, 4, 5]
    const totalWeight = weights.reduce((a, b) => a + b, 0)

    // Count emotions weighted
    const emotionScores = new Map<EmotionType, number>()
    for (let i = 0; i < signals.length; i++) {
        const score = emotionScores.get(signals[i].emotion) || 0
        emotionScores.set(signals[i].emotion, score + weights[i] * signals[i].confidence)
    }

    // Find top emotion
    let topEmotion: EmotionType = 'neutral'
    let topScore = 0
    for (const [emotion, score] of emotionScores) {
        if (score > topScore) {
            topEmotion = emotion
            topScore = score
        }
    }

    // Determine trend (comparing first half vs second half)
    const mid = Math.floor(signals.length / 2)
    const firstHalf = signals.slice(0, mid)
    const secondHalf = signals.slice(mid)

    const positiveEmotions: EmotionType[] = ['happy', 'excited', 'calm']
    const negativeEmotions: EmotionType[] = ['frustrated', 'stressed', 'rushed']

    const firstPositive = firstHalf.filter(s => positiveEmotions.includes(s.emotion)).length
    const secondPositive = secondHalf.filter(s => positiveEmotions.includes(s.emotion)).length
    const firstNegative = firstHalf.filter(s => negativeEmotions.includes(s.emotion)).length
    const secondNegative = secondHalf.filter(s => negativeEmotions.includes(s.emotion)).length

    let trend: 'improving' | 'stable' | 'declining' = 'stable'
    if (secondPositive > firstPositive || secondNegative < firstNegative) trend = 'improving'
    if (secondNegative > firstNegative || secondPositive < firstPositive) trend = 'declining'

    return {
        currentEmotion: topEmotion,
        confidence: Math.min(topScore / totalWeight, 1),
        trend,
        recentSignals: signals,
    }
}

/**
 * Get a system prompt snippet describing the user's emotional state
 * This helps Nova adapt her tone
 */
export function getEmotionPrompt(userId: string): string {
    const state = getEmotionalState(userId)

    if (state.confidence < 0.4) return '' // Not confident enough

    const toneGuide: Record<EmotionType, string> = {
        frustrated: 'Der User wirkt gerade **frustriert**. Sei besonders klar, direkt und lösungsorientiert. Vermeide Floskeln. Zeige Verständnis kurz: "Ich verstehe das Problem" und liefere sofort die Lösung.',
        rushed: 'Der User ist gerade **in Eile**. Antworte kurz und knapp. Keine langen Erklärungen. Bullet Points statt Fließtext. Direkt zur Sache.',
        happy: 'Der User ist **gut drauf** 😊. Du darfst gerne lockerer und persönlicher sein. Teile seine Begeisterung mit.',
        excited: 'Der User ist **begeistert**! Teile seine Energie, aber bleib sachlich bei der Umsetzung.',
        confused: 'Der User scheint **verwirrt**. Erkläre Schritt für Schritt. Nutze einfache Sprache. Frage nach, ob deine Erklärung verständlich war.',
        stressed: 'Der User steht unter **Zeitdruck**. Priorisiere die wichtigste Aufgabe. Biete an, Dinge parallel zu erledigen. Sei effizient.',
        neutral: '',
        calm: 'Der User ist **entspannt**. Du kannst ausführlicher erklären und auch Kontext geben.',
    }

    const guide = toneGuide[state.currentEmotion]
    if (!guide) return ''

    const trendNote = state.trend === 'improving' ? ' (Stimmung verbessert sich)' :
        state.trend === 'declining' ? ' (Stimmung verschlechtert sich — sei vorsichtig)' : ''

    return `\n\n## EMOTIONALE WAHRNEHMUNG\n${guide}${trendNote}\n`
}

/**
 * Reset a user's emotional state
 */
export function resetEmotion(userId: string): void {
    userStates.delete(userId)
}

export default {
    analyzeEmotion,
    getEmotionalState,
    getEmotionPrompt,
    resetEmotion,
}
