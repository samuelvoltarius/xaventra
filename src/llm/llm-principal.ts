import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who a message's LLM calls work for (decided 30.09.: Codex is Alfred's own
 * subscription and only runs for the owner). The pipeline opens a scope per
 * message and fills in the permission once authentication has decided it.
 * Work outside any message scope (autonomy, heartbeat) runs for the owner.
 */
const scope = new AsyncLocalStorage<{ permission?: string }>()

export function runWithLlmPrincipal<T>(work: () => T): T {
    return scope.run({}, work)
}

export function setLlmPrincipalPermission(permission: string | undefined): void {
    const current = scope.getStore()
    if (current) current.permission = permission
}

/** Inside a message scope only the owner may use Codex; unknown role = no. */
export function mayUseCodex(): boolean {
    const current = scope.getStore()
    return !current || current.permission === 'owner'
}

/** Role for routing decisions: owner outside any message scope (autonomy,
 * heartbeat), otherwise the authenticated permission or undefined. */
export function currentLlmPermission(): string | undefined {
    const current = scope.getStore()
    return current ? current.permission : 'owner'
}
