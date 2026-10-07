/**
 * 2.89 (Paket C): THE one answer to "which provider / which model is running,
 * and is it reachable?".
 *
 * Before, five places asked this with their own logic and gave different answers:
 *  - doctor/collect.ts checkProviders (env NOVA_PROVIDER, no `vllm`),
 *  - core/self-doctor.ts (other env NOVA_LLM_PROVIDER, 15-minute window),
 *  - the runtime question in message-pipeline.ts (only the client's own labels),
 *  - the cloud list in the capability orchestrator (key present = available),
 *  - the multi route in nova-runner (model registry).
 * They now all ask `describeActiveRuntime`.
 *
 * Reachability is only claimed with a probe of the configured local endpoint.
 * A cloud provider is never "reachable" here (no live call is made); it says
 * `reachable: null` and whether a key is configured. Reading only; nothing is
 * started, loaded or pulled.
 */
import { cloudKeyPresent, type ModelRegistry } from '../routing/model-registry.js'

export type RuntimeKind = 'local' | 'cloud' | 'none'

export interface ActiveRoute { id: string; kind: string; model: string; node?: string; health: string; privacy: string }
export interface MeshLlmRuntime { node: string; name: string; models: string[] }

export interface ActiveRuntime {
    /** Provider id as configured (ollama, vllm, local, openai ...); `none` when nothing is set. */
    provider: string
    providerSource: 'client' | 'config' | 'env' | 'none'
    model: string | null
    kind: RuntimeKind
    /** Local endpoint without credentials (probed). */
    endpoint?: string
    /** How the local endpoint speaks: OpenAI-compatible (vLLM, llama.cpp ...) or Ollama. */
    endpointStyle?: 'openai' | 'ollama'
    /** true/false only after a probe of a local endpoint; null = cloud or not probed. */
    reachable: boolean | null
    /** Models the local endpoint listed. */
    localModels: string[]
    /** Cloud: is a key configured (presence only). */
    keyPresent?: boolean
    /** Fresh LLM runtimes seen in the mesh (Capability Graph, one online window). */
    meshRuntimes: MeshLlmRuntime[]
    /** Multi route (routing.multi): every endpoint the router could use. Empty when multi routing is off. */
    routes: ActiveRoute[]
    /** One honest German line. */
    summary: string
}

export interface ActiveRuntimeInput {
    config?: any
    /** The running client's own labels (state.llm). */
    client?: { providerId?: string; modelId?: string } | null
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    timeoutMs?: number
    /** false = never touch the network (a local endpoint then has reachable null). */
    probe?: boolean
    /** Pass a registry to skip collecting one; null = no multi route view. */
    registry?: ModelRegistry | null
    /** Fresh mesh LLM runtimes; default: read from the Capability Graph. */
    meshRuntimes?: MeshLlmRuntime[]
    now?: number
}

const LOCAL_PROVIDERS = new Set(['local', 'vllm', 'ollama', 'lmstudio', 'lm-studio', 'llamacpp', 'llama-cpp'])
const OLLAMA_DEFAULT = 'http://localhost:11434'

/** The ONE place that reads the provider from config + env (env: NOVA_PROVIDER only). */
export function configuredProvider(config: any, env: NodeJS.ProcessEnv = process.env): { provider: string; source: 'config' | 'env' | 'none' } {
    const fromConfig = String(config?.provider || '').trim().toLowerCase()
    if (fromConfig) return { provider: fromConfig, source: 'config' }
    const fromEnv = String(env.NOVA_PROVIDER || '').trim().toLowerCase()
    if (fromEnv) return { provider: fromEnv, source: 'env' }
    return { provider: 'none', source: 'none' }
}

const stripBase = (raw: unknown) => String(raw ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')

function safeEndpoint(url: string): string {
    try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; return parsed.toString().replace(/\/$/, '') } catch { return url }
}

