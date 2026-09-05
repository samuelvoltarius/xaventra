import { isDurableMemoryCandidate, memoryRelevance } from './memory-quality.js'

export interface CuratableFact {
    id: string
    type: string
    content: string
    confidence: number
    createdAt: number
    accessCount: number
    lastAccessed: number
}

const LIMITS: Record<string, number> = {
    name: 5, preference: 20, project: 15, skill: 15,
    context: 20, instruction: 20, relationship: 10,
}

function scoreFact(fact: CuratableFact, now: number): number {
    const ageDays = Math.max(0, now - Math.max(fact.createdAt, fact.lastAccessed || 0)) / 86_400_000
    const halfLife = fact.type === 'name' || fact.type === 'instruction' ? 365
        : fact.type === 'preference' ? 120 : fact.type === 'context' ? 30 : 90
    const decay = Math.pow(0.5, ageDays / halfLife)
    return fact.confidence * 4 * decay + Math.log2(1 + fact.accessCount) + (fact.type === 'name' ? 3 : 0)
}

function hasNegation(text: string): boolean {
    return /\b(?:nicht|nie|kein(?:e|en|er)?|never|not|no)\b/i.test(text)
}

/** Three deterministic roles: proposer ranks durable candidates, adversary
 * removes duplicates/contradictions, judge applies type budgets. */
export function curateFacts<T extends CuratableFact>(facts: T[], now = Date.now()): T[] {
    const proposed = facts
        .filter(fact => isDurableMemoryCandidate(fact.content))
        .map(fact => ({ fact, score: scoreFact(fact, now) }))
        .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt)

    const challenged: Array<{ fact: T; score: number }> = []
    for (const candidate of proposed) {
        const conflictIndex = challenged.findIndex(existing =>
            existing.fact.type === candidate.fact.type
            && memoryRelevance(existing.fact.content, candidate.fact.content) >= 0.6)
        if (conflictIndex < 0) {
            challenged.push(candidate)
            continue
        }
        const existing = challenged[conflictIndex]
        const contradiction = hasNegation(existing.fact.content) !== hasNegation(candidate.fact.content)
        if (contradiction && candidate.fact.createdAt > existing.fact.createdAt) challenged[conflictIndex] = candidate
        else if (!contradiction && candidate.score > existing.score) challenged[conflictIndex] = candidate
    }

    const counts = new Map<string, number>()
    return challenged.filter(({ fact }) => {
        const count = counts.get(fact.type) || 0
        if (count >= (LIMITS[fact.type] || 15)) return false
        counts.set(fact.type, count + 1)
        return true
    }).map(entry => entry.fact)
}
