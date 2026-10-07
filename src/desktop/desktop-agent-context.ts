import { AsyncLocalStorage } from 'node:async_hooks'

export interface DesktopAgentContext {
    principalId: string
    clientId: string
    authorizationUserId: string
    roomId: string
    botId: string
    preferredNodeIds: string[]
    modelMode: 'auto' | 'pinned'
    pinnedModel?: string
    pinnedProvider?: string
    pinnedNodeId?: string
    pinnedEndpoint?: string
    workspaceId?: string
    memoryAssetIds?: string[]
    onOutcome?: (outcome: DesktopAgentOutcome) => void
    /** 2.89.1: side sink for progress lines of this run (never part of the answer). */
    onProgress?: (status: string) => void
    abortSignal?: AbortSignal
}

export interface DesktopAgentOutcome {
    runId?: string
    model?: string
    node?: string
    durationMs: number
    tools: Array<{ name: string; success: boolean }>
    verifiedEvidence: number
    action?: { requiresTool: boolean; kind: string; fulfilled: boolean; awaitingApproval: boolean; phase: string }
    /** 2.89: routing/status notices of this run — shown with the run, never inside the answer text. */
    notices?: string[]
}

const storage = new AsyncLocalStorage<DesktopAgentContext>()

export function runWithDesktopAgentContext<T>(context: DesktopAgentContext, operation: () => T): T {
    // The outcome callback is process-local and never crosses IPC. Keep the
    // original closure in AsyncLocalStorage; getDesktopAgentContext below
    // deliberately projects only serializable authority fields.
    return storage.run(context, operation)
}

export function getDesktopAgentContext(): DesktopAgentContext | undefined {
    const value = storage.getStore()
    if (!value) return undefined
    const { onOutcome: _onOutcome, onProgress: _onProgress, abortSignal: _abortSignal, ...serializable } = value
    return structuredClone(serializable)
}

export function getDesktopAbortSignal(): AbortSignal | undefined { return storage.getStore()?.abortSignal }

export function getDesktopProgressSink(): ((status: string) => void) | undefined { return storage.getStore()?.onProgress }

export function publishDesktopAgentOutcome(outcome: DesktopAgentOutcome): void {
    storage.getStore()?.onOutcome?.(structuredClone(outcome))
}