/** Where the configured provider's chat endpoint lives (local providers only). */
export function localEndpointFor(provider: string, config: any, env: NodeJS.ProcessEnv = process.env): { baseUrl: string; style: 'openai' | 'ollama' } | null {
    const providers = config?.providers || {}
    const section = (key: string) => (providers[key] && providers[key].enabled !== false ? stripBase(providers[key].baseUrl) : '')
    if (provider === 'ollama') return { baseUrl: stripBase(config?.ollama?.baseUrl) || section('ollama') || stripBase(env.OLLAMA_BASE_URL) || OLLAMA_DEFAULT, style: 'ollama' }
    if (provider === 'vllm') { const base = section('vllm') || section('local'); return base ? { baseUrl: base, style: 'openai' } : null }
    if (provider === 'local' || provider === 'none') {
        const base = section('local') || section('vllm')
        if (base) return { baseUrl: base, style: 'openai' }
        // Nothing set: Ollama on this machine is the default local runtime.
        return { baseUrl: stripBase(config?.ollama?.baseUrl) || stripBase(env.OLLAMA_BASE_URL) || OLLAMA_DEFAULT, style: 'ollama' }
    }
    if (LOCAL_PROVIDERS.has(provider)) { const base = section(provider); return base ? { baseUrl: base, style: 'openai' } : null }
    return null
}

async function probeEndpoint(target: { baseUrl: string; style: 'openai' | 'ollama' }, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ reachable: boolean; models: string[] }> {
    try {
        const url = target.style === 'ollama' ? `${target.baseUrl}/api/tags` : `${target.baseUrl}/v1/models`
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return { reachable: false, models: [] }
        const body = await response.json() as { models?: Array<{ name?: string; model?: string }>; data?: Array<{ id?: string }> }
        const models = target.style === 'ollama'
            ? (body.models || []).map(item => String(item.name || item.model || '')).filter(Boolean)
            : (body.data || []).map(item => String(item.id || '')).filter(Boolean)
        return { reachable: true, models }
    } catch { return { reachable: false, models: [] } }
}

function cloudKey(provider: string, config: any, env: NodeJS.ProcessEnv): boolean {
    if (cloudKeyPresent(provider, config, env)) return true
    const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    if (env[envName]) return true
    return Boolean(config?.providers?.[provider]?.apiKey)
}

async function freshMeshRuntimes(now: number): Promise<MeshLlmRuntime[]> {
    try {
        const { getCapabilityGraph, capabilityRuntimeAvailable } = await import('../mesh/capability-graph.js')
        const out: MeshLlmRuntime[] = []
        for (const node of getCapabilityGraph().getSnapshot().nodes) {
            for (const runtime of node.runtimes || []) {
                const tags = [runtime.type, runtime.name, ...(runtime.capabilities || [])].map(value => String(value || '').toLowerCase())
                const isLlm = tags.some(tag => ['llm', 'vllm', 'ollama', 'lmstudio', 'lm-studio', 'openai-compatible'].includes(tag))
                if (isLlm && capabilityRuntimeAvailable(node, runtime, now)) out.push({ node: node.id, name: runtime.name, models: [...(runtime.models || [])] })
            }
        }
        return out
    } catch { return [] }
}

