import { redactSecrets } from '../security/secret-redaction.js'

export interface ResponseToolExecution {
    toolName?: string
    name?: string
    success?: boolean
    result?: unknown
}

const AUTHORITATIVE_DIAGNOSTIC_TOOLS = new Set([
    'self_setup_status', 'self_setup_plan', 'self_setup_research',
    'research_capability_plan', 'research_all_capabilities',
])

/** A fallback after exhausted synthesis is partial evidence, never task success.
 * Retain source-bearing observations; acknowledgements are not findings. */
export function incompleteToolResponse(results: string[]): string {
    const observations: string[] = []
    const collect = (value: unknown, depth = 0): void => {
        if (depth > 4 || observations.length >= 12) return
        if (typeof value === 'string') {
            const text = redactSecrets(value).trim()
            if (text && !/^(?:✅\s*)?(?:erfolgreich!?|success!?|ok|done)$/i.test(text)) observations.push(text.slice(0, 1800))
        } else if (Array.isArray(value)) {
            value.slice(0, 8).forEach(item => collect(item, depth + 1))
        } else if (value && typeof value === 'object') {
            const item = value as Record<string, unknown>
            for (const key of ['title', 'url', 'snippet', 'text', 'content', 'summary', 'output', 'results', 'error']) {
                if (item[key] !== undefined) collect(item[key], depth + 1)
            }
        }
    }
    for (const result of results) {
        try { collect(JSON.parse(result)) } catch { collect(result) }
    }
    const details = [...new Set(observations)].join('\n\n').slice(0, 6000)
    return details
        ? `Die Aufgabe ist noch nicht vollständig ausgewertet. Bisherige Tool-Beobachtungen (keine abschließende Antwort):\n\n${details}`
        : 'Die Aufgabe ist nicht abgeschlossen: Es liegen keine verwertbaren inhaltlichen Ergebnisse vor. Eine technische Erfolgsbestätigung allein reicht dafür nicht.'
}

function safeResult(value: unknown, limit = 4_000): string {
    let rendered = ''
    if (typeof value === 'string') rendered = value
    else {
        try { rendered = JSON.stringify(value, null, 2) }
        catch { rendered = String(value ?? '') }
    }
    return redactSecrets(rendered).replace(/\r\n/g, '\n').trim().slice(0, limit)
}

/** Diagnostic formatters already return user-facing truth. For these tools the
 * model may not reinterpret the output into additional missing capabilities. */
export function authoritativeDiagnosticResponse(executions: ResponseToolExecution[]): string | null {
    const execution = [...executions].reverse().find(item => {
        const name = String(item.toolName || item.name || '')
        return item.success === true && AUTHORITATIVE_DIAGNOSTIC_TOOLS.has(name)
    })
    if (!execution) return null
    return safeResult(execution.result) || null
}

/** Fail-closed fallback used when L12 detects that prose contradicts Tool
 * Evidence. It contains only verified tool names and redacted actual results. */
export function verifiedToolEvidenceResponse(executions: ResponseToolExecution[]): string {
    const successful = executions.filter(item => item.success === true)
    if (successful.length === 0) return 'Es liegt kein verifiziertes Tool-Ergebnis vor.'
    return successful.slice(-4).map(item => {
        const name = String(item.toolName || item.name || 'tool')
        const result = safeResult(item.result, 1_200)
        return result ? `${name}:\n${result}` : `${name}: erfolgreich verifiziert`
    }).join('\n\n')
}
