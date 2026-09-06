/** Missing/malformed provider usage stays unavailable, never a measured zero. */
export function normalizeTokenUsage(prompt: unknown, completion: unknown, total?: unknown) {
    if (typeof prompt !== 'number' || typeof completion !== 'number'
        || !Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || prompt < 0 || completion < 0
        || !Number.isSafeInteger(prompt + completion)) return undefined
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: typeof total === 'number' && Number.isSafeInteger(total) && total >= prompt + completion
            ? total : prompt + completion,
    }
}
