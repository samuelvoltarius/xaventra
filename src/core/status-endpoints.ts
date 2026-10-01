/**
 * /status: KI-Endpunkte and Knoten (2.82.0).
 *
 * The endpoint list groups the local entries of `availableLLMs` by host:port.
 * It used to be headed "Mesh (N Nodes)" although it lists endpoints, so the
 * Spark appeared twice and ns2/NAS (no LLM endpoint) not at all. The node line
 * comes from the capability graph, the one inventory of mesh nodes.
 */
import type { CapabilityGraphNode } from '../mesh/capability-graph.js'

export interface StatusLLMEntry { provider: string; model: string; local: boolean; endpoint?: string; nodeName?: string }

export function formatEndpointSection(entries: readonly StatusLLMEntry[], configModel: string, graphNodes: ReadonlyArray<Pick<CapabilityGraphNode, 'id' | 'status'>>): string {
    const endpointLines: string[] = []
    const byHost = new Map<string, { name: string; models: string[] }>()
    for (const entry of entries) {
        if (!entry.local || !entry.endpoint) continue
        const host = entry.endpoint.replace(/https?:\/\//, '').replace(/\/.*$/, '')
        if (!byHost.has(host)) byHost.set(host, { name: entry.nodeName || host, models: [] })
        // Skip embedding models
        if (!/embed|nomic|bge|mxbai/i.test(entry.model)) byHost.get(host)!.models.push(entry.model)
    }
    for (const [host, info] of byHost) {
        const isPrimary = info.models.includes(configModel)
        const modelList = info.models.slice(0, 3).join(', ') + (info.models.length > 3 ? ` +${info.models.length - 3}` : '')
        endpointLines.push(`  ${isPrimary ? '★' : '○'} ${info.name} (${host}): ${modelList || '–'}`)
    }
    const cloudModels = entries.filter(entry => !entry.local).map(entry => entry.model).slice(0, 4)
    if (cloudModels.length > 0) endpointLines.push(`  ☁ Cloud: ${cloudModels.join(' → ')}`)

    const parts: string[] = []
    if (endpointLines.length > 0) parts.push(`\n*KI-Endpunkte (${byHost.size}):*\n${endpointLines.join('\n')}`)
    const nodes = graphNodes.filter(node => node?.id)
    if (nodes.length > 0) parts.push(`\n*Knoten (${nodes.length}):* ${nodes.map(node => node.status === 'offline' ? `${node.id} (offline)` : node.id).join(', ')}`)
    return parts.join('')
}
