import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type LifecycleEvent =
    | 'session.start'
    | 'session.end'
    | 'message.before'
    | 'message.after'
    | 'llm.before'
    | 'llm.after'
    | 'tool.before'
    | 'tool.after'
    | 'tool.failure'
    | 'approval.request'
    | 'checkpoint.before'
    | 'checkpoint.after'
    | 'error'

export interface ExecutionPolicyContext {
    runId?: string
    userId?: string
    channel?: string
    nodeId?: string
    approvalGranted?: boolean
    workspaceId?: string
}

export interface LifecyclePayload {
    event: LifecycleEvent
    context: ExecutionPolicyContext
    toolName?: string
    input?: Record<string, unknown>
    output?: unknown
    error?: string
    metadata?: Record<string, unknown>
}

export interface LifecycleDecision {
    decision?: 'allow' | 'deny' | 'ask'
    reason?: string
    updatedInput?: Record<string, unknown>
    updatedOutput?: unknown
    additionalContext?: string
}

export interface LifecycleHook {
    id: string
    event: LifecycleEvent
    priority: number
    timeoutMs: number
    failClosed: boolean
    handler(payload: Readonly<LifecyclePayload>): Promise<LifecycleDecision | void> | LifecycleDecision | void
}

export interface LifecycleResult extends LifecycleDecision {
    payload: LifecyclePayload
    hookIds: string[]
}

const contextStore = new AsyncLocalStorage<ExecutionPolicyContext>()

export function withExecutionPolicyContext<T>(context: ExecutionPolicyContext, work: () => T): T {
    return contextStore.run(Object.freeze({ ...context }), work)
}

export function getExecutionPolicyContext(): ExecutionPolicyContext {
    return contextStore.getStore() || {}
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        if (timer.unref) timer.unref()
        promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
}

export class LifecyclePolicy {
    private readonly hooks = new Map<LifecycleEvent, LifecycleHook[]>()

    constructor(private readonly auditFile = join(process.cwd(), '.nova-data', 'lifecycle-audit.jsonl')) {}

    register(hook: Omit<LifecycleHook, 'priority' | 'timeoutMs' | 'failClosed'> & Partial<Pick<LifecycleHook, 'priority' | 'timeoutMs' | 'failClosed'>>): () => void {
        const normalized: LifecycleHook = {
            ...hook,
            priority: hook.priority ?? 100,
            timeoutMs: Math.max(50, hook.timeoutMs ?? 5_000),
            failClosed: hook.failClosed ?? hook.event === 'tool.before',
        }
        const list = this.hooks.get(normalized.event) || []
        if (list.some(existing => existing.id === normalized.id)) throw new Error(`Lifecycle hook already registered: ${normalized.id}`)
        list.push(normalized)
        list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
        this.hooks.set(normalized.event, list)
        return () => this.unregister(normalized.event, normalized.id)
    }

    unregister(event: LifecycleEvent, id: string): void {
        this.hooks.set(event, (this.hooks.get(event) || []).filter(hook => hook.id !== id))
    }

    list(): Array<Omit<LifecycleHook, 'handler'>> {
        return [...this.hooks.values()].flat().map(({ handler: _handler, ...hook }) => hook)
    }

    async run(event: LifecycleEvent, partial: Omit<LifecyclePayload, 'event' | 'context'> & { context?: ExecutionPolicyContext } = {}): Promise<LifecycleResult> {
        let payload: LifecyclePayload = {
            ...partial,
            event,
            context: { ...getExecutionPolicyContext(), ...(partial.context || {}) },
        }
        const result: LifecycleResult = { payload, hookIds: [] }
        for (const hook of this.hooks.get(event) || []) {
            result.hookIds.push(hook.id)
            try {
                const decision = await timeout(Promise.resolve(hook.handler(Object.freeze({ ...payload, context: Object.freeze({ ...payload.context }) }))), hook.timeoutMs, hook.id)
                if (!decision) continue
                if (decision.updatedInput) payload = { ...payload, input: { ...decision.updatedInput } }
                if (Object.prototype.hasOwnProperty.call(decision, 'updatedOutput')) payload = { ...payload, output: decision.updatedOutput }
                if (decision.additionalContext) result.additionalContext = [result.additionalContext, decision.additionalContext].filter(Boolean).join('\n')
                if (decision.decision === 'deny' || decision.decision === 'ask') {
                    result.decision = decision.decision
                    result.reason = decision.reason || `Lifecycle hook ${hook.id} returned ${decision.decision}`
                    break
                }
                if (decision.decision === 'allow') result.decision = 'allow'
            } catch (error) {
                this.audit({ id: randomUUID(), event, hookId: hook.id, success: false, error: String(error), payload })
                if (hook.failClosed) {
                    result.decision = 'deny'
                    result.reason = `Policy hook ${hook.id} failed closed: ${error instanceof Error ? error.message : String(error)}`
                    break
                }
            }
        }
        result.payload = payload
        result.decision ||= 'allow'
        this.audit({ id: randomUUID(), event, success: result.decision === 'allow', decision: result.decision, reason: result.reason, hookIds: result.hookIds, payload })
        return result
    }

    private audit(entry: Record<string, unknown>): void {
        try {
            if (!existsSync(dirname(this.auditFile))) mkdirSync(dirname(this.auditFile), { recursive: true })
            appendFileSync(this.auditFile, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`)
        } catch { /* policy decisions must not depend on telemetry storage */ }
    }
}

let singleton: LifecyclePolicy | null = null
export function getLifecyclePolicy(): LifecyclePolicy {
    return singleton ||= new LifecyclePolicy()
}

export function setLifecyclePolicyForTests(policy: LifecyclePolicy | null): void {
    singleton = policy
}
