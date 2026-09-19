import type { TaskBudget } from './task-contract.js'
import { normalizeTokenUsage } from '../llm/token-usage.js'

/** Per-run accounting, never shared by users or installed on a global client.
 * Providers may omit usage or throw after consuming tokens: retain the reserved
 * allowance as an estimate, not a fabricated measured zero. Hidden retries inside
 * a provider are not independently observable here. Existing provider failover
 * policy is preserved; this wrapper must not silently disable healthy alternatives.
 */
export class InferenceBudget {
    private input = 0
    private output = 0
    private total = 0
    private calls = 0
    private estimated = false
    private pending = false
    private stopped = false
    private clients = new WeakMap<object, any>()

    constructor(private readonly budget: TaskBudget) {}

    snapshot() {
        return { inputTokens: this.input, outputTokens: this.output, totalTokens: this.total,
            calls: this.calls, estimated: this.estimated || this.pending, stopped: this.stopped || this.pending }
    }

    evidence() {
        return { tokens: this.total, outputTokens: this.output, inferenceStopped: this.stopped || this.pending }
    }

    assertCanExecute(): void {
        if (this.stopped || this.pending
            || this.total > (this.budget.maxTokens ?? Infinity)
            || this.output > (this.budget.maxOutputTokens ?? Infinity)) {
            throw new Error('Inference budget stopped this run; no further tools may execute')
        }
    }

    /** Proxy only completion, preserving getters/private receivers on the client. */
    wrap<T extends object>(client: T): T {
        const previous = this.clients.get(client)
        if (previous) return previous
        const wrapped = new Proxy(client, { get: (target, key) => {
            if (key === 'complete') return (messages: any[], tools?: any[], options?: any) =>
                this.complete(target, messages, tools, options)
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
        } })
        this.clients.set(client, wrapped)
        this.clients.set(wrapped, wrapped)
        return wrapped
    }

    private async complete(client: any, messages: any[], tools: any[] = [], options: any = {}) {
        this.assertCanExecute()
        // Conservative reservation for textual prompts, tool schemas and framing.
        // Actual provider usage replaces it after a measured response. This is not
        // a tokenizer or a claim about exact multimodal/provider-internal usage.
        const promptBound = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8')
            + messages.length * 64 + 1024
        const maxTokens = Math.floor(Math.min(options.maxTokens ?? 8192,
            (this.budget.maxOutputTokens ?? Infinity) - this.output,
            (this.budget.maxTokens ?? Infinity) - this.total - promptBound))
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
            this.stopped = true
            throw new Error('Inference token budget exhausted before model call')
        }
        this.pending = true
        this.calls++
        this.input += promptBound
        this.output += maxTokens
        this.total += promptBound + maxTokens
        let measured = false
        try {
            const response = await client.complete(messages, tools, { ...options, maxTokens })
            const usage = normalizeTokenUsage(response?.usage?.promptTokens ?? response?.usage?.inputTokens,
                response?.usage?.completionTokens ?? response?.usage?.outputTokens, response?.usage?.totalTokens)
            if (usage) {
                this.input += usage.promptTokens - promptBound
                this.output += usage.completionTokens - maxTokens
                this.total += usage.totalTokens - promptBound - maxTokens
                measured = true
                // A non-compliant provider must not authorize effects from its reply.
                if (usage.completionTokens > maxTokens || this.total > (this.budget.maxTokens ?? Infinity)) {
                    this.stopped = true
                    throw new Error('Provider exceeded the admitted inference budget')
                }
            }
            return response
        } catch (error) {
            this.stopped = true
            throw error
        } finally {
            if (!measured) {
                this.estimated = true
            }
            this.pending = false
        }
    }
}
