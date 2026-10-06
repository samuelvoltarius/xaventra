/**
 * Kubernetes als Infrastruktur-Schicht (2.88, Paket P19): what a node knows
 * about Kubernetes without any API call.
 *
 * Grundsatz: Kubernetes decides WHERE a process runs; Xaventra decides WHAT
 * runs, with which model/tool and data, and whether an approval is needed.
 *
 * - `detectKubernetes` answers "do I run in a pod, which one, where?" from the
 *   environment (KUBERNETES_SERVICE_HOST + downward API variables the Helm
 *   chart sets) and the service-account namespace file. No network, no child
 *   process, no SSH/systemd assumptions.
 * - `suggestNodeLabels` turns a node strength profile into label SUGGESTIONS
 *   (`xaventra.ai/*`). It never labels anything: kubectl stays on the
 *   Nie-Liste (src/install/never-list.ts); the owner applies labels himself.
 */
import { readFileSync } from 'node:fs'
import type { NodeProfile } from '../core/node-profile.js'

export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
const NAMESPACE_FILE = `${SERVICE_ACCOUNT_DIR}/namespace`

/** DNS-1123 label (namespace, workload, release). */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** DNS-1123 subdomain (pod and node names). */
const DNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

export interface KubernetesInfo {
    inCluster: true
    namespace: string | null
    pod: string | null
    node: string | null
    /** Chart workload name (main, worker-general, voice, tool-sandbox, browser-computer). */
    workload: string | null
    release: string | null
    role: 'main' | 'worker' | null
}

const label = (value: unknown): string | null => {
    const text = String(value ?? '').trim()
    return DNS_LABEL.test(text) ? text : null
}
const subdomain = (value: unknown): string | null => {
    const text = String(value ?? '').trim()
    return text.length <= 253 && DNS_SUBDOMAIN.test(text) && !text.includes('..') ? text : null
}

/** In-cluster facts, or null when this process does not run in a pod. */
export function detectKubernetes(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = defaultRead): KubernetesInfo | null {
    if (!String(env.KUBERNETES_SERVICE_HOST || '').trim()) return null
    const namespace = label(env.XAVENTRA_POD_NAMESPACE) ?? label(safeRead(readFile, NAMESPACE_FILE))
    return {
        inCluster: true,
        namespace,
        pod: subdomain(env.XAVENTRA_POD_NAME) ?? subdomain(env.HOSTNAME),
        node: subdomain(env.XAVENTRA_K8S_NODE_NAME),
        workload: label(env.XAVENTRA_K8S_WORKLOAD),
        release: label(env.XAVENTRA_K8S_RELEASE),
        role: env.NOVA_NODE_ONLY === 'true' ? 'worker' : 'main',
    }
}

/** Bounds a peer-sent value (signed mesh data is still untrusted input). */
export function sanitizeKubernetesInfo(raw: unknown): KubernetesInfo | undefined {
    if (!raw || typeof raw !== 'object' || (raw as any).inCluster !== true) return undefined
    const value = raw as Record<string, unknown>
    return {
        inCluster: true,
        namespace: label(value.namespace), pod: subdomain(value.pod), node: subdomain(value.node),
        workload: label(value.workload), release: label(value.release),
        role: value.role === 'main' || value.role === 'worker' ? value.role : null,
    }
}

function defaultRead(path: string): string {
    try { return readFileSync(path, 'utf8') } catch { return '' }
}
function safeRead(readFile: (path: string) => string, path: string): string {
    try { return readFile(path) } catch { return '' }
}

// ---------------------------------------------------------------------------
// Node labels: convention + suggestions from the strength profile
// ---------------------------------------------------------------------------

export const NODE_LABEL_KEYS = Object.freeze([
    'xaventra.ai/gpu', 'xaventra.ai/gpu-class', 'xaventra.ai/memory', 'xaventra.ai/desktop', 'xaventra.ai/browser', 'xaventra.ai/general',
] as const)
export type NodeLabelKey = typeof NODE_LABEL_KEYS[number]
export type NodeLabels = Record<NodeLabelKey, string>

/** RAM classes; the chart's nodeSelector presets use the same words. */
export function memoryClass(ramGB: number): 'small' | 'medium' | 'large' | 'xlarge' {
    if (ramGB >= 128) return 'xlarge'
    if (ramGB >= 32) return 'large'
    if (ramGB >= 8) return 'medium'
    return 'small'
}

export function gpuClass(gpu: NodeProfile['gpu'], platform: string): 'nvidia' | 'amd' | 'apple' | 'intel' | 'other' | 'none' {
    if (!gpuUsable(gpu)) return 'none'
    const text = `${gpu.name || ''} ${gpu.backend}`.toLowerCase()
    if (/nvidia|geforce|rtx|tesla|cuda|gb10|jetson|orin/.test(text)) return 'nvidia'
    if (/amd|radeon|rocm|instinct/.test(text)) return 'amd'
    if (/apple|metal/.test(text) || platform === 'darwin') return 'apple'
    if (/intel|arc|xe\b|oneapi/.test(text)) return 'intel'
    return 'other'
}

/** A GPU counts when something actually uses it: a non-CPU backend or vLLM. */
function gpuUsable(gpu: NodeProfile['gpu']): boolean {
    return Boolean(gpu?.name) && (gpu.viaVllm === true || (gpu.backend !== 'cpu' && gpu.backend !== ''))
}

export function suggestNodeLabels(profile: NodeProfile): NodeLabels {
    const tools = new Set(profile.tools || [])
    const usable = gpuUsable(profile.gpu)
    return {
        'xaventra.ai/gpu': String(usable),
        'xaventra.ai/gpu-class': gpuClass(profile.gpu, profile.platform),
        'xaventra.ai/memory': memoryClass(profile.ramGB),
        'xaventra.ai/desktop': String(tools.has('display')),
        'xaventra.ai/browser': String(tools.has('browser') || tools.has('playwright_browsers')),
        'xaventra.ai/general': String(profile.selfCheck?.status !== 'crit' && profile.ramGB >= 2 && profile.cpus >= 2),
    }
}

/** Owner text: one block per node. Output only — nothing is applied. */
export function formatLabelSuggestions(entries: Array<{ nodeId: string; kubernetesNode?: string | null; profile: NodeProfile | null }>): string {
    const lines = ['*Node-Label-Vorschläge* (nur Vorschlag — setzen machst du selbst; Xaventra ändert keine Nodes)']
    for (const entry of entries) {
        if (!entry.profile) { lines.push('', `• ${entry.nodeId}: kein Profil — kein Vorschlag`); continue }
        const target = entry.kubernetesNode || entry.profile.kubernetes?.node || null
        const labels = suggestNodeLabels(entry.profile)
        lines.push('', `• ${entry.nodeId}${target ? ` → Kubernetes-Node ${target}` : ' (Kubernetes-Node unbekannt — Node-Namen selbst zuordnen)'}`,
            `  ${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(' ')}`)
    }
    lines.push('', 'GPU-Einzelstücke und Heimgeräte im WAN besser als direkte Mesh-Nodes betreiben (docs/KUBERNETES.md).')
    return lines.join('\n')
}
