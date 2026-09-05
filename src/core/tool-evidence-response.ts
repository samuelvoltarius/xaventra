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
