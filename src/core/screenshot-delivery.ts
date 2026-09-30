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
