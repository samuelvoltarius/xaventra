/**
 * /status: KI-Endpunkte and Knoten — 2.82.0 vollständig aus dem capability-graph.
 *
 * Before, the endpoint list grouped the local entries of `availableLLMs` by
 * host:port (a second inventory next to the graph; the Spark appeared twice
 * as localhost and Tailscale IP, ns2/NAS were missing). Now both lines come
 * from the one inventory, `getCapabilityGraph().getSnapshot().nodes`: each
 * node's running runtimes with endpoint and models, and the node list. Only
 * cloud models (not nodes) still come from the configured provider list.
 */
import type { CapabilityGraphNode } from '../mesh/capability-graph.js'

type StatusNode = Pick<CapabilityGraphNode, 'id' | 'status'> & { runtimes?: CapabilityGraphNode['runtimes'] }

const isEmbedding = (model: string) => /embed|nomic|bge|mxbai/i.test(model)
const hostPort = (endpoint: string) => String(endpoint || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')

export function formatEndpointSection(graphNodes: readonly StatusNode[], configModel: string, cloudModels: readonly string[] = []): string {
    const nodes = graphNodes.filter(node => node?.id)
    const endpointLines: string[] = []
    let endpoints = 0
    for (const node of nodes) {
        for (const runtime of node.runtimes ?? []) {
            if (runtime.status !== 'running' || !runtime.endpoint) continue
            endpoints++
            const models = (runtime.models ?? []).filter(model => !isEmbedding(model))
            const isPrimary = models.includes(configModel)
            const modelList = models.slice(0, 3).join(', ') + (models.length > 3 ? ` +${models.length - 3}` : '')
            endpointLines.push(`  ${isPrimary ? '★' : '○'} ${node.id} ${runtime.type} (${hostPort(runtime.endpoint)}): ${modelList || '–'}`)
        }
    }
    const cloud = [...new Set(cloudModels)].slice(0, 4)
    if (cloud.length > 0) endpointLines.push(`  ☁ Cloud: ${cloud.join(' → ')}`)

    const parts: string[] = []
    if (endpointLines.length > 0) parts.push(`\n*KI-Endpunkte (${endpoints}):*\n${endpointLines.join('\n')}`)
    if (nodes.length > 0) parts.push(`\n*Knoten (${nodes.length}):* ${nodes.map(node => node.status === 'offline' ? `${node.id} (offline)` : node.id).join(', ')}`)
    return parts.join('')
}
