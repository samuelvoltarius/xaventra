/**
 * Phase 6d — Modell-Register: every model endpoint Xaventra could route to.
 *
 * One entry per (runtime, node, model): vLLM on the Spark, Ollama per node,
 * Codex, and cloud providers that are configured with a key. Each entry says
 *   - which capabilities are PROVEN (capability probe, a successful run in the
 *     Outcome-Ledger, or the existing fixed rule table for Codex) — a model
 *     name never proves anything ("Erkannt ≠ nutzbar", 2.79.3),
 *   - its privacy class (`lokal` only when provably local, else `cloud`),
 *   - cost per call (0 local; cloud from config; unknown stays `null` = teuer),
 *   - measured success rate and latency per task class (Outcome-Ledger runs,
 *     Scout-Prüfsatz for general work),
 *   - health (probe online/offline, Codex availability).
 *
 * `buildModelRegistry` is pure (tests pass fixtures). `collectModelRegistry`
 * reads the live sources read-only; it never probes, loads or pulls.
 */
import type { TaskModelClass } from './task-model-routing.js'
import type { OutcomeRunView } from '../core/outcome-ledger.js'
import { ownerKernelRun } from '../core/validator-failure-escalation.js'

export type PrivacyClass = 'lokal' | 'cloud'
export type EndpointKind = 'vllm' | 'ollama' | 'local-other' | 'codex' | 'anthropic' | 'openai' | 'gemini' | 'cloud-other'
export type RegistryCapability = 'chat' | 'code' | 'vision' | 'tools' | 'embedding' | 'reasoning'
export type EndpointHealth = 'ok' | 'down' | 'unbekannt'

export interface CapabilityEvidence { capability: RegistryCapability; source: 'probe' | 'ledger' | 'regel'; detail: string }
export interface TaskMeasurement {
    taskClass: TaskModelClass
    samples: number
    successes: number
    successRate: number
    avgLatencyMs: number
    source: 'ledger' | 'scout'
}

export interface ModelEndpoint {
    id: string
    kind: EndpointKind
    model: string
    node?: string
    baseUrl?: string
    privacy: PrivacyClass
    capabilities: CapabilityEvidence[]
    /** EUR per call; 0 local; null = unknown (treated as expensive). */
    costEurPerCall: number | null
    health: EndpointHealth
    measurements: TaskMeasurement[]
    /** Ollama: model currently in memory (`/api/ps`). */
    loaded?: boolean
    /** Ollama: size on disk (`/api/tags`), used by the memory guard. */
    sizeBytes?: number
}

export interface ModelRegistry { endpoints: ModelEndpoint[]; builtAt: string; sources: string[] }

export interface ProbeInput {
    model: string
    endpoint: string
    online: boolean
    supportsTools?: boolean
    supportsSystemPrompt?: boolean
    supportsVision?: boolean
    roles?: string[]
    avgLatencyMs?: number
}

export interface LedgerRunLike {
    runId: string
    status: string
    model?: string
    node?: string
    startedAt: string
    updatedAt: string
    invalidated?: boolean
    /** 2.84.0: who and where — only real owner runs are measured (`ownerKernelRun`). */
    userId?: string
    channel?: string
    contract?: { id?: string }
    validation?: { success?: boolean; validator?: string; awaitingApproval?: boolean }
    events?: Array<{ type: string; payload?: Record<string, unknown> }>
}

export interface RegistryInputs {
    /** Mesh node ids (own + peers); runtimes on these nodes are local. */
    knownNodes?: string[]
    vllm?: Array<{ node?: string; baseUrl: string; models: string[] }>
    ollama?: Array<{ node?: string; baseUrl: string; models: Array<{ name: string; sizeBytes?: number }>; loaded?: string[] }>
    probes?: ProbeInput[]
    codex?: { enabled?: boolean; model?: string; available?: boolean }
    /** Cloud models from `routing.multi.cloudModels`; listed only when a key is present (presence only, never the value). */
    cloud?: Array<{ provider: string; model: string; keyPresent: boolean; costEurPerCall?: number }>
    /** `routing.multi.costs`: EUR per call by endpoint id or kind. */
    costs?: Record<string, number>
    ledgerRuns?: LedgerRunLike[]
    scout?: { results?: Array<{ model: string; passed: number; total: number; score?: number; avgLatencyMs?: number; error?: string }> } | null
    /** Explicit health by endpoint id (e.g. from self-heal). */
    health?: Record<string, 'ok' | 'down'>
    now?: Date
}

const TASK_CLASSES: readonly TaskModelClass[] = ['code', 'refactor', 'debug', 'vision', 'smalltalk', 'short', 'general']

