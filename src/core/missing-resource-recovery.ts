import { dirname, basename, extname, isAbsolute, parse, resolve } from 'node:path'
import { existsSync } from 'node:fs'

export interface MissingResourceRecoveryPlan {
    requestedPath: string
    searchRoot: string
    searchArgs: Record<string, unknown>
}

export interface MissingResourceCandidate {
    path: string
    confidence: number
    reason: 'exact-name' | 'fuzzy-name'
}

export interface MissingResourceRecoveryExecution {
    callId: string
    toolName: string
    args: Record<string, unknown>
    result: unknown
    success: boolean
}

export interface MissingResourceRecoveryResult {
    success: boolean
    requestedPath?: string
    resolvedPath?: string
    reason?: 'exact-name' | 'fuzzy-name' | 'not-applicable' | 'ambiguous-or-missing' | 'unverified-discovery' | 'unverified-retry'
    executions: MissingResourceRecoveryExecution[]
    result?: unknown
}

interface RecoveryKernel {
    contract: { allowedChanges: { allowedTools: string[] } }
    verify(toolName: string, result: unknown, invocation: { callId: string; arguments: Record<string, unknown> }): { success: boolean }
    registerResolvedTarget(input: { requested: string; resolved: string; discoveryCallId: string; discoveryResult: unknown }): boolean
}

const READ_ONLY_RESOURCE_TOOLS = new Set(['read_file', 'read_document', 'code_outline'])
const MISSING_RESOURCE = /(?:enoent|not\s+found|nicht\s+gefunden|does\s+not\s+exist|no\s+such\s+file)/i

function resultError(result: unknown): string {
    if (typeof result === 'string') return result
    if (!result || typeof result !== 'object') return ''
    const value = result as Record<string, unknown>
    return [value.error, value.stderr, value.message].filter(item => typeof item === 'string').join('\n')
}

function nearestExistingDirectory(path: string): string | null {
    let current = path
    const root = parse(current).root
    while (current && current !== root && !existsSync(current)) current = dirname(current)
    if (!current || current === root || !existsSync(current)) return null
    return current
}

/** Build a bounded, read-only discovery step only for a genuine missing-resource
 * result. A missing absolute path must have an existing non-root ancestor; this
 * prevents an accidental scan of an entire drive or filesystem. */
export function planMissingResourceRecovery(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    workspaceRoot = process.cwd(),
): MissingResourceRecoveryPlan | null {
    if (!READ_ONLY_RESOURCE_TOOLS.has(toolName) || !MISSING_RESOURCE.test(resultError(result))) return null
    const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
    if (!requestedPath || requestedPath.includes('\0')) return null

    const absoluteRequested = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspaceRoot, requestedPath)
    const requestedParent = dirname(absoluteRequested)
    const searchRoot = isAbsolute(requestedPath)
        ? nearestExistingDirectory(requestedParent)
        : resolve(workspaceRoot)
    if (!searchRoot) return null

    const fileName = basename(requestedPath)
    if (!fileName || fileName === '.' || fileName === '..') return null
    return {
        requestedPath,
        searchRoot,
        searchArgs: {
            path: searchRoot,
            pattern: `*${extname(fileName) || ''}`,
            type: 'file',
            max_depth: 8,
        },
    }
}

function levenshtein(left: string, right: string): number {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let i = 1; i <= left.length; i++) {
        let diagonal = previous[0]
        previous[0] = i
        for (let j = 1; j <= right.length; j++) {
            const above = previous[j]
            previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
            diagonal = above
        }
    }
    return previous[right.length]
}

function similarity(left: string, right: string): number {
    const a = left.toLowerCase()
    const b = right.toLowerCase()
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1)
}

function candidatePaths(result: unknown): string[] {
    if (!result || typeof result !== 'object') return []
    const results = (result as { results?: unknown }).results
    if (!Array.isArray(results)) return []
    return [...new Set(results.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const path = (item as { path?: unknown }).path
        return typeof path === 'string' && path.trim() ? [path.trim()] : []
    }))]
}