export async function describeActiveRuntime(input: ActiveRuntimeInput = {}): Promise<ActiveRuntime> {
    const env = input.env ?? process.env
    const config = input.config ?? (globalThis as any).__novaState?.config ?? {}
    const configured = configuredProvider(config, env)
    const clientProvider = String(input.client?.providerId || '').trim().toLowerCase()
    const provider = clientProvider || configured.provider
    const providerSource: ActiveRuntime['providerSource'] = clientProvider ? 'client' : configured.source
    const model = String(input.client?.modelId || config?.model || config?.providers?.[provider]?.model || '').trim() || null
    const now = input.now ?? Date.now()

    let kind: RuntimeKind = provider === 'none' ? 'none' : 'cloud'
    let endpoint: string | undefined
    let endpointStyle: 'openai' | 'ollama' | undefined
    let reachable: boolean | null = null
    let localModels: string[] = []
    let keyPresent: boolean | undefined

    const localProvider = provider === 'none' || LOCAL_PROVIDERS.has(provider)
    const target = localProvider ? localEndpointFor(provider, config, env) : null
    if (localProvider && !target) {
        // vllm / lmstudio ... selected, but no address configured: local, but nothing to ask.
        kind = 'local'
        reachable = false
    } else if (target) {
        kind = 'local'
        endpoint = safeEndpoint(target.baseUrl)
        endpointStyle = target.style
        if (input.probe !== false) {
            const result = await probeEndpoint(target, input.fetchImpl ?? fetch, input.timeoutMs ?? 3000)
            reachable = result.reachable
            localModels = result.models
        }
    } else if (kind === 'cloud') {
        keyPresent = cloudKey(provider, config, env)
    }

    const meshRuntimes = input.meshRuntimes ?? await freshMeshRuntimes(now)

    let routes: ActiveRoute[] = []
    try {
        const { readMultiRouteSettings } = await import('../routing/task-model-routing.js')
        const registry = input.registry !== undefined ? input.registry
            : readMultiRouteSettings(config).enabled ? await (await import('../routing/model-registry.js')).collectModelRegistry({ config }) : null
        routes = (registry?.endpoints || []).map(item => ({ id: item.id, kind: item.kind, model: item.model, node: item.node, health: item.health, privacy: item.privacy }))
    } catch { /* multi route view optional */ }

    const name = model ? `${provider}/${model}` : provider
    const count = localModels.length
    const summary = kind === 'none'
        ? 'Es ist noch kein Sprachmodell eingestellt.'
        : kind === 'local'
            ? reachable === true ? `${name} läuft lokal und antwortet${count ? ` (${count} Modell${count === 1 ? '' : 'e'})` : ''}.`
                : reachable === false ? `${name} ist lokal eingestellt, antwortet aber gerade nicht${endpoint ? '' : ' (keine Adresse eingetragen)'}.`
                    : `${name} ist lokal eingestellt (nicht geprüft).`
            : keyPresent ? `${name} läuft über die Cloud (Schlüssel vorhanden; keine Live-Prüfung).`
                : `${name} läuft über die Cloud, aber ich finde keinen Schlüssel dafür.`

    return {
        provider, providerSource, model, kind, ...(endpoint ? { endpoint, endpointStyle } : {}), reachable, localModels,
        ...(keyPresent !== undefined ? { keyPresent } : {}), meshRuntimes, routes, summary,
    }
}

/** Lines for the owner question "welches Modell läuft?" (no invented model names). */
export function formatActiveRuntime(runtime: ActiveRuntime): string[] {
    const lines = [`Konfiguriertes Runtime-Modell: ${runtime.provider}/${runtime.model || 'unbekannt'}.`, runtime.summary]
    if (runtime.routes.length) {
        const usable = runtime.routes.filter(route => route.health !== 'down')
        lines.push(`Mehrfach-Route aktiv: ${usable.length} von ${runtime.routes.length} Zielen erreichbar (${[...new Set(usable.map(route => route.kind))].join(', ') || 'keins'}).`)
    }
    return lines
}

// ---------------------------------------------------------------------------
// Cloud providers that are set up (presence of a key only; no live call)
// ---------------------------------------------------------------------------

export interface CloudProviderView { name: string; keyPresent: boolean; active: boolean; capabilities: string[] }

/** What each cloud provider offers (documentation of the provider, not a test). */
const CLOUD_OFFERS: Record<string, string[]> = {
    openai: ['llm', 'vision', 'embedding'],
    anthropic: ['llm', 'vision'],
    gemini: ['llm', 'vision', 'embedding'],
    minimax: ['llm', 'tts'],
    groq: ['llm'],
    openrouter: ['llm'],
}

/** Cloud providers with a configured key, plus the active one (sync, for the capability view). */
export function configuredCloudProviders(config: any, env: NodeJS.ProcessEnv = process.env): CloudProviderView[] {
    const active = configuredProvider(config, env).provider
    return Object.entries(CLOUD_OFFERS)
        .map(([name, capabilities]) => ({ name, keyPresent: cloudKey(name, config, env), active: active === name, capabilities }))
        .filter(view => view.keyPresent || view.active)
}
