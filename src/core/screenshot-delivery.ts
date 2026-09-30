/**
 * Whether the pipeline still has to send a run's screenshot to the chat.
 *
 * Live 30.09.2026 every screenshot reached Telegram twice (desktop_screenshot
 * had already sent it) and a follow-up question without any capture got the
 * previous picture a third time (the runner picked the newest file < 30 s old).
 * Only a screenshot produced in this run and not yet delivered is sent.
 */
export function pendingScreenshot(result: { screenshotPath?: unknown; screenshotDelivered?: unknown } | null | undefined): string | null {
    if (!result || typeof result.screenshotPath !== 'string' || !result.screenshotPath) return null
    if (result.screenshotDelivered === true) return null
    return result.screenshotPath
}

interface FallbackRun {
    toolsExecuted?: string[]
    toolExecutions?: Array<{ toolName?: string; tool?: string; success?: boolean }>
    screenshotPath?: unknown
    actionState?: { fulfilled?: boolean; phase?: string; [key: string]: unknown }
}

/**
 * Whether the deterministic screenshot fallback has to act. Only a delivered
 * picture or a successful desktop_screenshot of this run (sent by the normal
 * delivery) makes it unnecessary; other tools do not matter. Live 01.10.2026
 * introspection before the capture counted as "tools executed" and the
 * failed discovery set actionState, so the old condition never fired.
 */
export function shouldRunScreenshotFallback(input: { isSystemMessage: boolean; intentKind: string; screenshotDelivered: boolean; result: FallbackRun | null | undefined }): boolean {
    if (input.isSystemMessage || input.intentKind !== 'screenshot' || input.screenshotDelivered) return false
    const result = input.result || {}
    if (typeof result.screenshotPath === 'string' && result.screenshotPath) return false
    return !(result.toolExecutions || []).some(execution => (execution.toolName || execution.tool) === 'desktop_screenshot' && execution.success === true)
}

/** Records a delivered fallback picture next to the run's earlier evidence. */
export function applyScreenshotFallback<T extends FallbackRun>(result: T, captured: { path: string; size?: number }): T & { screenshotPath: string; screenshotDelivered: true; toolsExecuted: string[]; toolExecutions: NonNullable<FallbackRun['toolExecutions']> } {
    const next = result as any
    next.screenshotPath = captured.path
    next.screenshotDelivered = true
    next.toolsExecuted = [...(result.toolsExecuted || []), 'desktop_screenshot']
    next.toolExecutions = [...(result.toolExecutions || []), {
        toolName: 'desktop_screenshot', success: true, result: { path: captured.path, size: captured.size }, timestamp: Date.now(),
    }]
    if (result.actionState) next.actionState = { ...result.actionState, fulfilled: true, phase: 'verify' }
    return next
}
