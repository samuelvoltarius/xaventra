/**
 * Maximal Marginal Relevance (MMR) Re-ranking
 *
 * Balances relevance with diversity — prevents returning
 * 5 nearly identical memories. Adapted from OpenClaw.
 *
 * MMR = λ * relevance - (1-λ) * max_similarity_to_selected
 * @see Carbonell & Goldstein (1998)
 */

// ============================================
// Types
// ============================================

export interface MMRItem {
    id: string
    score: number
    content: string
}

export interface MMRConfig {
    /** Enable/disable MMR re-ranking. Default: true */
    enabled: boolean
    /** Lambda: 0 = max diversity, 1 = max relevance. Default: 0.7 */
    lambda: number
}

export const DEFAULT_MMR_CONFIG: MMRConfig = {
    enabled: true,
    lambda: 0.7,
}

// ============================================
// Tokenization
// ============================================

export function tokenize(text: string): Set<string> {
    const tokens = text.toLowerCase().match(/[a-z0-9äöüß_]+/g) ?? []
    return new Set(tokens)
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 && setB.size === 0) return 1
    if (setA.size === 0 || setB.size === 0) return 0

    let intersectionSize = 0
    const smaller = setA.size <= setB.size ? setA : setB
    const larger = setA.size <= setB.size ? setB : setA

    for (const token of smaller) {
        if (larger.has(token)) intersectionSize++
    }

    const unionSize = setA.size + setB.size - intersectionSize
    return unionSize === 0 ? 0 : intersectionSize / unionSize
}

// ============================================
// MMR Algorithm
// ============================================

function maxSimilarityToSelected(
    item: MMRItem,
    selected: MMRItem[],
    tokenCache: Map<string, Set<string>>
): number {
    if (selected.length === 0) return 0

    let maxSim = 0
    const itemTokens = tokenCache.get(item.id) ?? tokenize(item.content)

    for (const sel of selected) {
        const selTokens = tokenCache.get(sel.id) ?? tokenize(sel.content)
        const sim = jaccardSimilarity(itemTokens, selTokens)
        if (sim > maxSim) maxSim = sim
    }

    return maxSim
}

/**
 * Re-rank items using MMR — iteratively selects items that 
 * balance relevance with diversity.
 */
export function mmrRerank<T extends MMRItem>(
    items: T[],
    config: Partial<MMRConfig> = {}
): T[] {
    const { enabled = DEFAULT_MMR_CONFIG.enabled, lambda = DEFAULT_MMR_CONFIG.lambda } = config

    if (!enabled || items.length <= 1) return [...items]

    const clampedLambda = Math.max(0, Math.min(1, lambda))
    if (clampedLambda === 1) {
        return [...items].sort((a, b) => b.score - a.score)
    }

    // Pre-tokenize
    const tokenCache = new Map<string, Set<string>>()
    for (const item of items) {
        tokenCache.set(item.id, tokenize(item.content))
    }

    // Normalize scores to [0,1]
    const maxScore = Math.max(...items.map(i => i.score))
    const minScore = Math.min(...items.map(i => i.score))
    const range = maxScore - minScore

    const normalize = (score: number): number =>
        range === 0 ? 1 : (score - minScore) / range

    const selected: T[] = []
    const remaining = new Set(items)

    while (remaining.size > 0) {
        let bestItem: T | null = null
        let bestMMR = -Infinity

        for (const candidate of remaining) {
            const relevance = normalize(candidate.score)
            const maxSim = maxSimilarityToSelected(candidate, selected, tokenCache)
            const mmrScore = clampedLambda * relevance - (1 - clampedLambda) * maxSim

            if (mmrScore > bestMMR || (mmrScore === bestMMR && candidate.score > (bestItem?.score ?? -Infinity))) {
                bestMMR = mmrScore
                bestItem = candidate
            }
        }

        if (bestItem) {
            selected.push(bestItem)
            remaining.delete(bestItem)
        } else {
            break
        }
    }

    return selected
}

export default { mmrRerank, tokenize, jaccardSimilarity, DEFAULT_MMR_CONFIG }
