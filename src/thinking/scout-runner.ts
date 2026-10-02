/**
 * 2.84.0 Punkt 8 — Prüf-Runner des Modell-Scouts aus vorhandenen Teilen.
 *
 * - Gemessen wird nur gegen BEREITS installierte lokale Endpunkte aus dem
 *   Modell-Register (`privacy: 'lokal'`, nicht `down`). Cloud nie.
 * - Ein installiertes, nicht geladenes Ollama-Modell wird über den
 *   vorhandenen L1-Weg `ensureOllamaModel` (Speicherreserve) geladen und nach
 *   der Messung wieder entladen. Heruntergeladen wird nichts: was nicht da
 *   ist, steht gar nicht im Register (Pull bleibt die L2-Karte).
 * - Antworten bewertet `scoreAnswer` (Prüfsatz ohne private Inhalte).
 * - `inventory()` nennt dem Scout, was messbar ist (installierte lokale
 *   Modelle) und welche Ziele die vLLM-Wechselliste hat (`routing.vllm.targets`,
 *   Modell-ID je Ziel vom Host-Agenten, falls eingerichtet).
 *
 * Der Runner wechselt nie ein Modell; der Wechsel bleibt die Karte mit eigenem Ja.
 */
import type { ModelEndpoint, ModelRegistry } from '../routing/model-registry.js'
import type { NodeMemoryView, OllamaPort } from '../routing/local-model-control.js'
import type { ScoutInventory, ScoutRunner, ScoutSwitchTarget } from './model-scout.js'
import { scoreAnswer, type ProbeCase } from './probe-set.js'

interface ProbeClient { complete(messages: Array<{ role: string; content: string }>, tools?: unknown, options?: Record<string, unknown>): Promise<{ content?: string } | null | undefined> }

export interface ScoutRunnerDeps {
    registry: () => Promise<ModelRegistry>
    client: (endpoint: ModelEndpoint) => Promise<ProbeClient>
    targets: () => Promise<ScoutSwitchTarget[]>
    /** Needed to load an installed but unloaded Ollama model (L1, memory reserve). */
    ollama?: { port: OllamaPort; memory: (node: string | undefined) => Promise<NodeMemoryView | null> }
    timeoutMs?: number
    now?: () => number
}

const LOCAL_KINDS = new Set(['vllm', 'ollama', 'local-other'])
const NOT_CHAT = /embed|nomic|bge|mxbai|whisper|voice|rerank/i
const norm = (value: string) => String(value || '').trim().toLowerCase()
const sameModel = (a: string, b: string) => {
    const left = norm(a), right = norm(b)
    const bare = (value: string) => value.split('/').pop()!.replace(/:latest$/, '')
    return Boolean(left) && (left === right || bare(left) === bare(right))
}

/** Local, installed, chat-capable endpoints; never cloud. */
export function measurableEndpoints(registry: ModelRegistry): ModelEndpoint[] {
    return registry.endpoints.filter(ep => ep.privacy === 'lokal' && LOCAL_KINDS.has(ep.kind) && ep.health !== 'down' && !NOT_CHAT.test(ep.model))
}

