/**
 * Temporal Decay — Recency-Weighted Memory Scoring
 *
 * Older memories naturally fade unless reinforced.
 * Uses exponential decay with configurable half-life.
 * Adapted from OpenClaw's temporal-decay.ts.
 */

// ============================================
// Types
// ============================================

export interface TemporalDecayConfig {
    /** Enable/disable temporal decay. Default: true */
    enabled: boolean
    /** Days until a memory's score is halved. Default: 30 */
    halfLifeDays: number
}

export const DEFAULT_DECAY_CONFIG: TemporalDecayConfig = {
    enabled: true,
    halfLifeDays: 30,
}

const DAY_MS = 24 * 60 * 60 * 1000

// ============================================
// Core Functions
// ============================================

/**
 * Convert half-life in days to decay lambda.
 * λ = ln(2) / halfLife
 */
export function toDecayLambda(halfLifeDays: number): number {
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0
    return Math.LN2 / halfLifeDays
}

/**
 * Calculate the decay multiplier for a given age.
 * Returns value in (0, 1] where 1 = fresh, approaching 0 = very old.
 */
export function calculateDecayMultiplier(ageInDays: number, halfLifeDays: number): number {
    const lambda = toDecayLambda(halfLifeDays)
    const clampedAge = Math.max(0, ageInDays)
    if (lambda <= 0 || !Number.isFinite(clampedAge)) return 1
    return Math.exp(-lambda * clampedAge)
}

/**
 * Apply temporal decay to a score.
 */
export function applyDecayToScore(
    score: number,
    timestampMs: number,
    config: TemporalDecayConfig = DEFAULT_DECAY_CONFIG,
    nowMs: number = Date.now()
): number {
    if (!config.enabled) return score

    const ageMs = Math.max(0, nowMs - timestampMs)
    const ageInDays = ageMs / DAY_MS
    const multiplier = calculateDecayMultiplier(ageInDays, config.halfLifeDays)

    return score * multiplier
}

// ============================================
// Batch Processing
// ============================================

/**
 * Apply temporal decay to an array of search results.
 * Each result must have a `score` and `timestamp` field.
 */
export function applyDecayToResults<T extends { score: number; timestamp: number }>(
    results: T[],
    config: Partial<TemporalDecayConfig> = {},
    nowMs: number = Date.now()
): T[] {
    const fullConfig = { ...DEFAULT_DECAY_CONFIG, ...config }
    if (!fullConfig.enabled) return [...results]

    return results.map(entry => ({
        ...entry,
        score: applyDecayToScore(entry.score, entry.timestamp, fullConfig, nowMs),
    }))
}

export default {
    applyDecayToScore,
    applyDecayToResults,
    calculateDecayMultiplier,
    DEFAULT_DECAY_CONFIG,
}