/** Select only a unique, high-confidence file. Ambiguity deliberately produces
 * no candidate so the caller can ask one targeted question instead of guessing. */
export function selectMissingResourceCandidate(requestedPath: string, discoveryResult: unknown): MissingResourceCandidate | null {
    const requestedName = basename(requestedPath).toLowerCase()
    const paths = candidatePaths(discoveryResult)
    const exact = paths.filter(path => basename(path).toLowerCase() === requestedName)
    if (exact.length === 1) return { path: exact[0], confidence: 1, reason: 'exact-name' }
    if (exact.length > 1) return null

    const ranked = paths
        .map(path => ({ path, confidence: similarity(requestedName, basename(path)) }))
        .sort((a, b) => b.confidence - a.confidence)
    const best = ranked[0]
    const second = ranked[1]
    if (!best || best.confidence < 0.82 || (second && best.confidence - second.confidence < 0.08)) return null
    return { ...best, reason: 'fuzzy-name' }
}

export function discoveryContainsPath(result: unknown, path: string): boolean {
    const normalized = resolve(path).toLowerCase()
    return candidatePaths(result).some(candidate => resolve(candidate).toLowerCase() === normalized)
}

/** Execute the whole bounded recovery chain through the caller-provided,
 * already governed executor. Every step is independently verified by the same
 * ExecutionKernel; this helper grants no tools and bypasses no policy. */
export async function recoverMissingResource(input: {
    toolName: string
    args: Record<string, unknown>
    failedResult: unknown
    kernel: RecoveryKernel
    execute: (toolName: string, args: Record<string, unknown>, callId: string) => Promise<unknown>
    nextCallId: (toolName: string) => string
    workspaceRoot?: string
}): Promise<MissingResourceRecoveryResult> {
    const plan = planMissingResourceRecovery(input.toolName, input.args, input.failedResult, input.workspaceRoot)
    if (!plan || !input.kernel.contract.allowedChanges.allowedTools.includes('find_files')) {
        return { success: false, reason: 'not-applicable', executions: [] }
    }

    const executions: MissingResourceRecoveryExecution[] = []
    const discoveryCallId = input.nextCallId('find_files')
    const discovery = await input.execute('find_files', plan.searchArgs, discoveryCallId)
    const discoveryVerification = input.kernel.verify('find_files', discovery, {
        callId: discoveryCallId,
        arguments: plan.searchArgs,
    })
    executions.push({ callId: discoveryCallId, toolName: 'find_files', args: plan.searchArgs, result: discovery, success: discoveryVerification.success })
    if (!discoveryVerification.success) return { success: false, requestedPath: plan.requestedPath, reason: 'unverified-discovery', executions }

    const candidate = selectMissingResourceCandidate(plan.requestedPath, discovery)
    if (!candidate || !input.kernel.registerResolvedTarget({
        requested: plan.requestedPath,
        resolved: candidate.path,
        discoveryCallId,
        discoveryResult: discovery,
    })) return { success: false, requestedPath: plan.requestedPath, reason: 'ambiguous-or-missing', executions }

    const retryArgs = { ...input.args, path: candidate.path }
    const retryCallId = input.nextCallId(input.toolName)
    const retried = await input.execute(input.toolName, retryArgs, retryCallId)
    const retryVerification = input.kernel.verify(input.toolName, retried, {
        callId: retryCallId,
        arguments: retryArgs,
    })
    executions.push({ callId: retryCallId, toolName: input.toolName, args: retryArgs, result: retried, success: retryVerification.success })
    return {
        success: retryVerification.success,
        requestedPath: plan.requestedPath,
        resolvedPath: candidate.path,
        reason: retryVerification.success ? candidate.reason : 'unverified-retry',
        executions,
        result: retried,
    }
}