export function createScoutRunner(deps: ScoutRunnerDeps): ScoutRunner {
    const timeoutMs = deps.timeoutMs ?? 120_000
    const now = deps.now || Date.now
    return {
        async inventory(): Promise<ScoutInventory> {
            const [registry, targets] = await Promise.all([deps.registry(), deps.targets().catch(() => [] as ScoutSwitchTarget[])])
            return { installed: [...new Set(measurableEndpoints(registry).map(ep => ep.model))], targets }
        },
        async evaluate(model: string, probes: ProbeCase[], signal: AbortSignal) {
            const endpoint = measurableEndpoints(await deps.registry()).find(ep => sameModel(ep.model, model))
            if (!endpoint) throw new Error(`${model}: kein installierter lokaler Endpunkt — nicht gemessen`)
            let loadedHere = false
            if (endpoint.kind === 'ollama' && endpoint.loaded === false) {
                if (!deps.ollama || !endpoint.baseUrl) throw new Error(`${model}: nicht geladen und kein Ollama-Zugang`)
                const { ensureOllamaModel } = await import('../routing/local-model-control.js')
                const ensured = await ensureOllamaModel(
                    { node: endpoint.node || 'unbekannt', baseUrl: endpoint.baseUrl, model: endpoint.model, taskClass: 'general' },
                    { port: deps.ollama.port, memory: await deps.ollama.memory(endpoint.node) },
                )
                if (ensured.status !== 'geladen' && ensured.status !== 'schon-geladen') throw new Error(`${model}: ${ensured.reason}`)
                loadedHere = ensured.status === 'geladen'
            }
            try {
                const client = await deps.client(endpoint)
                const perCase: Array<{ id: string; ok: boolean }> = []
                let elapsed = 0
                for (const probe of probes) {
                    if (signal.aborted) throw new Error('Scout-Messung abgebrochen')
                    const started = now()
                    let ok = false
                    try {
                        const response = await client.complete([{ role: 'user', content: probe.prompt }], [], { maxTokens: 256, timeoutMs, tools: false })
                        ok = scoreAnswer(probe, String(response?.content || ''))
                    } catch { ok = false }
                    elapsed += Math.max(0, now() - started)
                    perCase.push({ id: probe.id, ok })
                }
                return { model: endpoint.model, passed: perCase.filter(item => item.ok).length, total: perCase.length, avgLatencyMs: perCase.length ? Math.round(elapsed / perCase.length) : 0, perCase }
            } finally {
                if (loadedHere && deps.ollama && endpoint.baseUrl) {
                    const { unloadOllamaModel } = await import('../routing/local-model-control.js')
                    await unloadOllamaModel(endpoint.baseUrl, endpoint.model, deps.ollama.port).catch(() => undefined)
                }
            }
        },
    }
}

/** Switch targets from `routing.vllm.targets`; model id per target from the host agent when it is set up. */
async function productionSwitchTargets(config: any): Promise<ScoutSwitchTarget[]> {
    const { readVllmTargetsFromConfig } = await import('../routing/vllm-switch.js')
    const targets = readVllmTargetsFromConfig(config)
    let modelIds: Record<string, string> = {}
    const env = process.env
    if (env.XAVENTRA_HOST_AGENT_SOCKET && env.XAVENTRA_HOST_AGENT_TOKEN_FILE) {
        try {
            const { callHostAgent } = await import('../host/docker-client.js')
            const state: any = await callHostAgent('/v1/vllm/state', {})
            if (state?.success && state.modelIds && typeof state.modelIds === 'object') modelIds = state.modelIds
        } catch { /* host agent optional: targets without model id match by name only */ }
    }
    return targets.map(target => ({ target, ...(typeof modelIds[target] === 'string' ? { modelId: modelIds[target] } : {}) }))
}

/** Daemon wiring (Main only): registry, local clients, Ollama port and node memory from the existing modules. */
export async function createProductionScoutRunner(getConfig: () => any = () => (globalThis as any).__novaState?.config || {}): Promise<ScoutRunner> {
    const control = await import('../routing/local-model-control.js')
    return createScoutRunner({
        registry: async () => (await import('../routing/model-registry.js')).collectModelRegistry({ config: getConfig() }),
        client: async endpoint => {
            const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
            return createNovaLLMClient({ provider: 'local', model: endpoint.model, ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}), isolated: true }) as unknown as ProbeClient
        },
        targets: async () => productionSwitchTargets(getConfig()),
        ollama: {
            port: control.createOllamaHttpPort(),
            memory: async node => {
                const { profileForNode } = await import('../routing/model-runtime.js')
                return node ? control.nodeMemoryFromProfile(await profileForNode(node)) : null
            },
        },
    })
}
