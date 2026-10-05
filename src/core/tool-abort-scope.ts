import { AsyncLocalStorage } from 'node:async_hooks'

// Process-local cancellation, not a tool argument or serializable authority.
const scope = new AsyncLocalStorage<AbortSignal | undefined>()
export function withToolAbortSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
    signal?.throwIfAborted()
    return scope.run(signal, run)
}
export function getToolAbortSignal(): AbortSignal | undefined { return scope.getStore() }

// Foreground discovery is partial and bounded, not a whole-network guarantee.
export const FOREGROUND_SCAN_MS = 60_000
export const DISCOVERY_TOOL_MS = 100_000
export const DISCOVERY_REQUEST_MS = 120_000
