const FAILURE_TEXT = /^(?:❌|error\b|fehler\b)|(?:fehlgeschlagen|api[- ]?fehler|unauthorized|forbidden|scope fehlt|keine berechtigung|kein zugriff|not found|nicht gefunden)/i

export function isSuccessfulToolResult(result: unknown): boolean {
    if (result === null || result === undefined) return false
    if (typeof result === 'string') {
        const text = result.trim()
        return text.length > 0 && !FAILURE_TEXT.test(text)
    }
    if (typeof result === 'object') {
        const value = result as Record<string, unknown>
        if (value.success === false || value.error) return false
        return true
    }
    return true
}