export function requiredCapability(taskClass: TaskModelClass): RegistryCapability {
    if (taskClass === 'vision') return 'vision'
    if (taskClass === 'code' || taskClass === 'refactor' || taskClass === 'debug') return 'code'
    return 'chat'
}

const PRIVATE_HOST = [
    /^localhost$/i, /^127\./, /^::1$/, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / Tailscale
    /^fd[0-9a-f]{2}:/i, /\.local$/i,
]

function hostOf(url?: string): string {
    try { return url ? new URL(url).hostname.replace(/^\[|\]$/g, '') : '' } catch { return '' }
}

/** Local only when provable: a local runtime on a known mesh node or a private host. */
export function classifyPrivacy(kind: EndpointKind, baseUrl: string | undefined, node: string | undefined, knownNodes: readonly string[]): PrivacyClass {
    if (kind !== 'vllm' && kind !== 'ollama' && kind !== 'local-other') return 'cloud'
    if (node && knownNodes.includes(node)) return 'lokal'
    const host = hostOf(baseUrl)
    return host && PRIVATE_HOST.some(pattern => pattern.test(host)) ? 'lokal' : 'cloud'
}

export function hasProvenCapability(endpoint: Pick<ModelEndpoint, 'capabilities'>, capability: RegistryCapability): boolean {
    return endpoint.capabilities.some(item => item.capability === capability)
}

const norm = (value: string | undefined) => String(value || '').trim().toLowerCase()
const sameModel = (a?: string, b?: string) => {
    const left = norm(a), right = norm(b)
    return Boolean(left) && (left === right || left.split('/').pop() === right.split('/').pop())
}

/**
 * Per-task-class success/latency from Outcome-Ledger runs whose route recorded
 * a task class. 2.84.0: only real owner runs judged by the Execution Kernel
 * count (one rule with the validator bug finder) — Doctor investigations,
 * autonomy, internal, benchmark and sub-agent runs never shape a model's rate.
 */
export function measurementsFromLedgerRuns(runs: readonly LedgerRunLike[]): Array<{ model: string; node?: string; measurement: TaskMeasurement }> {
    const groups = new Map<string, { model: string; node?: string; taskClass: TaskModelClass; ok: number; total: number; ms: number }>()
    for (const run of runs || []) {
        if (!run || run.invalidated || !run.model) continue
        if (run.status !== 'completed' && run.status !== 'failed') continue
        if (!ownerKernelRun(run as unknown as OutcomeRunView)) continue
        const routed = [...(run.events || [])].reverse().find(event => event?.type === 'route.selected' && typeof event.payload?.modelClass === 'string')
        const taskClass = routed?.payload?.modelClass as TaskModelClass | undefined
        if (!taskClass || !TASK_CLASSES.includes(taskClass)) continue
        const success = run.status === 'completed' && run.validation?.success === true && run.validation?.validator === 'nova-execution-kernel'
        const ms = Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.startedAt)) || 0
        const key = `${norm(run.model)}\u0000${run.node || ''}\u0000${taskClass}`
        const group = groups.get(key) || { model: run.model, node: run.node, taskClass, ok: 0, total: 0, ms: 0 }
        group.total++
        if (success) group.ok++
        group.ms += ms
        groups.set(key, group)
    }
    return [...groups.values()].map(group => ({
        model: group.model, node: group.node,
        measurement: {
            taskClass: group.taskClass, samples: group.total, successes: group.ok,
            successRate: group.total ? group.ok / group.total : 0,
            avgLatencyMs: group.total ? Math.round(group.ms / group.total) : 0, source: 'ledger' as const,
        },
    }))
}

const CLOUD_KINDS: Record<string, EndpointKind> = { anthropic: 'anthropic', openai: 'openai', gemini: 'gemini', google: 'gemini' }

function probeEvidence(probe: ProbeInput): CapabilityEvidence[] {
    if (!probe.online) return []
    const roles = new Set((probe.roles || []).map(role => String(role)))
    const out: CapabilityEvidence[] = []
    const add = (capability: RegistryCapability, detail: string) => out.push({ capability, source: 'probe', detail })
    if (roles.has('chat') || probe.supportsSystemPrompt) add('chat', 'Probe: Antwort erhalten')
    if (roles.has('code')) add('code', 'Probe: Code-Aufgabe bestanden')
    if (probe.supportsVision === true) add('vision', 'Probe: Bild verstanden')
    if (probe.supportsTools) add('tools', 'Probe: Tool-Aufruf')
    if (roles.has('reasoning')) add('reasoning', 'Probe: Reasoning')
    if (roles.has('embedding')) add('embedding', 'Probe: Embedding-Endpunkt')
    return out
}

