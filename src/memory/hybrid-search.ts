/**
 * Hybrid Search — Vector + Keyword Fusion
 *
 * Combines vector similarity with keyword matching for better accuracy.
 * Uses Reciprocal Rank Fusion (RRF) to merge result lists.
 * Adapted from OpenClaw's hybrid.ts.
 */

import { mmrRerank, type MMRConfig, DEFAULT_MMR_CONFIG } from './mmr.js'
import { applyDecayToResults, type TemporalDecayConfig, DEFAULT_DECAY_CONFIG } from './temporal-decay.js'

// ============================================
// Types
// ============================================

export interface HybridSearchConfig {
    /** Weight for vector similarity (0-1). Default: 0.6 */
    vectorWeight: number
    /** Weight for keyword matching (0-1). Default: 0.4 */
    keywordWeight: number
    /** MMR config */
    mmr: MMRConfig
    /** Temporal decay config */
    decay: TemporalDecayConfig
}

export const DEFAULT_HYBRID_CONFIG: HybridSearchConfig = {
    vectorWeight: 0.6,
    keywordWeight: 0.4,
    mmr: DEFAULT_MMR_CONFIG,
    decay: DEFAULT_DECAY_CONFIG,
}

export interface HybridCandidate {
    id: string
    content: string
    timestamp: number
    vectorScore: number
    keywordScore: number
    type?: string
    source?: string
    metadata?: string
}

export interface HybridResult {
    id: string
    content: string
    score: number
    timestamp: number
    type?: string
    source?: string
    metadata?: string
}

// ============================================
// Keyword Scoring (BM25-like)
// ============================================

/**
 * Simple BM25-inspired keyword scoring.
 * Counts term frequency with diminishing returns.
 */
export function keywordScore(query: string, content: string): number {
    const queryTokens = query.toLowerCase().match(/[a-z0-9äöüß_]+/g) ?? []
    const contentLower = content.toLowerCase()

    if (queryTokens.length === 0) return 0

    let totalScore = 0
    const contentLength = contentLower.length

    for (const token of queryTokens) {
        // Count occurrences
        let count = 0
        let pos = 0
        while ((pos = contentLower.indexOf(token, pos)) !== -1) {
            count++
            pos += token.length
        }

        if (count > 0) {
            // BM25-like saturation: tf / (tf + k)
            const k = 1.5
            const tf = count / (contentLength / 100) // normalized by doc length
            const termScore = tf / (tf + k)
            totalScore += termScore
        }
    }

    // Normalize by number of query tokens
    return totalScore / queryTokens.length
}

// ============================================
// Hybrid Merge
// ============================================

/**
 * Merge vector and keyword search results using weighted fusion.
 * Then apply temporal decay and MMR re-ranking.
 */
export function mergeHybridResults(
    candidates: HybridCandidate[],
    config: Partial<HybridSearchConfig> = {}
): HybridResult[] {
    const fullConfig = { ...DEFAULT_HYBRID_CONFIG, ...config }

    // 1) Weighted score fusion
    let merged: HybridResult[] = candidates.map(c => ({
        id: c.id,
        content: c.content,
        score: fullConfig.vectorWeight * c.vectorScore + fullConfig.keywordWeight * c.keywordScore,
        timestamp: c.timestamp,
        type: c.type,
        source: c.source,
        metadata: c.metadata,
    }))

    // 2) Apply temporal decay
    merged = applyDecayToResults(merged, fullConfig.decay)

    // 3) Sort by score descending
    merged.sort((a, b) => b.score - a.score)

    // 4) Apply MMR re-ranking for diversity
    if (fullConfig.mmr.enabled) {
        merged = mmrRerank(merged, fullConfig.mmr)
    }

    return merged
}

/**
 * Quick helper: search a flat list of entries with both vector and keyword matching.
 * Designed to integrate directly with LanceDB recall().
 */
export function hybridRerankResults(
    vectorResults: Array<{ id: string; content: string; score: number; timestamp: number; type?: string; source?: string; metadata?: string }>,
    query: string,
    config: Partial<HybridSearchConfig> = {}
): HybridResult[] {
    const candidates: HybridCandidate[] = vectorResults.map(r => ({
        id: r.id,
        content: r.content,
        timestamp: r.timestamp,
        vectorScore: r.score,
        keywordScore: keywordScore(query, r.content),
        type: r.type,
        source: r.source,
        metadata: r.metadata,
    }))

    return mergeHybridResults(candidates, config)
}

export default { mergeHybridResults, hybridRerankResults, keywordScore, DEFAULT_HYBRID_CONFIG }
