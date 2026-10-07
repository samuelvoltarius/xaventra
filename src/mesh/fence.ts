/**
 * CL-07 fencing: the local fence state and the one guard for every effect.
 *
 * leader-election.ts owns the lease protocol (acquire, renew, release) and
 * reports here synchronously when a lease is adopted or lost. Every effect
 * boundary (tools, channel senders, REST, updater, scheduler, ...) asks this
 * module before it acts:
 *
 *   await assertFenced('nova-main', { live: true, effect: 'tool:run_command' })
 *
 * NOVA_FENCING_MODE=observe (default) only records violations; `enforce`
 * throws FenceError. `fenceSignal(service)` aborts in-flight work the moment
 * the lease is lost (enforce) so a paused or partitioned old Main cannot
 * finish effects after a takeover.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { recordMainRole } from '../infra/telemetry.js'

export type FencingMode = 'observe' | 'enforce'
export const FENCE_MAIN_SERVICE = 'nova-main'

export interface HeldFence {
    service: string
    epoch: number
    token: string
    /** emergency = owner-confirmed emergency Main (2.88 succession, no majority). */
    coordinator: 'local' | 'supabase' | 'witness' | 'emergency'
    nodeId: string
    instanceId: string
    /** performance.now() deadline; undefined = no expiry (single-node). */
    deadlineMono?: number
    /** Set after an event-loop gap: a live check is mandatory until the next renewal. */
    suspect: boolean
}

/** Fence carried by a delegated mesh request (tool.request / agent.request). */
export interface DelegatedFence {
    service: string
    epoch: number
    token: string
    sourceNode: string
}

export class FenceError extends Error {
    readonly code = 'FENCED'
    constructor(readonly service: string, readonly reason: string, readonly effect?: string) {
        super(`Fenced${effect ? ` (${effect})` : ''}: no valid ${service} authority on this node (${reason})`)
        this.name = 'FenceError'
    }
}

export function isFenceError(error: unknown): error is FenceError {
    return error instanceof FenceError || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'FENCED')
}

export function monoNow(): number {
    return performance.now()
}

export function getFencingMode(env: NodeJS.ProcessEnv = process.env): FencingMode {
    return String(env.NOVA_FENCING_MODE || 'observe').trim().toLowerCase() === 'enforce' ? 'enforce' : 'observe'
}

const held = new Map<string, HeldFence>()
const controllers = new Map<string, AbortController>()
const delegated = new AsyncLocalStorage<DelegatedFence>()
const violationLog = new Map<string, number>()
const stats = { violations: 0, blocked: 0, aborted: 0, lastViolation: '' as string }
const VIOLATION_LOG_INTERVAL_MS = 60_000

// ---------------------------------------------------------------------------
// State API (called by leader-election.ts only)
// ---------------------------------------------------------------------------

/** Adopt a (re)newed lease. A changed epoch is a new term: in-flight work of
 * the old term is aborted before the new term becomes visible. */
export function adoptFence(fence: Omit<HeldFence, 'suspect'>): void {
    const previous = held.get(fence.service)
    if (previous && previous.epoch !== fence.epoch) abortController(fence.service, `term changed ${previous.epoch} -> ${fence.epoch}`)
    held.set(fence.service, { ...fence, suspect: false })
    if (!controllers.has(fence.service) || controllers.get(fence.service)!.signal.aborted) {
        controllers.set(fence.service, new AbortController())
    }
}

/** Synchronously fence this process for `service`: forget the token and abort
 * every operation that bound itself to fenceSignal(service). */
export function dropFence(service: string, reason: string): boolean {
    const wasHeld = held.delete(service)
    abortController(service, reason)
    return wasHeld
}

function abortController(service: string, reason: string): void {
    const controller = controllers.get(service)
    controllers.delete(service)
    if (controller && !controller.signal.aborted) {
        stats.aborted++
        controller.abort(new FenceError(service, reason))
    }
}

/** Mark held fences as suspect (event-loop gap, clock jump). */
export function markFenceSuspect(service?: string): string[] {
    const marked: string[] = []
    for (const fence of held.values()) {
        if (service && fence.service !== service) continue
        fence.suspect = true
        marked.push(fence.service)
    }
    return marked
}

