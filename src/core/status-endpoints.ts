/**
 * /status: KI-Endpunkte and Knoten — 2.82.0 vollständig aus dem capability-graph.
 *
 * Before, the endpoint list grouped the local entries of `availableLLMs` by
 * host:port (a second inventory next to the graph; the Spark appeared twice
 * as localhost and Tailscale IP, ns2/NAS were missing). Now both lines come
 * from the one inventory, `getCapabilityGraph().getSnapshot().nodes`: each
 * node's running runtimes with endpoint and models, and the node list. Only
 * cloud models (not nodes) still come from the configured provider list.
 *
 * 2.89.4 (live): /status listed ghost nodes and dead endpoints as if they were
 * working. The Desktop node-list freshness rule (isHeartbeatFresh) and the
 * capability-graph availability checks decide what is shown: only real mesh
 * nodes (heartbeat evidence or this node itself), never guessed-from-peer
 * phantom rows; an AI endpoint is listed as working only when it is reachable,
 * otherwise explicitly „nicht erreichbar“.
 */
import type { CapabilityGraphNode, CapabilityRuntime, CapabilityTombstone } from '../mesh/capability-graph.js'
import { capabilityRuntimeAvailable, capabilityRuntimeTombstoned } from '../mesh/capability-graph.js'
import { isHeartbeatFresh } from '../mesh/mesh-node-lifecycle.js'

type StatusNode = Pick<CapabilityGraphNode, 'id' | 'status'> & {
    hostname?: string
    lastHeartbeat?: string
    updatedAt?: string
    software?: CapabilityGraphNode['software']
    capabilities?: string[]
    runtimes?: CapabilityGraphNode['runtimes']
}

export interface StatusSectionOptions {
    now?: number
    /** This process's node id: a scanner-only local node has no heartbeat. */
    localNodeId?: string | null
    tombstones?: readonly CapabilityTombstone[]
}

const isEmbedding = (model: string) => /embed|nomic|bge|mxbai/i.test(model)
const hostPort = (endpoint: string) => String(endpoint || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const isNetworkEndpoint = (endpoint: string) => /^https?:\/\//i.test(endpoint || '')

/**
 * Real mesh nodes carry heartbeat evidence or are this node itself. A row the
 * scanner or a peer snapshot invented from a service host is phantom and is
 * never listed as a Knoten (live: /status ghost nodes).
 */
function isRealMeshNode(node: StatusNode, localNodeId: string | null | undefined): boolean {
    if (!node?.id) return false
    if (localNodeId && node.id === localNodeId) return true
    return Boolean(node.lastHeartbeat)
}

/** Desktop node-list freshness rule: online only with a fresh heartbeat.
 * A scanner-only local node has no heartbeat; its observation time counts. */
function isNodeOnline(node: StatusNode, localNodeId: string | null | undefined, now: number): boolean {
    if (node.status === 'offline') return false
    if (node.lastHeartbeat) return isHeartbeatFresh(node.lastHeartbeat, now)
    if (localNodeId && node.id === localNodeId) return isHeartbeatFresh(node.updatedAt, now)
    return false
}

/**
 * A heartbeat advertisement is complete (Hotfix 2.80.1 at ingest): a running
 * network runtime the node no longer lists is leftover peer/probe hearsay and
 * is never shown as an endpoint.
 */
function isPhantomRuntime(node: StatusNode, runtime: CapabilityRuntime): boolean {
    const advertised = node.software?.ai_services
    if (!Array.isArray(advertised)) return false
    if (advertised.some(service => service?.endpoint === runtime.endpoint)) return false
    return runtime.verificationSource === 'mesh-heartbeat'
        || (runtime.status === 'running' && isNetworkEndpoint(runtime.endpoint))
}

function asGraphNode(node: StatusNode): CapabilityGraphNode {
    return {
        id: node.id,
        hostname: node.hostname || node.id,
        status: node.status,
        lastHeartbeat: node.lastHeartbeat,
        capabilities: node.capabilities || [],
        runtimes: [],
        updatedAt: node.updatedAt || '',
    }
}

export function formatEndpointSection(
    graphNodes: readonly StatusNode[],
    configModel: string,
    cloudModels: readonly string[] = [],
    options: StatusSectionOptions = {},
): string {
    const now = options.now ?? Date.now()
    const localNodeId = options.localNodeId
    const tombstones = new Map((options.tombstones ?? []).map(item => [item.id, item]))
    const nodes = graphNodes.filter(node => isRealMeshNode(node, localNodeId))
    const endpointLines: string[] = []
    let endpoints = 0
    for (const node of nodes) {
        for (const runtime of node.runtimes ?? []) {
            if (runtime.status !== 'running' || !runtime.endpoint) continue
            if (capabilityRuntimeTombstoned(runtime, tombstones.get(runtime.id))) continue
            if (isPhantomRuntime(node, runtime)) continue
            // Reachable = fresh node + fresh runtime evidence. An endpoint that
            // fails the check is never shown as working.
            const reachable = capabilityRuntimeAvailable(asGraphNode(node), runtime, now)
            endpoints++
            const models = (runtime.models ?? []).filter(model => !isEmbedding(model))
            const isPrimary = models.includes(configModel)
            const modelList = models.slice(0, 3).join(', ') + (models.length > 3 ? ` +${models.length - 3}` : '')
            endpointLines.push(`  ${isPrimary ? '★' : '○'} ${node.id} ${runtime.type} (${hostPort(runtime.endpoint)}): ${modelList || '–'}${reachable ? '' : ' — nicht erreichbar'}`)
        }
    }
    const cloud = [...new Set(cloudModels)].slice(0, 4)
    if (cloud.length > 0) endpointLines.push(`  ☁ Cloud: ${cloud.join(' → ')}`)

    const parts: string[] = []
    if (endpointLines.length > 0) parts.push(`\n*KI-Endpunkte (${endpoints}):*\n${endpointLines.join('\n')}`)
    if (nodes.length > 0) {
        parts.push(`\n*Knoten (${nodes.length}):* ${nodes.map(node =>
            isNodeOnline(node, localNodeId, now) ? node.id : `${node.id} (offline)`).join(', ')}`)
    }
    return parts.join('')
}
