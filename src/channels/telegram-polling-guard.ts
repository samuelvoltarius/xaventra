/**
 * Fail-closed authority check for Telegram long polling.
 *
 * A process that lost the mesh lease must never retry getUpdates: even if it
 * discards the received message later, Telegram has already acknowledged the
 * update and the real Main can no longer process it.
 */
export async function mayRetryTelegramPolling(
    verify?: (service: string) => Promise<boolean>,
): Promise<boolean> {
    try {
        const checker = verify
            || (await import('../mesh/leader-election.js')).verifyLiveServiceLeadership
        return await checker('telegram')
    } catch {
        return false
    }
}

/** Bounded jitter prevents two recently promoted processes from retrying in lockstep. */
export function telegramConflictRetryDelay(
    random: () => number = Math.random,
    baseMs = 30_000,
    jitterMs = 5_000,
): number {
    const sample = Math.max(0, Math.min(1, Number(random()) || 0))
    return baseMs + Math.floor(sample * jitterMs)
}
