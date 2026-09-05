import { createHash } from 'node:crypto'
import { getLifecyclePolicy } from './lifecycle-policy.js'

export interface ToolGuardContext {
    toolName: string
    input: Readonly<Record<string, unknown>>
}

export interface ToolGuardDecision {
    decision: 'deny' | 'abstain'
    reason?: string
}

export interface ToolGuard {
    id: string
    priority?: number
    check(context: ToolGuardContext): ToolGuardDecision | Promise<ToolGuardDecision>
}

export interface ToolPreflightResult {
    decision: 'allow' | 'deny' | 'ask'
    reason?: string
    input: Record<string, unknown>
    guards: string[]
}

export interface FinalToolOutcome {
    toolName: string
    success: boolean
    input: Readonly<Record<string, unknown>>
    output: unknown
    hash: string
    verifiedAt: string
}

function immutableCopy(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value === null || typeof value !== 'object') return value
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value
    if (seen.has(value as object)) return '[circular]'
    if (Array.isArray(value)) {
        const copy: unknown[] = []
        seen.set(value, copy)
        for (const item of value) copy.push(immutableCopy(item, seen))
        return Object.freeze(copy)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const copy: Record<string, unknown> = {}
    seen.set(value as object, copy)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = immutableCopy(item, seen)
    return Object.freeze(copy)
}

function digest(value: unknown): string {
    try { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
    catch { return createHash('sha256').update(String(value)).digest('hex') }
}

export class ToolExecutionPipeline {
    private readonly guards = new Map<string, ToolGuard>()
    private readonly observers = new Set<(outcome: FinalToolOutcome) => void | Promise<void>>()

    registerGuard(guard: ToolGuard): () => void {
        if (this.guards.has(guard.id)) throw new Error(`Tool guard already registered: ${guard.id}`)
        this.guards.set(guard.id, guard)
        return () => this.guards.delete(guard.id)
    }

    observeFinal(observer: (outcome: FinalToolOutcome) => void | Promise<void>): () => void {
        this.observers.add(observer)
        return () => this.observers.delete(observer)
    }

    listGuards(): Array<{ id: string; priority: number }> {
        return [...this.guards.values()]
            .map(guard => ({ id: guard.id, priority: guard.priority ?? 100 }))
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    }

    async preflight(toolName: string, input: Record<string, unknown>): Promise<ToolPreflightResult> {
        const lifecycle = await getLifecyclePolicy().run('tool.before', { toolName, input })
        const rewritten = lifecycle.payload.input || input
        if (lifecycle.decision !== 'allow') {
            return { decision: lifecycle.decision, reason: lifecycle.reason, input: rewritten, guards: [] }
        }

        const guards: string[] = []
        const context = Object.freeze({ toolName, input: immutableCopy(rewritten) as Readonly<Record<string, unknown>> })
        const ordered = [...this.guards.values()].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id))
        for (const guard of ordered) {
            guards.push(guard.id)
            const decision = await guard.check(context)
            // Guards are monotonic: they may deny or abstain, never turn a
            // previous denial into permission and never rewrite identity/input.
            if (decision.decision === 'deny') {
                return { decision: 'deny', reason: decision.reason || `Tool guard ${guard.id} denied execution`, input: rewritten, guards }
            }
        }
        return { decision: 'allow', input: rewritten, guards }
    }

    async postprocess(toolName: string, input: Record<string, unknown>, output: unknown, success: boolean): Promise<unknown> {
        const result = await getLifecyclePolicy().run(success ? 'tool.after' : 'tool.failure', {
            toolName,
            input,
            output,
            error: success ? undefined : String((output as any)?.error || 'tool reported failure'),
        })
        return result.payload.output
    }

    finalize(toolName: string, input: Record<string, unknown>, output: unknown, success: boolean): unknown {
        const frozenInput = immutableCopy(input) as Readonly<Record<string, unknown>>
        const frozenOutput = immutableCopy(output)
        const outcome: FinalToolOutcome = Object.freeze({
            toolName,
            success,
            input: frozenInput,
            output: frozenOutput,
            hash: digest({ toolName, success, input: frozenInput, output: frozenOutput }),
            verifiedAt: new Date().toISOString(),
        })
        for (const observer of this.observers) void Promise.resolve(observer(outcome)).catch(() => undefined)
        return frozenOutput
    }
}

let pipeline: ToolExecutionPipeline | null = null
export function getToolExecutionPipeline(): ToolExecutionPipeline { return pipeline ||= new ToolExecutionPipeline() }
export function setToolExecutionPipelineForTests(value: ToolExecutionPipeline | null): void { pipeline = value }
