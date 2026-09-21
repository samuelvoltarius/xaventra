import type { ExecutionKernel } from './execution-kernel.js'

export type ToolFailureKind =
    | 'transient-transport'
    | 'rate-limited'
    | 'authorization'
    | 'invalid-input'
    | 'missing-dependency'
    | 'missing-resource'
    | 'unknown'

export interface TypedToolRecoveryExecution {
    callId: string
    toolName: string
    args: Record<string, unknown>
    result: unknown
    success: boolean
}

export interface TypedToolRecoveryResult {
    classification: ToolFailureKind
    attempted: boolean
    success: boolean
    reason: 'not-applicable' | 'retry-verified' | 'retry-failed' | 'retry-unverified'
    executions: TypedToolRecoveryExecution[]
    result?: unknown
}

/** Only operations whose contract is observational and whose repetition cannot
 * create an external effect belong here. Adding a tool requires a dedicated
 * regression proving that property; a category/name heuristic is insufficient. */
export const TRANSIENT_READ_ONLY_RECOVERY_TOOLS = new Set([
    'docker_ps',
    'get_current_time',
    'health_status',
    'mesh_capabilities',
    'mesh_status',
    'nova_introspect',
    'system_info',
])

function failureText(failure: unknown): string {
    if (failure instanceof Error) return `${failure.name}: ${failure.message}`
    if (typeof failure === 'string') return failure
    if (!failure || typeof failure !== 'object') return String(failure ?? '')
    const value = failure as Record<string, unknown>
    return [value.code, value.status, value.error, value.stderr, value.message]
        .filter(item => typeof item === 'string' || typeof item === 'number')
        .join(' ')
}

/** Deterministic classification only. Raw failure text is untrusted evidence
 * and is never converted into a command, tool name or authorization decision. */
export function classifyToolFailure(failure: unknown): ToolFailureKind {
    const text = failureText(failure)
    if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|permission denied|eacces|eperm|not permitted/i.test(text)) return 'authorization'
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) return 'rate-limited'
    if (/invalid (?:argument|parameter|input)|validation failed|bad request|\b400\b/i.test(text)) return 'invalid-input'
    if (/command not found|not recognized|cannot find module|module_not_found|missing (?:binary|dependency|package)/i.test(text)) return 'missing-dependency'
    if (/\benoent\b|no such file|file not found|datei nicht gefunden|does not exist/i.test(text)) return 'missing-resource'
    if (/\b(?:408|500|502|503|504)\b|\betimedout\b|\beconn(?:refused|reset)\b|\beai_again\b|fetch failed|network error|socket hang up|connection refused|temporar(?:y|ily) unavailable|service unavailable|gateway timeout|timed?\s*out/i.test(text)) return 'transient-transport'
    return 'unknown'
}

/** Perform exactly one separately governed retry for an explicitly classified,
 * read-only transient failure. The caller's executor must re-run authorization,
 * policy, fencing, idempotency and timeout checks. The same ExecutionKernel
 * independently validates the retried result; model prose is never evidence. */
export async function recoverTransientReadOnlyTool(input: {
    toolName: string
    args: Record<string, unknown>
    failure: unknown
    kernel: Pick<ExecutionKernel, 'contract' | 'verify'>
    nextCallId: (toolName: string) => string
    execute: (toolName: string, args: Record<string, unknown>, callId: string) => Promise<unknown>
}): Promise<TypedToolRecoveryResult> {
    const classification = classifyToolFailure(input.failure)
    if (classification !== 'transient-transport'
        || !TRANSIENT_READ_ONLY_RECOVERY_TOOLS.has(input.toolName)
        || !input.kernel.contract.allowedChanges.allowedTools.includes(input.toolName)) {
        return { classification, attempted: false, success: false, reason: 'not-applicable', executions: [] }
    }

    const callId = input.nextCallId(input.toolName)
    let result: unknown
    try {
        result = await input.execute(input.toolName, { ...input.args }, callId)
    } catch (error) {
        return {
            classification,
            attempted: true,
            success: false,
            reason: 'retry-failed',
            executions: [{ callId, toolName: input.toolName, args: { ...input.args }, result: error, success: false }],
        }
    }
    const verification = input.kernel.verify(input.toolName, result, { callId, arguments: input.args })
    const execution = { callId, toolName: input.toolName, args: { ...input.args }, result, success: verification.success }
    return {
        classification,
        attempted: true,
        success: verification.success,
        reason: verification.success ? 'retry-verified' : 'retry-unverified',
        executions: [execution],
        result,
    }
}