/** Held fence whose monotonic deadline has not passed, else null. */
export function getHeldFence(service: string, now = monoNow()): HeldFence | null {
    const fence = held.get(service)
    if (!fence) return null
    if (fence.deadlineMono !== undefined && now >= fence.deadlineMono) return null
    return fence
}

export function hasValidFence(service: string = FENCE_MAIN_SERVICE): boolean {
    return getHeldFence(service) !== null
}

/** Test/diagnostic helper: forget every local fence. */
export function resetFenceStateForTests(): void {
    for (const service of [...held.keys()]) dropFence(service, 'reset')
    controllers.clear()
    violationLog.clear()
    stats.violations = 0; stats.blocked = 0; stats.aborted = 0; stats.lastViolation = ''
}

// ---------------------------------------------------------------------------
// Delegated fences (worker executes on behalf of the Main that sent it)
// ---------------------------------------------------------------------------

export function runWithDelegatedFence<T>(fence: DelegatedFence, fn: () => T): T {
    return delegated.run(fence, fn)
}

export function currentDelegatedFence(): DelegatedFence | undefined {
    return delegated.getStore()
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface FenceCheck { ok: boolean; reason: string; delegated?: boolean }

/** Never throws. `live` asks the coordinator with a read-only check. */
export async function checkFence(service: string = FENCE_MAIN_SERVICE, options: { live?: boolean } = {}): Promise<FenceCheck> {
    const via = delegated.getStore()
    if (via && via.service === service && !getHeldFence(service)) {
        try {
            const { checkDelegatedFence } = await import('./fence-highwater.js')
            const verdict = await checkDelegatedFence(via, { live: options.live === true })
            return { ...verdict, delegated: true }
        } catch (error) {
            return { ok: false, reason: `delegated fence check failed (${String(error).slice(0, 120)})`, delegated: true }
        }
    }
    const fence = held.get(service)
    if (!fence) return { ok: false, reason: 'no lease held by this process' }
    if (fence.deadlineMono !== undefined && monoNow() >= fence.deadlineMono) return { ok: false, reason: 'local lease deadline passed' }
    if (fence.coordinator === 'local') return { ok: true, reason: 'single-node lease' }
    if (!options.live && !fence.suspect) return { ok: true, reason: 'cached fence within deadline' }
    try {
        const { checkLiveFence } = await import('./leader-election.js')
        const live = await checkLiveFence(service)
        return live.valid ? { ok: true, reason: live.reason } : { ok: false, reason: live.reason }
    } catch (error) {
        return { ok: false, reason: `live fence check failed (${String(error).slice(0, 120)})` }
    }
}

function noteViolation(service: string, effect: string, reason: string, blocked: boolean): void {
    stats.violations++
    if (blocked) stats.blocked++
    stats.lastViolation = `${new Date().toISOString()} ${effect} ${service}: ${reason}`
    try { recordMainRole({ event: blocked ? 'fence.blocked' : 'fence.violation', service, leader: false }) } catch { /* telemetry optional */ }
    const key = `${effect}|${service}|${blocked}`
    const now = Date.now()
    const last = violationLog.get(key) || 0
    if (now - last < VIOLATION_LOG_INTERVAL_MS) return
    violationLog.set(key, now)
    console.warn(`[Fence] ${blocked ? 'BLOCKED' : 'observe: would block'} ${effect} — ${service}: ${reason}`)
}

/**
 * The guard for effects. enforce: throws FenceError. observe: records the
 * violation and returns. Returns the check so callers can log/branch.
 */
export async function assertFenced(
    service: string = FENCE_MAIN_SERVICE,
    options: { live?: boolean; effect?: string; mode?: FencingMode } = {},
): Promise<FenceCheck> {
    const check = await checkFence(service, options)
    if (check.ok) return check
    const mode = options.mode || getFencingMode()
    const effect = options.effect || 'effect'
    noteViolation(service, effect, check.reason, mode === 'enforce')
    if (mode === 'enforce') throw new FenceError(service, check.reason, effect)
    return check
}

/** Synchronous variant for hot paths without I/O (cache + monotonic deadline). */
export function assertFencedSync(service: string = FENCE_MAIN_SERVICE, effect = 'effect', mode: FencingMode = getFencingMode()): boolean {
    const via = delegated.getStore()
    if (via && via.service === service) return true
    if (getHeldFence(service)) return true
    noteViolation(service, effect, 'no valid cached fence', mode === 'enforce')
    if (mode === 'enforce') throw new FenceError(service, 'no valid cached fence', effect)
    return false
}

const neverAborts = new AbortController().signal

/**
 * AbortSignal that fires when this process loses `service`. In observe mode
 * the returned signal never aborts (loss is only logged by the lease layer);
 * in enforce mode a missing fence yields an already-aborted signal.
 */
export function fenceSignal(service: string = FENCE_MAIN_SERVICE, mode: FencingMode = getFencingMode()): AbortSignal {
    if (mode !== 'enforce') return neverAborts
    const via = delegated.getStore()
    if (via && via.service === service && !held.has(service)) return neverAborts
    const controller = getHeldFence(service) ? controllers.get(service) : undefined
    if (!controller) return AbortSignal.abort(new FenceError(service, 'no valid fence for signal'))
    return controller.signal
}

/** Combine a caller signal with the fence signal. */
export function withFenceSignal(signal: AbortSignal | undefined, service: string = FENCE_MAIN_SERVICE): AbortSignal {
    const fence = fenceSignal(service)
    if (fence === neverAborts) return signal || fence
    return signal ? AbortSignal.any([signal, fence]) : fence
}

/** Race an operation against lease loss; the operation should also receive
 * the signal so it can stop its own I/O and child processes. */
export async function runFenced<T>(service: string, effect: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = fenceSignal(service)
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new FenceError(service, 'lease lost', effect)
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason instanceof FenceError ? new FenceError(service, signal.reason.reason, effect) : new FenceError(service, 'lease lost', effect))
        signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
        return await Promise.race([operation(signal), aborted])
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
    }
}

