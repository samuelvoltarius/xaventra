import { redactSecrets } from '../security/secret-redaction.js'
import { NODE_SCREENSHOT_LIMITATION } from './request-capabilities.js'

export interface ResponseToolExecution {
    toolName?: string
    name?: string
    success?: boolean
    result?: unknown
}

/** Preserve the verified inventory half of a mixed request, never catalog-only
 * output or the model's unsupported claim that captures were delivered. */
export function nodeScreenshotResponse(executions: ResponseToolExecution[]): string {
    const inventory = executions.filter(item => item.success === true
        && ['mesh_nodes', 'mesh_status', 'mesh_services'].includes(item.toolName || item.name || ''))
    const details = inventory.length ? verifiedToolEvidenceResponse(inventory)
        : 'Die Node-Fähigkeiten wurden in diesem Lauf noch nicht durch aktuelle Mesh-Werkzeuge verifiziert.'
    const capture = [...executions].reverse().find(item => (item.toolName || item.name) === 'mesh_screenshot')
    let result = capture?.result
    if (typeof result === 'string') { try { result = JSON.parse(result) } catch { /* policy denial remains text */ } }
    const rows = result && typeof result === 'object' && Array.isArray((result as any).captures) ? (result as any).captures.slice(0, 16) : []
    const receipts = rows.map((row: any) => `${safeResult(row.nodeId, 100)}: ${row.captured === true ? 'Bild aufgenommen' : 'kein Bild aufgenommen'}; ${row.delivered === true ? 'Bildzustellung bestätigt' : 'keine Bildzustellung bestätigt'}${row.error ? ` — ${safeResult(row.error, 400)}` : ''}`).join('\n')
    return `${details}\n\n${receipts || (capture ? `${NODE_SCREENSHOT_LIMITATION}\n${safeResult(result, 600)}` : NODE_SCREENSHOT_LIMITATION)}`
}

const AUTHORITATIVE_DIAGNOSTIC_TOOLS = new Set([
    'self_setup_status', 'self_setup_plan', 'self_setup_research',
    'research_capability_plan', 'research_all_capabilities',
])

/** Only actual capture-tool failures, never model prose or unrelated diagnostics.
 * Keep the failure visible without turning it into authority or claiming delivery. */
export function screenshotFailureResponse(executions: ResponseToolExecution[]): string {
    const failed = [...executions].reverse().find(item =>
        item.success === false && (item.toolName || item.name) === 'desktop_screenshot')
    const result = failed?.result
    const detail = typeof result === 'string' ? result
        : result && typeof result === 'object' && typeof (result as any).error === 'string'
            ? (result as any).error : ''
    const reason = safeResult(detail, 700)
    return reason
        ? `Der Screenshot-Auftrag ist fehlgeschlagen oder wurde gesperrt. Technischer Grund:\n${reason}\nEs wurde keine Bilddatei übertragen.`
        : 'Ich konnte den Screenshot nicht zuverlässig erstellen oder senden. Es wurde keine Bilddatei übertragen.'
}

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
            for (const key of ['title', 'url', 'snippet', 'text', 'content', 'formatted', 'summary', 'output', 'results', 'error']) {
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

/** Current, verified read-only results already contain the human-facing report.
 * No model synthesis or second opinion is required to deliver these facts. */
export function environmentOverviewResponse(executions: ResponseToolExecution[]): string {
    const results = ['environment_inventory', 'mesh_status'].map(name => {
        const execution = [...executions].reverse().find(e => (e.toolName || e.name) === name)
        if (!execution || execution.success !== true) return `${name}: in diesem Lauf nicht erfolgreich verifiziert.`
        let value = execution.result
        if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* formatted text */ } }
        const text = value && typeof value === 'object' && typeof (value as any).formatted === 'string'
            ? (value as any).formatted : value
        return safeResult(text, name === 'environment_inventory' ? 15500 : 4000) || `${name}: kein inhaltliches Ergebnis.`
    })
    return results.join('\n\n') + '\n\nMesh-Verbindung und beobachtete Dienste sind keine allgemeine Steuerfreigabe. Konkrete Aktionen benötigen passende freigegebene Werkzeuge; Erreichbarkeit weiterer Dienste wurde hier nicht aktiv getestet.'
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