export function buildModelRegistry(inputs: RegistryInputs): ModelRegistry {
    const knownNodes = inputs.knownNodes || []
    const costs = inputs.costs || {}
    const endpoints: ModelEndpoint[] = []
    const sources = new Set<string>()
    const add = (entry: Omit<ModelEndpoint, 'id' | 'capabilities' | 'measurements' | 'health' | 'privacy' | 'costEurPerCall'> & Partial<ModelEndpoint>) => {
        const id = `${entry.kind}:${entry.node || '-'}:${entry.model}`
        if (endpoints.some(item => item.id === id)) return endpoints.find(item => item.id === id)!
        const privacy = entry.privacy || classifyPrivacy(entry.kind, entry.baseUrl, entry.node, knownNodes)
        const configured = costs[id] ?? costs[entry.kind]
        const cost = privacy === 'lokal' ? 0 : (Number.isFinite(configured) && configured >= 0 ? configured : (entry.costEurPerCall ?? null))
        const endpoint: ModelEndpoint = { ...entry, id, privacy, costEurPerCall: cost, capabilities: [...(entry.capabilities || [])], measurements: [], health: 'unbekannt' }
        endpoints.push(endpoint)
        return endpoint
    }

    for (const runtime of inputs.vllm || []) {
        sources.add('vllm')
        for (const model of runtime.models || []) add({ kind: 'vllm', model, node: runtime.node, baseUrl: runtime.baseUrl })
    }
    for (const runtime of inputs.ollama || []) {
        sources.add('ollama')
        const loaded = new Set((runtime.loaded || []).map(norm))
        for (const model of runtime.models || []) {
            add({ kind: 'ollama', model: model.name, node: runtime.node, baseUrl: runtime.baseUrl, loaded: loaded.has(norm(model.name)), ...(model.sizeBytes ? { sizeBytes: model.sizeBytes } : {}) })
        }
    }
    if (inputs.codex?.enabled !== undefined || inputs.codex?.model) {
        sources.add('codex')
        const model = inputs.codex.model || 'codex'
        const codex = add({
            kind: 'codex', model, privacy: 'cloud',
            capabilities: [
                { capability: 'code', source: 'regel', detail: 'Regeltabelle R8 (Code, Umbau, Fehlersuche)' },
                { capability: 'chat', source: 'regel', detail: 'Regeltabelle R8' },
            ],
        })
        if (!(Number.isFinite(costs[codex.id]) || Number.isFinite(costs.codex))) codex.costEurPerCall = 0 // Abo des Owners
        codex.health = inputs.codex.available === false ? 'down' : inputs.codex.available === true ? 'ok' : 'unbekannt'
    }
    for (const cloud of inputs.cloud || []) {
        if (!cloud?.keyPresent || !cloud.model) continue
        sources.add(`cloud:${norm(cloud.provider)}`)
        add({ kind: CLOUD_KINDS[norm(cloud.provider)] || 'cloud-other', model: cloud.model, privacy: 'cloud', costEurPerCall: cloud.costEurPerCall ?? null })
    }

    // Probes: evidence + health for matching endpoints; unknown local endpoints are added.
    for (const probe of inputs.probes || []) {
        sources.add('probe')
        const matches = endpoints.filter(ep => sameModel(ep.model, probe.model) && (!ep.baseUrl || !probe.endpoint || hostOf(ep.baseUrl) === hostOf(probe.endpoint) || ep.privacy === 'cloud'))
        let targets = matches
        if (!targets.length && probe.endpoint) {
            const kind: EndpointKind = /:11434(\/|$)/.test(probe.endpoint) ? 'ollama' : 'local-other'
            targets = [add({ kind, model: probe.model, baseUrl: probe.endpoint })]
        }
        for (const ep of targets) {
            for (const evidence of probeEvidence(probe)) {
                if (!ep.capabilities.some(item => item.capability === evidence.capability && item.source === 'probe')) ep.capabilities.push(evidence)
            }
            if (ep.health !== 'down' || probe.online) ep.health = probe.online ? 'ok' : 'down'
        }
    }

    // Outcome-Ledger: measured per task class; a success is end-to-end proof of the capability.
    if (inputs.ledgerRuns?.length) sources.add('outcome-ledger')
    for (const cell of measurementsFromLedgerRuns(inputs.ledgerRuns || [])) {
        const matches = endpoints.filter(ep => sameModel(ep.model, cell.model) && (!cell.node || !ep.node || ep.node === cell.node))
        for (const ep of matches) {
            ep.measurements.push(cell.measurement)
            const capability = requiredCapability(cell.measurement.taskClass)
            if (cell.measurement.successes > 0 && !ep.capabilities.some(item => item.capability === capability && item.source === 'ledger')) {
                ep.capabilities.push({ capability, source: 'ledger', detail: `${cell.measurement.successes} validierte Läufe (${cell.measurement.taskClass})` })
            }
        }
    }

    // Scout-Prüfsatz (Doctor-/Alltagsfälle): counts for general work.
    for (const result of inputs.scout?.results || []) {
        if (!result || result.error || !(result.total > 0)) continue
        sources.add('scout')
        for (const ep of endpoints.filter(item => sameModel(item.model, result.model))) {
            ep.measurements.push({
                taskClass: 'general', samples: result.total, successes: result.passed,
                successRate: result.passed / result.total, avgLatencyMs: Math.round(result.avgLatencyMs || 0), source: 'scout',
            })
        }
    }

    for (const [id, health] of Object.entries(inputs.health || {})) {
        const ep = endpoints.find(item => item.id === id)
        if (ep && (health === 'ok' || health === 'down')) ep.health = health
    }
    return { endpoints, builtAt: (inputs.now || new Date()).toISOString(), sources: [...sources].sort() }
}