/**
 * Tools that only read local state. Everything else counts as an effect and
 * is fenced (fail-safe: a new or unknown tool is fenced by default).
 */
export const FENCE_EXEMPT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'read_file', 'read_document', 'list_directory', 'codebase_search', 'code_search', 'find_files', 'code_outline',
    'mesh_status', 'mesh_nodes', 'nova_capabilities', 'nova_introspect', 'health_status',
    'find_capability', 'resolve_capability', 'list_sessions', 'mission_config',
    'list_reminders', 'list_sub_agents', 'nova_trace_stats', 'list_tool_policies',
    'environment_inventory', 'blue_asset_inventory', 'mesh_services',
])

export function toolRequiresFence(name: string): boolean {
    return !FENCE_EXEMPT_READ_ONLY_TOOLS.has(name)
}

/** Guard before a tool decision is committed (governed executors): live check. */
export async function guardToolEffect(name: string, options: { live?: boolean } = {}): Promise<void> {
    if (!toolRequiresFence(name)) return
    await assertFenced(FENCE_MAIN_SERVICE, { live: options.live !== false, effect: `tool:${name}` })
}

/** Registry-level guard for every tool handler: cached fence + abort on lease
 * loss while the handler runs (enforce). */
export async function runFencedTool<T>(name: string, handler: () => Promise<T>): Promise<T> {
    if (!toolRequiresFence(name)) return handler()
    await assertFenced(FENCE_MAIN_SERVICE, { effect: `tool:${name}` })
    return runFenced(FENCE_MAIN_SERVICE, `tool:${name}`, () => handler())
}

export function getFenceStatus(): {
    mode: FencingMode
    held: Array<{ service: string; epoch: number; coordinator: string; remainingMs: number | null; suspect: boolean }>
    violations: number
    blocked: number
    aborted: number
    lastViolation: string
} {
    const now = monoNow()
    return {
        mode: getFencingMode(),
        held: [...held.values()].map(fence => ({
            service: fence.service, epoch: fence.epoch, coordinator: fence.coordinator,
            remainingMs: fence.deadlineMono === undefined ? null : Math.round(fence.deadlineMono - now),
            suspect: fence.suspect,
        })),
        violations: stats.violations, blocked: stats.blocked, aborted: stats.aborted, lastViolation: stats.lastViolation,
    }
}
