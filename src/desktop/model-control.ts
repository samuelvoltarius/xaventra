import { availableLLMs } from '../core/llm-factory.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'
import { getOutcomeRouter } from '../routing/outcome-router.js'
import type { CapabilityGraphNode } from '../mesh/capability-graph.js'
import { getProviderManifestCatalog, type ProviderCatalogEntry } from '../llm/provider-manifest.js'

export interface DesktopModelEntry {
    routeId: string
    id: string
    provider: string
    nodeId: string
    endpoint?: string
    runtime?: string
    local: boolean
    status: string
    supportsTools?: boolean
    verifiedAt?: string
    tokensPerSecond?: number
    toolSuccessRate?: number
    toolSamples?: number
}

export function inferModelRouteNode(endpoint: string | undefined, nodes: CapabilityGraphNode[]): CapabilityGraphNode | undefined {
    if (!endpoint) return undefined
    try {
        const host = new URL(endpoint).hostname.toLowerCase()
        return nodes.find(node => [node.host, node.hostname]
            .filter(Boolean)
            .some(identity => String(identity).trim().toLowerCase() === host))
    } catch {
        return undefined
    }
}

export function getDesktopModelCatalog(): { activeModel: string; activeProvider: string; models: DesktopModelEntry[]; providers: ProviderCatalogEntry[]; autoRouter: ReturnType<ReturnType<typeof getOutcomeRouter>['getTrainingStatus']> } {
    const state = (globalThis as any).__novaState
    const map = new Map<string, DesktopModelEntry>()
    const nodes = getCapabilityGraph().getSnapshot().nodes
    for (const node of nodes) {
        for (const runtime of node.runtimes) {
            const performance = (runtime.metadata?.performance || {}) as Record<string, { tokensPerSecond?: number; supportsTools?: boolean }>
            const outcomes = (runtime.metadata?.outcomes || {}) as Record<string, { toolSuccessRate?: number; toolSamples?: number }>
            for (const model of runtime.models) {
                if (/embed|nomic|bge|mxbai|voice|whisper|tts/i.test(model)) continue
                const provider = runtime.name || runtime.type
                const routeId = `${node.id}::${provider}::${model}`
                map.set(routeId, {
                    routeId, id: model, provider, nodeId: node.id, endpoint: runtime.endpoint,
                    runtime: runtime.name, local: node.id === (process.env.NOVA_NODE_ID || 'local'),
                    status: runtime.status, verifiedAt: runtime.verifiedAt,
                    supportsTools: performance[model]?.supportsTools ?? runtime.capabilities.includes('tools'),
                    tokensPerSecond: performance[model]?.tokensPerSecond,
                    toolSuccessRate: outcomes[model]?.toolSuccessRate, toolSamples: outcomes[model]?.toolSamples,
                })
            }
        }
    }
    // Keep provider-only models that are not already represented by a
    // verified node runtime. This avoids the previous duplicate "local" rows.
    for (const model of availableLLMs) {
        if (/embed|nomic|bge|mxbai|voice|whisper|tts/i.test(model.model)) continue
        if ([...map.values()].some(item => item.id === model.model && (item.status === 'running' || item.endpoint === model.endpoint))) continue
        const routeNode = inferModelRouteNode(model.endpoint, nodes)
        const matchingRuntime = routeNode?.runtimes.find(runtime => runtime.endpoint === model.endpoint)
        const nodeId = routeNode?.id || 'local'
        const provider = matchingRuntime?.name || model.provider
        const routeId = `${nodeId}::${provider}::${model.model}`
        map.set(routeId, {
            routeId, id: model.model, provider, nodeId, endpoint: model.endpoint,
            runtime: matchingRuntime?.name, local: Boolean(model.local), status: 'available',
            verifiedAt: matchingRuntime?.verifiedAt,
        })
    }
    return { activeModel: state?.llm?.modelId || state?.activeModel || 'auto', activeProvider: state?.llm?.provider || 'auto', models: [...map.values()].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.id.localeCompare(b.id)), providers: getProviderManifestCatalog().list(), autoRouter: getOutcomeRouter().getTrainingStatus() }
}

export async function switchDesktopModel(model: string, provider?: string): Promise<{ success: boolean; model: string; provider: string }> {
    const value = String(model || '').trim()
    const catalog = getDesktopModelCatalog()
    const selected = catalog.models.find(item => item.routeId === value)
        || catalog.models.find(item => item.id === value && (!provider || item.provider === provider))
    if (!selected) throw new Error('Model is not present in the verified catalog')
    const daemon = (globalThis as any).__novaDaemon || (globalThis as any).__novaState
    if (!daemon?.llm?.switchModel) throw new Error('LLM runtime is not ready')
    const success = await daemon.llm.switchModel(selected.id, selected.provider)
    return { success: Boolean(success), model: selected.id, provider: daemon.llm.provider || selected.provider || 'auto' }
}
