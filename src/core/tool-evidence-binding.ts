import { createHash } from 'node:crypto'

export interface VerifiedToolCallEvidence {
    callId: string
    toolName: string
    argumentsHash: string
    resultHash: string
    matchedTargets: string[]
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]))
}

export function evidenceHash(value: unknown): string {
    let serialized: string
    try { serialized = JSON.stringify(stableValue(value)) }
    catch { serialized = String(value) }
    return createHash('sha256').update(serialized).digest('hex')
}

export function normalizeEvidenceTarget(value: string): string {
    const target = value.trim()
        .replace(/^["'`(<\[]+/, '')
        .replace(/["'`)>\],.;:!?]+$/, '')
        .replace(/\\/g, '/')
    const url = target.match(/^([a-z][a-z0-9+.-]*:)\/\/(.*)$/i)
    return (url ? `${url[1]}//${url[2].replace(/\/{2,}/g, '/')}` : target.replace(/\/{2,}/g, '/')).toLowerCase()
}

/** Only bind explicit, machine-comparable targets. Vague nouns are deliberately
 * excluded: failing closed is preferable to pretending semantic equivalence. */
export function inferRequiredToolTargets(goal: string): string[] {
    const urls = goal.match(/https?:\/\/[^\s"'`<>]+/gi) || []
    const fileText = goal.replace(/https?:\/\/[^\s"'`<>]+/gi, ' ')
    const candidates = [
        ...(fileText.match(/(?:[a-z]:[\\/]|\.{0,2}[\\/])[^\s"'`<>|]+/gi) || []),
        ...(fileText.match(/\b[a-z0-9_.-]+(?:[\\/][a-z0-9_. -]+)*\.[a-z][a-z0-9]{0,11}\b/gi) || []),
        ...urls,
    ]
    return [...new Set(candidates.map(normalizeEvidenceTarget).filter(Boolean))]
}

function argumentStrings(value: unknown): string[] {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(argumentStrings)
    if (!value || typeof value !== 'object') return []
    return Object.values(value as Record<string, unknown>).flatMap(argumentStrings)
}

export function matchedToolTargets(requiredTargets: readonly string[], args: Record<string, unknown>): string[] {
    const values = argumentStrings(args).map(normalizeEvidenceTarget).filter(Boolean)
    return requiredTargets.filter(target => values.some(value =>
        value === target || value.endsWith(`/${target}`) || target.endsWith(`/${value}`)))
}
