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

/** A login that is really rejected (HTTP 401/403, OAuth) — the only reason to ask the owner to sign in again. */
export function isAuthFailure(error: string): boolean {
    return /UnauthorizedError|\b40[13]\b|invalid_grant|unauthori[sz]ed|forbidden/i.test(String(error || ''))
}

/**
 * B2/B3 (28.10.2026): the address cannot be reached (network, DNS, timeout). Never a
 * reason for a new login, a self-repair diagnosis or a fast reconnect loop.
 */
export function isUnreachable(error: string): boolean {
    const text = String(error || '')
    if (isAuthFailure(text)) return false
    return isInfrastructureFailure(text) || /EHOSTUNREACH|ENETUNREACH|ENOTFOUND|getaddrinfo|network ?error/i.test(text)
}

/**
 * Abnahme 2.90.0 (29.10.2026): a send that failed in the network (EFATAL, fetch failed, reset,
 * refused, timeout, DNS, hang-up) — the only failure a channel may resend. An error that carries an
 * API answer (e.g. Telegram 400/403/429) is never one: the service has seen the request.
 */
export function isTransientTransportFailure(error: unknown): boolean {
    const failure = error as { code?: unknown; response?: { statusCode?: unknown } } | undefined
    if (!failure) return false
    if (failure.response?.statusCode !== undefined || failure.code === 'ETELEGRAM') return false
    return /\bEFATAL\b|fetch failed|ECONN(?:RESET|REFUSED)|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(`${String(failure.code ?? '')} ${String(error)}`)
}
