/**
 * The ONE rule for „the environment failed, not the approach/the model“:
 * timeouts, aborts, exhausted budgets, contract limits and network errors.
 *
 * Used by the correction detector (a failed tool call does not block the
 * identical retry) and since 2.86.1 by the model health (such a failure never
 * counts towards auto-disabling a model). Dependency free on purpose.
 */
export function isInfrastructureFailure(error: string): boolean {
    return /\[Timeout\]|timed? ?out|exceeded \d+ ?ms|budget exhausted|outside task contract|AbortError|aborted|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error || ''))
}
