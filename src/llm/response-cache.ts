/**
 * Nova — LLM Response Cache
 *
 * LRU cache for LLM responses. Identical (or near-identical) prompts
 * return cached results in 0 ms instead of 2-8 s API round-trips.
 *
 * Cache key = hash of (system prompt truncated + last N user messages).
 * TTL = 1 hour default. Max entries = 500.
 */

import { createHash } from 'node:crypto'

// ============================================
// Types
// ============================================

export interface CacheEntry {
    response: string
    model: string
    cachedAt: number
    hits: number
    tokensSaved: number
}

export interface CacheConfig {
    maxEntries: number
    ttlMs: number
    enabled: boolean
    /** How many recent user messages to include in the cache key */
    keyDepth: number
}

export interface CacheStats {
    entries: number
    hits: number
    misses: number
    hitRate: string
    tokensSaved: number
    enabled: boolean
}

// ============================================
// Response Cache
// ============================================

const DEFAULT_CONFIG: CacheConfig = {
    maxEntries: 2000,
    ttlMs: 4 * 60 * 60 * 1000, // 4 hours
    enabled: true,
    keyDepth: 7,
}

let config: CacheConfig = { ...DEFAULT_CONFIG }
const cache = new Map<string, CacheEntry>()
let totalHits = 0
let totalMisses = 0

/**
 * Build a cache key from the conversation context.
 * Uses a SHA-256 hash of the complete system prompt +
 * the last N user messages to create a stable, compact key.
 */
function buildCacheKey(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
): string {
    const userMessages = messages
        .filter(m => m.role === 'user')
        .slice(-config.keyDepth)
        .map(m => m.content)
        .join('|')

    // Hash the complete prompt. Live context (time, enabled channels, model
    // status) is appended after the persona and must invalidate stale answers.
    const systemKey = createHash('sha256').update(systemPrompt).digest('hex')
    const raw = `${systemKey}::${userMessages}`

    return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * Look up a cached response.
 * Returns the cached response string or null on miss.
 */
export function getCachedResponse(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
): string | null {
    if (!config.enabled) return null

    const key = buildCacheKey(systemPrompt, messages)
    const entry = cache.get(key)

    if (!entry) {
        totalMisses++
        return null
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > config.ttlMs) {
        cache.delete(key)
        totalMisses++
        return null
    }

    entry.hits++
    totalHits++
    console.log(`[ResponseCache] ✅ Cache HIT (key=${key.slice(0, 8)}…, hits=${entry.hits})`)
    return entry.response
}

/**
 * Store a response in the cache.
 */
export function cacheResponse(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    response: string,
    model: string,
): void {
    if (!config.enabled) return

    // Greetings and connectivity probes often produce live status/time claims.
    // They are cheap and unsafe to reuse, even within the normal cache TTL.
    const lastUserMessage = messages.filter(m => m.role === 'user').at(-1)?.content.trim().toLowerCase() || ''
    if (/^(test|ping|hallo|hi|hey|warum|wieso|weshalb|bist du da|geht es|gehts|status)[.!?\s]*$/i.test(lastUserMessage)) return

    // Don't cache very short or error/fallback responses
    if (response.length < 20) return
    if (response.startsWith('❌') || response.startsWith('Fehler')) return
    if (response.includes('Entschuldigung') && response.includes('schiefgelaufen')) return
    if (response.includes('etwas schiefgelaufen')) return

    const key = buildCacheKey(systemPrompt, messages)

    // Evict oldest if at capacity
    if (cache.size >= config.maxEntries) {
        evictOldest()
    }

    cache.set(key, {
        response,
        model,
        cachedAt: Date.now(),
        hits: 0,
        tokensSaved: Math.ceil(response.length / 4),
    })

    console.log(`[ResponseCache] 📥 Cached response (key=${key.slice(0, 8)}…, size=${response.length})`)
}

/**
 * Evict the oldest (least recently cached) entry.
 */
function evictOldest(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of cache.entries()) {
        if (entry.cachedAt < oldestTime) {
            oldestTime = entry.cachedAt
            oldestKey = key
        }
    }

    if (oldestKey) {
        cache.delete(oldestKey)
    }
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): CacheStats {
    let tokensSaved = 0
    for (const entry of cache.values()) {
        tokensSaved += entry.tokensSaved * entry.hits
    }

    const total = totalHits + totalMisses
    return {
        entries: cache.size,
        hits: totalHits,
        misses: totalMisses,
        hitRate: total > 0 ? `${Math.round((totalHits / total) * 100)}%` : '0%',
        tokensSaved,
        enabled: config.enabled,
    }
}

/**
 * Clear all cached responses.
 */
export function clearCache(): void {
    cache.clear()
    totalHits = 0
    totalMisses = 0
    console.log('[ResponseCache] 🗑️ Cache cleared')
}

/**
 * Update cache configuration.
 */
export function configureCache(updates: Partial<CacheConfig>): void {
    config = { ...config, ...updates }
    console.log(`[ResponseCache] ⚙️ Config updated: enabled=${config.enabled}, max=${config.maxEntries}, ttl=${config.ttlMs}ms`)
}

/**
 * Invalidate cache entries matching a pattern in their response.
 * Useful when config/persona changes.
 */
export function invalidateMatching(pattern: string): number {
    let removed = 0
    for (const [key, entry] of cache.entries()) {
        if (entry.response.includes(pattern) || entry.model.includes(pattern)) {
            cache.delete(key)
            removed++
        }
    }
    if (removed > 0) {
        console.log(`[ResponseCache] 🗑️ Invalidated ${removed} entries matching "${pattern}"`)
    }
    return removed
}
