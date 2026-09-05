/**
 * User Preferences Store
 * 
 * Stores and retrieves per-user preferences for personalized responses.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface UserPreferences {
    userId: string
    language: 'de' | 'en'
    preferredStack: string[]
    avoidPatterns: string[]
    knownProjects: string[]
    communicationStyle: 'formal' | 'casual' | 'technical'
    customRules: string[]
    failedPatterns: Array<{ pattern: string; count: number; lastFailed: number }>
    updatedAt: number
}

// ============================================
// Storage
// ============================================

const PREFS_DIR = '.nova-prefs'
const prefsCache = new Map<string, UserPreferences>()

function getPrefsPath(userId: string): string {
    const dir = join(process.cwd(), PREFS_DIR)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
    return join(dir, `${userId.replace(/[^a-zA-Z0-9]/g, '_')}.json`)
}

// ============================================
// Main API
// ============================================

/**
 * Get default preferences for new users
 */
export function getDefaultPreferences(userId: string): UserPreferences {
    return {
        userId,
        language: 'de',
        preferredStack: [],
        avoidPatterns: [],
        knownProjects: [],
        communicationStyle: 'casual',
        customRules: [],
        failedPatterns: [],
        updatedAt: Date.now(),
    }
}

/**
 * Load preferences for a user
 */
export function loadPreferences(userId: string): UserPreferences {
    // Check cache
    if (prefsCache.has(userId)) {
        return prefsCache.get(userId)!
    }

    // Load from disk
    const path = getPrefsPath(userId)
    if (existsSync(path)) {
        try {
            const data = JSON.parse(readFileSync(path, 'utf-8'))
            prefsCache.set(userId, data)
            return data
        } catch {
            // Corrupted file, return defaults
        }
    }

    // Create defaults
    const defaults = getDefaultPreferences(userId)
    prefsCache.set(userId, defaults)
    return defaults
}

/**
 * Save preferences for a user
 */
export function savePreferences(prefs: UserPreferences): void {
    prefs.updatedAt = Date.now()
    prefsCache.set(prefs.userId, prefs)

    const path = getPrefsPath(prefs.userId)
    writeFileSync(path, JSON.stringify(prefs, null, 2))
    console.log(`[UserPrefs] Saved preferences for ${prefs.userId}`)
}

/**
 * Update a specific preference
 */
export function updatePreference<K extends keyof UserPreferences>(
    userId: string,
    key: K,
    value: UserPreferences[K]
): UserPreferences {
    const prefs = loadPreferences(userId)
    prefs[key] = value
    savePreferences(prefs)
    return prefs
}

/**
 * Add to a list preference
 */
export function addToPreference(
    userId: string,
    key: 'preferredStack' | 'avoidPatterns' | 'knownProjects' | 'customRules',
    value: string
): void {
    const prefs = loadPreferences(userId)
    if (!prefs[key].includes(value)) {
        prefs[key].push(value)
        savePreferences(prefs)
    }
}

/**
 * Track a failed pattern
 */
export function trackFailedPattern(userId: string, pattern: string): void {
    const prefs = loadPreferences(userId)
    const existing = prefs.failedPatterns.find(p => p.pattern === pattern)

    if (existing) {
        existing.count++
        existing.lastFailed = Date.now()
    } else {
        prefs.failedPatterns.push({ pattern, count: 1, lastFailed: Date.now() })
    }

    // Keep only recent failures (last 20)
    prefs.failedPatterns = prefs.failedPatterns
        .sort((a, b) => b.lastFailed - a.lastFailed)
        .slice(0, 20)

    savePreferences(prefs)
}

/**
 * Get preference summary for prompt injection
 */
export function getPreferenceSummary(userId: string): string {
    const prefs = loadPreferences(userId)
    const parts: string[] = []

    if (prefs.preferredStack.length > 0) {
        parts.push(`Bevorzugter Stack: ${prefs.preferredStack.join(', ')}`)
    }

    if (prefs.avoidPatterns.length > 0) {
        parts.push(`Vermeide: ${prefs.avoidPatterns.join(', ')}`)
    }

    if (prefs.knownProjects.length > 0) {
        parts.push(`Bekannte Projekte: ${prefs.knownProjects.join(', ')}`)
    }

    if (prefs.customRules.length > 0) {
        parts.push(`Regeln: ${prefs.customRules.join('; ')}`)
    }

    // Warn about frequently failed patterns
    const frequentFailures = prefs.failedPatterns.filter(p => p.count >= 2)
    if (frequentFailures.length > 0) {
        parts.push(`⚠️ Oft fehlgeschlagen: ${frequentFailures.map(p => p.pattern).join(', ')}`)
    }

    return parts.length > 0
        ? `\n[User-Präferenzen: ${parts.join(' | ')}]`
        : ''
}

/**
 * Learn preference from conversation
 */
export function learnFromConversation(userId: string, text: string): void {
    const prefs = loadPreferences(userId)

    // Detect technology preferences
    const techPatterns = [
        { pattern: /ich nutze (\w+)/gi, key: 'preferredStack' as const },
        { pattern: /verwende lieber (\w+)/gi, key: 'preferredStack' as const },
        { pattern: /kein (\w+) bitte/gi, key: 'avoidPatterns' as const },
        { pattern: /nicht mit (\w+)/gi, key: 'avoidPatterns' as const },
    ]

    for (const { pattern, key } of techPatterns) {
        let match
        while ((match = pattern.exec(text)) !== null) {
            const value = match[1]
            if (value && !prefs[key].includes(value)) {
                prefs[key].push(value)
                console.log(`[UserPrefs] Learned: ${key} += ${value}`)
            }
        }
    }

    // Only save if something changed
    if (prefs.updatedAt < Date.now() - 1000) {
        savePreferences(prefs)
    }
}

export default {
    loadPreferences,
    savePreferences,
    updatePreference,
    addToPreference,
    trackFailedPattern,
    getPreferenceSummary,
    learnFromConversation,
}
