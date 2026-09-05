import { createHash } from 'node:crypto'
import { pullSharedMemory, pushSharedMemory } from '../memory/shared-memory.js'
import { getCapabilityGraph, type CapabilityGraphSnapshot } from './capability-graph.js'
import { discoverNodes, getLocalNodeId } from './mesh-registry.js'

const SCOPE = 'capability-graph'
let timer: ReturnType<typeof setInterval> | null = null
let lastHash = ''
let lastPull = 0

function hash(snapshot: CapabilityGraphSnapshot): string {
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export async function syncCapabilityGraphOnce(): Promise<{ pushed: boolean; merged: number }> {
    const nodeId = getLocalNodeId()
    const graph = getCapabilityGraph()
    try {
        const { getLastScanResult } = await import('./ai-scanner.js')
        graph.ingest(getLastScanResult(), await discoverNodes(), nodeId)
    } catch { /* keep the last verified snapshot until the next scanner pass */ }
    graph.pruneStale()
    let snapshot = graph.getSnapshot()
    const currentHash = hash(snapshot)
    let pushed = false
    if (currentHash !== lastHash) {
        pushed = await pushSharedMemory({
            id: `capability-graph:${nodeId}`,
            userId: 'nova-system', role: 'system', scope: SCOPE,
            content: JSON.stringify(snapshot), timestamp: Date.now(), sourceNode: nodeId,
            metadata: { schemaVersion: 1, hash: currentHash },
        })
        if (pushed) lastHash = currentHash
    }

    const entries = await pullSharedMemory({ since: lastPull || Date.now() - 24 * 60 * 60_000, limit: 200 })
    let merged = 0
    for (const entry of entries.filter(item => item.scope === SCOPE && item.sourceNode !== nodeId)) {
        try {
            graph.merge(JSON.parse(entry.content) as CapabilityGraphSnapshot, entry.sourceNode)
            merged++
            lastPull = Math.max(lastPull, entry.timestamp)
        } catch { /* ignore corrupt or incompatible remote snapshots */ }
    }
    snapshot = graph.getSnapshot()
    lastHash = hash(snapshot)
    try {
        const { getMeshTransport } = await import('./mesh-transport-runtime.js')
        const transport = getMeshTransport()
        if (transport) await transport.broadcast(transport.create('node.capabilities', '*', { snapshot }, { ttlMs: 5 * 60_000 }))
    } catch { /* direct mesh is optional */ }
    return { pushed, merged }
}

export function startCapabilityGraphSync(intervalMs = 60_000): void {
    if (timer) return
    void syncCapabilityGraphOnce()
    timer = setInterval(() => { void syncCapabilityGraphOnce() }, intervalMs)
    if (timer.unref) timer.unref()
}

export function stopCapabilityGraphSync(): void {
    if (timer) clearInterval(timer)
    timer = null
}
