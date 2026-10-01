import { redactSecrets } from '../security/secret-redaction.js'

/** Longest subject/value the Knowledge Graph accepts as a node label. */
export const MAX_GRAPH_LABEL = 50

/**
 * Subject/predicate/value are optional structure (memory key + Knowledge
 * Graph). Each part is cleaned; a part with a secret or an over-long
 * subject/value drops the whole structure, the plain sentence is still
 * remembered. The graph projection needs all three parts.
 */
export function cleanStructure(input: { subject?: string; predicate?: string; value?: string }): { subject?: string; predicate?: string; value?: string } {
    const clean = (part: unknown) => String(part ?? '').replace(/\s+/g, ' ').trim()
    const subject = clean(input.subject)
    const value = clean(input.value)
    const predicate = clean(input.predicate).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40)
    if (subject.length > MAX_GRAPH_LABEL || value.length > MAX_GRAPH_LABEL) return {}
    for (const part of [subject, predicate, value]) {
        if (part && (redactSecrets(part) !== part || part.includes('[REDACTED'))) return {}
    }
    return { ...(subject ? { subject } : {}), ...(predicate ? { predicate } : {}), ...(value ? { value } : {}) }
}

/** All three parts, clean — or null. */
export function structuredTriple(input: { subject?: string; predicate?: string; value?: string }): { subject: string; predicate: string; value: string } | null {
    const { subject, predicate, value } = cleanStructure(input)
    return subject && predicate && value ? { subject, predicate, value } : null
}
