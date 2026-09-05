/**
 * Vibe Regler — Time-Aware Behavioral Adjustment
 * 
 * Nova adjusts her communication style based on:
 * - Time of day (morning = focused, night = quiet)
 * - Activity level (long idle = minimal, active = full)
 * - Day type (workday = professional, weekend = casual)
 * 
 * No calendar API needed — pure pattern recognition.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'vibe')

// ============================================
// Types
// ============================================

interface VibeState {
    currentVibe: 'focused' | 'casual' | 'minimal' | 'quiet'
    lastUserActivity: number
    todayMessageCount: number
    lastVibeChange: number
}

interface VibeProfile {
    name: string
    promptModifier: string
    maxResponseLength: number  // approx words
    emoji: boolean
    proactive: boolean
}

// ============================================
// Vibe Profiles
// ============================================

const VIBE_PROFILES: Record<string, VibeProfile> = {
    focused: {
        name: 'Fokussiert',
        promptModifier: `## 🎯 Vibe: Fokussiert (Arbeitszeit)
- Antworte präzise und strukturiert
- Nutze Code-Blöcke und Listen
- Komme direkt zum Punkt
- Maximal 3-4 Sätze bei einfachen Fragen`,
        maxResponseLength: 200,
        emoji: false,
        proactive: true,
    },
    casual: {
        name: 'Entspannt',
        promptModifier: `## 😊 Vibe: Entspannt (Freizeit)
- Lockerer Ton, darf auch mal Spaß machen
- Emojis sind erlaubt
- Ausführlicher wenn nötig`,
        maxResponseLength: 400,
        emoji: true,
        proactive: true,
    },
    minimal: {
        name: 'Minimal',
        promptModifier: `## 🤫 Vibe: Minimal (Lange idle)
- Ultra-kurze Antworten
- Nur das Nötigste
- Keine unaufgeforderten Vorschläge`,
        maxResponseLength: 80,
        emoji: false,
        proactive: false,
    },
    quiet: {
        name: 'Ruhe',
        promptModifier: `## 🌙 Vibe: Nachtruhe
- Minimale Aktivität
- Keine proaktiven Nachrichten
- Nur antworten wenn direkt gefragt
- Kurz und leise`,
        maxResponseLength: 50,
        emoji: false,
        proactive: false,
    },
}

// ============================================
// State
// ============================================

let state: VibeState = {
    currentVibe: 'focused',
    lastUserActivity: Date.now(),
    todayMessageCount: 0,
    lastVibeChange: Date.now(),
}

// ============================================
// Core Logic
// ============================================

/**
 * Determine the current vibe based on time + activity
 */
export function calculateVibe(): string {
    const now = new Date()
    const hour = now.getHours()
    const dow = now.getDay()  // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6
    const idleMinutes = (Date.now() - state.lastUserActivity) / (60 * 1000)

    let newVibe: string

    // Night mode: 23:00 - 07:00
    if (hour >= 23 || hour < 7) {
        newVibe = 'quiet'
    }
    // Long idle (> 60 min without message)
    else if (idleMinutes > 60) {
        newVibe = 'minimal'
    }
    // Weekend
    else if (isWeekend) {
        newVibe = 'casual'
    }
    // Workday 8-18
    else if (hour >= 8 && hour <= 18) {
        newVibe = 'focused'
    }
    // Evening 18-23
    else {
        newVibe = 'casual'
    }

    if (newVibe !== state.currentVibe) {
        console.log(`[Vibe] 🎭 ${state.currentVibe} → ${newVibe} (${hour}:00, idle ${Math.round(idleMinutes)}min)`)
        state.currentVibe = newVibe as VibeState['currentVibe']
        state.lastVibeChange = Date.now()
        saveState()
    }

    return newVibe
}

/**
 * Get the prompt modifier for current vibe
 */
export function getVibePrompt(): string {
    calculateVibe()
    return VIBE_PROFILES[state.currentVibe]?.promptModifier || ''
}

/**
 * Record user activity (call on every message)
 */
export function recordUserActivity(): void {
    state.lastUserActivity = Date.now()
    state.todayMessageCount++

    // Reset count at midnight
    const now = new Date()
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        state.todayMessageCount = 0
    }
}

/**
 * Check if proactive messages are allowed right now
 */
export function isProactiveAllowed(): boolean {
    calculateVibe()
    return VIBE_PROFILES[state.currentVibe]?.proactive ?? false
}

/**
 * Get current vibe info for display
 */
export function getVibeInfo(): string {
    calculateVibe()
    const profile = VIBE_PROFILES[state.currentVibe]
    const idleMin = Math.round((Date.now() - state.lastUserActivity) / 60000)
    return `🎭 Vibe: ${profile.name} | Idle: ${idleMin}min | Msgs heute: ${state.todayMessageCount}`
}

// ============================================
// Persistence
// ============================================

function saveState(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'state.json'), JSON.stringify(state, null, 2))
    } catch { /* non-critical */ }
}

function loadState(): void {
    try {
        const path = join(DATA_DIR, 'state.json')
        if (existsSync(path)) {
            state = { ...state, ...JSON.parse(readFileSync(path, 'utf-8')) }
        }
    } catch { /* start fresh */ }
}

// ============================================
// Init
// ============================================

export function initVibeRegler(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    loadState()
    calculateVibe()
    console.log(`[Vibe] ✅ Initialized — current vibe: ${VIBE_PROFILES[state.currentVibe].name}`)
}
