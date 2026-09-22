const EXPLICIT_FAILURE_PREFIX = /^(?:❌|error\b|fehler\b)/i
const FAILURE_SUMMARY = /(?:fehlgeschlagen|api[- ]?fehler|unauthorized|forbidden|scope fehlt|keine berechtigung|kein zugriff|not found|nicht gefunden)/i

function stringResultFailed(text: string): boolean {
    if (EXPLICIT_FAILURE_PREFIX.test(text)) return true

    // Tool handlers commonly return multi-line Markdown reports. A capability
    // description inside such a successful report may legitimately mention a
    // failure state (for example "nicht gefunden"). Only the summary line is
    // allowed to classify an otherwise unstructured string result as failed;
    // structured results continue to use their explicit success/error fields.
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || ''
    return FAILURE_SUMMARY.test(firstLine)
}

export function isSuccessfulToolResult(result: unknown): boolean {
    if (result === null || result === undefined) return false
    if (typeof result === 'string') {
        const text = result.trim()
        return text.length > 0 && !stringResultFailed(text)
    }
    if (typeof result === 'object') {
        const value = result as Record<string, unknown>
        if (value.success === false || value.error) return false
        return true
    }
    return true
}
