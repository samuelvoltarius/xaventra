/**
 * FailoverError and Model Fallback
 * 
 * Ported from nova's failover-error.ts and model-fallback.ts
 * Full implementation - not simplified!
 */

// ============================================
// Failover Reason Types
// ============================================

export type FailoverReason =
    | 'rate_limit'   // 429
    | 'billing'      // 402
    | 'auth'         // 401, 403
    | 'timeout'      // 408, network timeout
    | 'format'       // 400, bad request
    | 'server'       // 500, 502, 503, 504
    | 'unknown'

// ============================================
// FailoverError Class
// ============================================

export class FailoverError extends Error {
    readonly reason: FailoverReason
    readonly provider?: string
    readonly model?: string
    readonly profileId?: string
    readonly status?: number
    readonly code?: string

    constructor(
        message: string,
        params: {
            reason: FailoverReason
            provider?: string
            model?: string
            profileId?: string
            status?: number
            code?: string
            cause?: unknown
        }
    ) {
        super(message, { cause: params.cause })
        this.name = 'FailoverError'
        this.reason = params.reason
        this.provider = params.provider
        this.model = params.model
        this.profileId = params.profileId
        this.status = params.status
        this.code = params.code
    }
}

export function isFailoverError(err: unknown): err is FailoverError {
    return err instanceof FailoverError
}

// ============================================
// Failover Reason Classification
// ============================================

const TIMEOUT_HINT_RE = /timeout|timed out|deadline exceeded|context deadline exceeded/i

export function classifyFailoverReason(message: string): FailoverReason | null {
    if (!message) return null

    // Rate limit
    if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
        return 'rate_limit'
    }

    // Billing
    if (/402|billing|payment|insufficient.?fund/i.test(message)) {
        return 'billing'
    }

    // Auth or Config — check BEFORE general "invalid" check to avoid false positives
    if (/401|403|unauthorized|forbidden|invalid.?key|auth|unknown.?provider|api.?key/i.test(message)) {
        return 'auth'
    }

    // Timeout
    if (TIMEOUT_HINT_RE.test(message) || /fetch failed|network error|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        return 'timeout'
    }

    // Server errors
    if (/5\d{2}|internal.?server|service.?unavailable|overloaded|bad.?gateway/i.test(message)) {
        return 'server'
    }

    // Format/validation — only if NOT already matched by auth above
    if (/400|bad.?request|malformed/i.test(message)) {
        return 'format'
    }

    return null
}

export function resolveFailoverStatus(reason: FailoverReason): number | undefined {
    switch (reason) {
        case 'billing': return 402
        case 'rate_limit': return 429
        case 'auth': return 401
        case 'timeout': return 408
        case 'format': return 400
        case 'server': return 503
        default: return undefined
    }
}

// ============================================
// Error Helpers
// ============================================

function getStatusCode(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined
    const candidate = (err as any).status ?? (err as any).statusCode
    if (typeof candidate === 'number') return candidate
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
        return Number(candidate)
    }
    return undefined
}

function getErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== 'object') return undefined
    const candidate = (err as any).code
    return typeof candidate === 'string' ? candidate.trim() || undefined : undefined
}

function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    if (err && typeof err === 'object') {
        const message = (err as any).message
        if (typeof message === 'string') return message
    }
    return ''
}

function getErrorName(err: unknown): string {
    if (!err || typeof err !== 'object') return ''
    return 'name' in err ? String((err as any).name) : ''
}

export function isTimeoutError(err: unknown): boolean {
    if (!err) return false
    if (getErrorName(err) === 'TimeoutError') return true
    const message = getErrorMessage(err)
    return Boolean(message && TIMEOUT_HINT_RE.test(message))
}

export function resolveFailoverReasonFromError(err: unknown): FailoverReason | null {
    if (isFailoverError(err)) return err.reason

    const status = getStatusCode(err)
    if (status === 402) return 'billing'
    if (status === 429) return 'rate_limit'
    if (status === 401 || status === 403) return 'auth'
    if (status === 408) return 'timeout'
    if (status && status >= 500 && status < 600) return 'server'

    const code = (getErrorCode(err) ?? '').toUpperCase()
    if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNABORTED'].includes(code)) {
        return 'timeout'
    }
    if (isTimeoutError(err)) return 'timeout'

    const message = getErrorMessage(err)
    return message ? classifyFailoverReason(message) : null
}

export function coerceToFailoverError(
    err: unknown,
    context?: { provider?: string; model?: string; profileId?: string }
): FailoverError | null {
    if (isFailoverError(err)) return err
    const reason = resolveFailoverReasonFromError(err)
    if (!reason) return null

    const message = getErrorMessage(err) || String(err)
    const status = getStatusCode(err) ?? resolveFailoverStatus(reason)
    const code = getErrorCode(err)

    return new FailoverError(message, {
        reason,
        provider: context?.provider,
        model: context?.model,
        profileId: context?.profileId,
        status,
        code,
        cause: err instanceof Error ? err : undefined,
    })
}

