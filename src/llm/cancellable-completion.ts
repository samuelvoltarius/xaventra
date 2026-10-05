import type { LLMCallOptions } from './nova-llm-sdk.js'

/** One call-wide deadline covers primary and every fallback. Never mutate a
 * shared client; retain a race for non-cooperative plugin clients. */
export function cancellableCompletion<T extends { complete: (...args: any[]) => Promise<any> }>(client: T, parent: AbortSignal | undefined, timeoutMs: number): T {
    let stopped = false
    let stopReason: unknown
    return new Proxy(client, {
        get(target, key) {
            if (key !== 'complete') {
                const value = Reflect.get(target, key, target)
                return typeof value === 'function' ? value.bind(target) : value
            }
            return async (messages: any[], tools?: any[], options: LLMCallOptions = {}) => {
                if (stopped) throw stopReason
                const controller = new AbortController()
                const sources = [parent, options.signal].filter(Boolean) as AbortSignal[]
                const abort = () => controller.abort(sources.find(source => source.aborted)?.reason)
                for (const source of sources) source.addEventListener('abort', abort, { once: true })
                if (sources.some(source => source.aborted)) abort()
                const timer = setTimeout(() => controller.abort(new Error('Timeout: model request exceeded deadline')), options.timeoutMs ?? timeoutMs)
                let rejectAbort: (() => void) | undefined
                try {
                    controller.signal.throwIfAborted()
                    const stopped = new Promise<never>((_, reject) => {
                        rejectAbort = () => reject(controller.signal.reason)
                        controller.signal.addEventListener('abort', rejectAbort, { once: true })
                    })
                    const result = await Promise.race([target.complete(messages, tools, { ...options, signal: controller.signal }), stopped])
                    controller.signal.throwIfAborted()
                    return result
                } catch (error) {
                    // Planning/format-repair callers may catch this exception.
                    // Their next round must not resurrect the stopped run.
                    if (controller.signal.aborted) {
                        stopped = true; stopReason = controller.signal.reason
                    }
                    throw error
                } finally {
                    clearTimeout(timer)
                    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
                    for (const source of sources) source.removeEventListener('abort', abort)
                }
            }
        },
    })
}
