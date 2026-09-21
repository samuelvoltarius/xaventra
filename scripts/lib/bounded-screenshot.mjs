const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Capture package evidence without inheriting Playwright's short interaction
 * deadline. A single retry covers a transient compositor/font stall, while a
 * repeated failure remains terminal and is preserved by the caller's report.
 */
export async function captureEvidenceScreenshot(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const maxAttempts = options.maxAttempts ?? 2
  const retryDelayMs = options.retryDelayMs ?? 250
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('screenshot timeout must be positive')
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new Error('screenshot attempts must be 1 or 2')

  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.screenshot({
        path: options.path,
        type: 'jpeg',
        quality: 85,
        animations: 'disabled',
        timeout: timeoutMs,
      })
      return { attempts: attempt, timeoutMs }
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) break
      await (page.waitForTimeout?.(retryDelayMs) ?? pause(retryDelayMs))
    }
  }
  throw lastError
}