export function describeFailoverError(err: unknown): {
    message: string
    reason?: FailoverReason
    status?: number
    code?: string
} {
    if (isFailoverError(err)) {
        return {
            message: err.message,
            reason: err.reason,
            status: err.status,
            code: err.code,
        }
    }
    return {
        message: getErrorMessage(err) || String(err),
        reason: resolveFailoverReasonFromError(err) ?? undefined,
        status: getStatusCode(err),
        code: getErrorCode(err),
    }
}

// ============================================
// Model Candidate Type
// ============================================

export interface ModelCandidate {
    provider: string
    model: string
}

export interface FallbackAttempt {
    provider: string
    model: string
    error: string
    reason?: FailoverReason
    status?: number
    code?: string
}

// ============================================
// Default Fallback Models — Dynamic from Discovery
// ============================================

// Static seed fallbacks (used only if discovery hasn't run yet)
// Dynamic seed fallbacks — built from central model resolver at runtime
function buildSeedFallbacks(): ModelCandidate[] {
    try {
        const { getDefaultModel } = require('../core/model-defaults.js')
        return [
            { provider: 'local', model: getDefaultModel() },
            { provider: 'local', model: 'auto' },
        ]
    } catch {
        return [{ provider: 'local', model: 'auto' }]
    }
}

/**
 * Get fallback models — prefers dynamically discovered models,
 * falls back to static seed list if no discovery cache exists.
 */
export function getDefaultFallbacks(): ModelCandidate[] {
    try {
        const { buildFallbackChain } = require('./model-discovery.js')
        const chain = buildFallbackChain()
        if (chain && chain.length > 0) {
            return chain
        }
    } catch { /* discovery module not loaded yet */ }
    return buildSeedFallbacks()
}

// Legacy export for backward compatibility
// Legacy export — now dynamic
export const DEFAULT_FALLBACKS: ModelCandidate[] = buildSeedFallbacks()

// ============================================
// Abort Error Detection
// ============================================

function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    if (isFailoverError(err)) return false
    const name = getErrorName(err)
    return name === 'AbortError'
}

function shouldRethrowAbort(err: unknown): boolean {
    return isAbortError(err) && !isTimeoutError(err)
}

// ============================================
// Run With Model Fallback
// ============================================

export interface RunWithFallbackParams<T> {
    provider: string
    model: string
    fallbacks?: ModelCandidate[]
    run: (provider: string, model: string) => Promise<T>
    onError?: (attempt: {
        provider: string
        model: string
        error: unknown
        attempt: number
        total: number
    }) => void | Promise<void>
}

export interface RunWithFallbackResult<T> {
    result: T
    provider: string
    model: string
    attempts: FallbackAttempt[]
}

export async function runWithModelFallback<T>(
    params: RunWithFallbackParams<T>
): Promise<RunWithFallbackResult<T>> {
    // Build candidate list: primary first, then fallbacks
    const candidates: ModelCandidate[] = [
        { provider: params.provider, model: params.model },
        ...(params.fallbacks ?? DEFAULT_FALLBACKS).filter(
            f => !(f.provider === params.provider && f.model === params.model)
        ),
    ]

    const attempts: FallbackAttempt[] = []
    let lastError: unknown

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]

        try {
            const result = await params.run(candidate.provider, candidate.model)
            return {
                result,
                provider: candidate.provider,
                model: candidate.model,
                attempts,
            }
        } catch (err) {
            // Rethrow abort errors (user cancelled)
            if (shouldRethrowAbort(err)) throw err

            // Try to coerce to FailoverError
            const normalized = coerceToFailoverError(err, {
                provider: candidate.provider,
                model: candidate.model,
            }) ?? err

            // If not a failover-worthy error, rethrow
            if (!isFailoverError(normalized)) throw err

            lastError = normalized
            const described = describeFailoverError(normalized)

            attempts.push({
                provider: candidate.provider,
                model: candidate.model,
                error: described.message,
                reason: described.reason,
                status: described.status,
                code: described.code,
            })

            console.log(`[ModelFallback] ❌ ${candidate.model} failed: ${described.reason ?? 'unknown'} (${described.status ?? '?'}), trying next...`)

            await params.onError?.({
                provider: candidate.provider,
                model: candidate.model,
                error: normalized,
                attempt: i + 1,
                total: candidates.length,
            })
        }
    }

    // All models failed
    if (attempts.length <= 1 && lastError) throw lastError

    const summary = attempts.length > 0
        ? attempts
            .map(a => `${a.provider}/${a.model}: ${a.error}${a.reason ? ` (${a.reason})` : ''}`)
            .join(' | ')
        : 'unknown'

    throw new Error(`All models failed (${attempts.length || candidates.length}): ${summary}`, {
        cause: lastError instanceof Error ? lastError : undefined,
    })
}

// ============================================
// Exports
// ============================================

export default {
    FailoverError,
    isFailoverError,
    coerceToFailoverError,
    classifyFailoverReason,
    resolveFailoverReasonFromError,
    describeFailoverError,
    runWithModelFallback,
    DEFAULT_FALLBACKS,
}
