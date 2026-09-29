import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time secret comparison. Both sides are hashed first so the
 * comparison runs over equal-length digests and leaks neither content nor
 * length through timing. Non-string or empty inputs never match.
 */
export function constantTimeTokenEquals(provided: unknown, expected: unknown): boolean {
    if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
    const a = createHash('sha256').update(provided, 'utf8').digest()
    const b = createHash('sha256').update(expected, 'utf8').digest()
    return timingSafeEqual(a, b) && provided.length === expected.length
}
