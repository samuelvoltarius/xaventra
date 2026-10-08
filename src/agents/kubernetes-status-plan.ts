/**
 * 2.89.4 (live): Kubernetes/Pod/Cluster questions made the model search the
 * machine with SSH/run_command (kubectl-style) and invent node/pod names. A
 * plain status question now starts with cluster_status; its API result is the
 * only source of node/pod facts. No SSH fallback — configured or not. Without
 * a Kubernetes access the answer is honest: „nicht konfiguriert“.
 */
import { isKubernetesQuestion, isKubernetesStatusQuestion } from '../core/request-capabilities.js'
import { redactSecrets } from '../security/secret-redaction.js'

export const K8S_NO_SSH_HINT = 'Kubernetes-Fakten kommen nur aus cluster_status (Kubernetes-API). Kein SSH, kein kubectl, keine Shell-Suche. Ohne konfigurierten Kubernetes-Zugang antworte ehrlich „nicht konfiguriert“.'

/** Shell/SSH never discover cluster facts (configured or not). */
export const K8S_SHELL_TOOLS: ReadonlySet<string> = new Set(['run_command', 'execute_command', 'shell', 'exec_command', 'ssh_command', 'system_executor'])

export function isK8sShellFallback(toolName: string): boolean {
    return K8S_SHELL_TOOLS.has(toolName)
}

export function kubernetesStatusPlan(input: {
    content: string; permission: string; internal: boolean; hasImage: boolean
    constrained: boolean; tools: readonly { name: string }[]
}): Array<{ name: string; arguments: Record<string, unknown> }> | null {
    const text = String(input.content || '').trim()
    if (input.permission !== 'owner' || input.internal || input.hasImage || input.constrained) return null
    if (!text || text.length > 200 || !isKubernetesStatusQuestion(text)) return null
    if (!input.tools.some(tool => tool.name === 'cluster_status')) return null
    return [{ name: 'cluster_status', arguments: {} }]
}

export interface ClusterStatusExecution {
    toolName?: string
    name?: string
    success?: boolean
    result?: unknown
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

/**
 * Node/pod facts only from the cluster_status tool result. Never a model
 * paraphrase, never mesh peers, never a shell probe.
 */
export function kubernetesStatusResponse(executions: readonly ClusterStatusExecution[]): string {
    const execution = [...executions].reverse().find(item =>
        (item.toolName || item.name) === 'cluster_status' && item.success !== false)
    if (!execution) return 'Kubernetes: in diesem Lauf kein verifiziertes Status-Ergebnis. Ich erfinde keine Node- oder Pod-Angaben.'
    let value = execution.result
    if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* formatted text */ } }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.configured === false) {
            const message = typeof record.message === 'string' ? record.message : ''
            return /nicht konfiguriert/i.test(message) ? message : `Kubernetes ist nicht konfiguriert${message ? ` — ${message}` : ''}.`
        }
        if (typeof record.formatted === 'string' && record.formatted.trim()) return safeResult(record.formatted, 6_000)
        if (typeof record.message === 'string' && record.message.trim()) return safeResult(record.message, 6_000)
    }
    return safeResult(value, 6_000) || 'Kubernetes: kein inhaltliches Ergebnis.'
}

export { isKubernetesQuestion, isKubernetesStatusQuestion }