/** Best measurement of an endpoint for a task class (most samples; ledger before scout). */
export function measurementFor(endpoint: Pick<ModelEndpoint, 'measurements'>, taskClass: TaskModelClass): TaskMeasurement | undefined {
    return endpoint.measurements
        .filter(item => item.taskClass === taskClass)
        .sort((a, b) => (a.source === b.source ? 0 : a.source === 'ledger' ? -1 : 1) || b.samples - a.samples)[0]
}

// ---------------------------------------------------------------------------
// Runtime collection (read-only; each source optional)
// ---------------------------------------------------------------------------

const KEY_ENV: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY'], openai: ['OPENAI_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
}
const KEY_CONFIG: Record<string, string> = { anthropic: 'anthropicApiKey', openai: 'openaiApiKey', gemini: 'geminiApiKey', google: 'geminiApiKey' }

/** True when a key is configured. Only presence is checked; the value is never read further. */
export function cloudKeyPresent(provider: string, config: any, env: NodeJS.ProcessEnv = process.env): boolean {
    const name = norm(provider)
    if ((KEY_ENV[name] || []).some(key => Boolean(env[key]))) return true
    const field = KEY_CONFIG[name]
    return Boolean(field && config?.auth?.[field])
}

export async function collectModelRegistry(options: { config?: any; userId?: string } = {}): Promise<ModelRegistry> {
    const config = options.config ?? (globalThis as any).__novaState?.config ?? {}
    const multi = config?.routing?.multi || {}
    const inputs: RegistryInputs = { knownNodes: [], vllm: [], ollama: [], probes: [], costs: multi.costs || {} }
    try {
        const { getCapabilityGraph } = await import('../mesh/capability-graph.js')
        for (const node of getCapabilityGraph().getSnapshot().nodes) {
            inputs.knownNodes!.push(node.id)
            for (const runtime of node.runtimes || []) {
                if (runtime.status !== 'running') continue
                const type = norm(runtime.type)
                if (type === 'vllm') inputs.vllm!.push({ node: node.id, baseUrl: runtime.endpoint, models: runtime.models || [] })
                else if (type === 'ollama') {
                    const loaded = Array.isArray((runtime.metadata as any)?.loaded) ? (runtime.metadata as any).loaded : []
                    inputs.ollama!.push({ node: node.id, baseUrl: runtime.endpoint, models: (runtime.models || []).map(name => ({ name })), loaded })
                }
            }
        }
    } catch { /* graph optional */ }
    try {
        const { getOnlineModels } = await import('../llm/capability-probe.js')
        inputs.probes = getOnlineModels().map(probe => ({
            model: probe.model, endpoint: probe.endpoint, online: probe.online, supportsTools: probe.supportsTools,
            supportsSystemPrompt: probe.supportsSystemPrompt, supportsVision: probe.supportsVision, roles: probe.roles, avgLatencyMs: probe.avgLatencyMs,
        }))
    } catch { /* probe cache optional */ }
    inputs.codex = { enabled: config?.codex?.enabled === true, model: config?.codex?.model }
    inputs.cloud = (Array.isArray(multi.cloudModels) ? multi.cloudModels : []).flatMap((entry: any) => {
        if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string') return []
        const cost = Number(entry.costEurPerCall)
        return [{ provider: entry.provider, model: entry.model, keyPresent: cloudKeyPresent(entry.provider, config), ...(Number.isFinite(cost) && cost >= 0 ? { costEurPerCall: cost } : {}) }]
    })
    try {
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        inputs.ledgerRuns = getOutcomeLedger().listRuns(500) as unknown as LedgerRunLike[]
    } catch { /* ledger optional */ }
    try {
        const { readFileSync } = await import('node:fs')
        const { getNovaDataDir } = await import('../core/data-root.js')
        inputs.scout = JSON.parse(readFileSync(getNovaDataDir('thinking', 'scout-report.json'), 'utf8'))
    } catch { /* no scout report yet */ }
    return buildModelRegistry(inputs)
}
