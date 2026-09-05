import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { AIScanResult, DiscoveredAIService } from './ai-scanner.js'
import type { MeshNode } from './mesh-registry.js'
import { getAllModelStats } from '../llm/model-perf-db.js'
import { getOutcomeLedger } from '../core/outcome-ledger.js'

export interface CapabilityRuntime {
    id: string
    name: string
    type: string
    endpoint: string
    status: 'running' | 'installed' | 'stopped'
    models: string[]
    capabilities: string[]
    verifiedAt: string
    expiresAt?: string
    verificationSource: 'probe' | 'mesh-heartbeat'
    metadata?: Record<string, unknown>
}

export interface CapabilityGraphNode {
    id: string
    hostname: string
    host?: string
    status: 'online' | 'offline' | 'busy' | 'unknown'
    lastHeartbeat?: string
    hardware?: MeshNode['hardware']
    software?: MeshNode['software']
    capabilities: string[]
    runtimes: CapabilityRuntime[]
    updatedAt: string
}

export interface CapabilityCandidate {
    nodeId: string
    runtimeId: string
    endpoint: string
    model?: string
    score: number
    verifiedAt: string
    reasons: string[]
}

export interface CapabilityGraphSnapshot {
    version: 1
    updatedAt: string
    nodes: CapabilityGraphNode[]
    tombstones?: Array<{ id: string; deletedAt: string; sourceNode?: string }>
}

const DEFAULT_FILE = join(process.cwd(), '.nova-data', 'capability-graph.json')

function runtimeFromService(service: DiscoveredAIService): CapabilityRuntime {
    return {
        id: service.id,
        name: service.name,
        type: service.type,
        endpoint: service.endpoint,
        status: service.status,
        models: [...service.models],
        capabilities: [...new Set([service.type, service.provider, ...(service.capabilities || [])])],
        verifiedAt: service.lastSeen,
        verificationSource: 'probe',
        metadata: service.metadata,
    }
}

function endpointPort(endpoint: string): string {
    try { return new URL(endpoint).port }
    catch { return '' }
}

function sameRuntime(left: CapabilityRuntime, right: CapabilityRuntime): boolean {
    if (left.id === right.id || left.endpoint === right.endpoint) return true
    return left.name.toLowerCase() === right.name.toLowerCase()
        && left.type === right.type
        && endpointPort(left.endpoint) !== ''
        && endpointPort(left.endpoint) === endpointPort(right.endpoint)
}

function nodePreference(node: CapabilityGraphNode): number {
    let score = 0
    if (node.lastHeartbeat) score += 100
    if (node.status === 'online') score += 50
    if (node.id.startsWith('nova-')) score += 25
    if (node.hardware) score += 10
    return score + Math.max(0, Date.parse(node.updatedAt) / 1e15)
}

function canonicalizeNodes(input: CapabilityGraphNode[]): CapabilityGraphNode[] {
    const groups: Array<{ identities: Set<string>; nodes: CapabilityGraphNode[] }> = []
    for (const node of input) {
        const identities = new Set([
            node.hostname?.trim().toLowerCase(),
            node.host?.trim().toLowerCase(),
        ].filter((value): value is string => Boolean(value) && value !== 'localhost' && value !== '127.0.0.1'))
        const matching = groups.filter(group => [...identities].some(identity => group.identities.has(identity)))
        if (matching.length === 0) {
            groups.push({ identities, nodes: [node] })
            continue
        }
        const target = matching[0]
        target.nodes.push(node)
        for (const identity of identities) target.identities.add(identity)
        for (const duplicate of matching.slice(1)) {
            duplicate.nodes.forEach(item => target.nodes.push(item))
            duplicate.identities.forEach(identity => target.identities.add(identity))
            groups.splice(groups.indexOf(duplicate), 1)
        }
    }

    return groups.map(group => {
        const ranked = [...group.nodes].sort((a, b) => nodePreference(b) - nodePreference(a))
        const winner = ranked[0]
        const runtimes: CapabilityRuntime[] = []
        for (const node of ranked) for (const runtime of node.runtimes || []) {
            const existing = runtimes.findIndex(item => sameRuntime(item, runtime))
            if (existing < 0) runtimes.push(runtime)
            else if (Date.parse(runtime.verifiedAt) > Date.parse(runtimes[existing].verifiedAt)) runtimes[existing] = runtime
        }
        return {
            ...winner,
            hardware: winner.hardware || ranked.find(node => node.hardware)?.hardware,
            software: winner.software || ranked.find(node => node.software)?.software,
            runtimes,
            capabilities: [...new Set([
                ...ranked.flatMap(node => node.capabilities || []),
                ...runtimes.flatMap(runtime => runtime.capabilities || []),
            ])],
        }
    })
}

export class CapabilityGraph {
    private snapshot: CapabilityGraphSnapshot

    constructor(private readonly file = DEFAULT_FILE) {
        this.snapshot = this.load()
        if (file === DEFAULT_FILE && this.snapshot.nodes.length === 0) this.hydrateFromExistingEvidence()
    }

    private hydrateFromExistingEvidence(): void {
        try {
            const scanPath = join(process.cwd(), '.nova-data', 'ai-services.json')
            const meshPath = join(process.cwd(), '.nova-data', 'mesh.json')
            const scan = existsSync(scanPath) ? JSON.parse(readFileSync(scanPath, 'utf8')) as AIScanResult : null
            const mesh = existsSync(meshPath) ? JSON.parse(readFileSync(meshPath, 'utf8')) as { nodes?: MeshNode[] } : null
            if (scan || mesh?.nodes?.length) this.ingest(scan, mesh?.nodes || [])
        } catch { /* wait for the next authoritative scanner pass */ }
    }

    private load(): CapabilityGraphSnapshot {
        try {
            if (existsSync(this.file)) {
                const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as CapabilityGraphSnapshot
                if (parsed.version === 1 && Array.isArray(parsed.nodes)) return parsed
            }
        } catch { /* recover with an empty graph */ }
        return { version: 1, updatedAt: new Date(0).toISOString(), nodes: [], tombstones: [] }
    }

    private save(): void {
        atomicWriteJsonSync(this.file, this.snapshot as unknown as Record<string, unknown>)
    }

    private enrichMeasuredPerformance(nodes: CapabilityGraphNode[]): CapabilityGraphNode[] {
        try {
            const file = join(process.cwd(), '.nova-data', 'model-capabilities.json')
            if (!existsSync(file)) return nodes
            const cache = JSON.parse(readFileSync(file, 'utf8')) as {
                results?: Record<string, {
                    model?: string
                    endpoint?: string
                    probeTime?: string
                    online?: boolean
                    avgLatencyMs?: number
                    tokensPerSecond?: number
                    supportsTools?: boolean
                    supportsVision?: boolean
                    roles?: string[]
                }>
            }
            const results = Object.values(cache.results || {})
            const perfByModel = new Map(getAllModelStats().map(item => [item.model, item]))
            const outcomeRuns = getOutcomeLedger().listRuns(500).filter(run =>
                run.channel !== 'benchmark'
                && !String(run.userId || '').startsWith('benchmark:')
                && typeof run.validation?.success === 'boolean')
            return nodes.map(node => ({
                ...node,
                runtimes: node.runtimes.map(runtime => {
                    const measured = results.filter(result =>
                        result.model
                        && runtime.models.some(model => model === result.model)
                        && (
                            result.endpoint === runtime.endpoint
                            || (endpointPort(result.endpoint || '') !== '' && endpointPort(result.endpoint || '') === endpointPort(runtime.endpoint))
                        ))
                    if (!measured.length) return runtime
                    const latest = measured.sort((a, b) => Date.parse(b.probeTime || '') - Date.parse(a.probeTime || ''))[0]
                    const verifiedAt = latest.probeTime || runtime.verifiedAt
                    const roles = [...new Set(measured.flatMap(result => result.roles || []))]
                    const modelPerformance = Object.fromEntries(runtime.models.map(model => {
                        const historical = perfByModel.get(model)
                        const runs = outcomeRuns.filter(run => run.model === model && (!run.node || run.node === node.id))
                        const toolEvents = runs.flatMap(run => run.tools)
                        const verifiedToolEvents = toolEvents.filter(event => event.verified === true || event.transportVerified === true)
                        const successfulToolEvents = verifiedToolEvents.filter(event => event.success !== false)
                        return [model, {
                            calls: historical?.totalCalls || 0,
                            successRate: historical?.successRate,
                            averageLatencyMs: historical?.avgLatencyMs,
                            toolSamples: verifiedToolEvents.length,
                            toolSuccessRate: verifiedToolEvents.length ? successfulToolEvents.length / verifiedToolEvents.length : undefined,
                        }]
                    }))
                    return {
                        ...runtime,
                        capabilities: [...new Set([...runtime.capabilities, ...roles])],
                        expiresAt: new Date(Date.parse(verifiedAt) + 2 * 60 * 60_000).toISOString(),
                        metadata: {
                            ...(runtime.metadata || {}),
                            performance: Object.fromEntries(measured.map(result => [result.model!, {
                                online: result.online !== false,
                                avgLatencyMs: result.avgLatencyMs,
                                tokensPerSecond: result.tokensPerSecond,
                                supportsTools: result.supportsTools === true,
                                supportsVision: result.supportsVision === true,
                                roles: result.roles || [],
                                measuredAt: result.probeTime,
                            }])),
                            outcomes: modelPerformance,
                        },
                    }
                }),
            }))
        } catch {
            return nodes
        }
    }

    /**
     * Publish one node-local runtime without running a full AI scanner pass.
     * Callers must only provide shareable capability metadata here: this graph
     * is replicated to other mesh nodes and optional remote persistence.
     */
    upsertLocalRuntime(nodeId: string, hostname: string, runtime: CapabilityRuntime): CapabilityGraphSnapshot {
        const now = new Date().toISOString()
        const nodes = new Map(this.snapshot.nodes.map(node => [node.id, node]))
        const current = nodes.get(nodeId) || {
            id: nodeId,
            hostname,
            status: 'online' as const,
            capabilities: [],
            runtimes: [],
            updatedAt: now,
        }
        const runtimes = [...current.runtimes]
        const index = runtimes.findIndex(item => item.id === runtime.id)
        if (index >= 0) runtimes[index] = runtime
        else runtimes.push(runtime)
        nodes.set(nodeId, {
            ...current,
            hostname,
            status: 'online',
            runtimes,
            capabilities: [...new Set(runtimes.flatMap(item => item.capabilities))],
            updatedAt: now,
        })
        this.snapshot = {
            version: 1,
            updatedAt: now,
            nodes: [...nodes.values()],
            tombstones: this.snapshot.tombstones || [],
        }
        this.save()
        return this.getSnapshot()
    }

    ingest(scan: AIScanResult | null, meshNodes: MeshNode[] = [], localNodeId?: string): CapabilityGraphSnapshot {
        const now = new Date().toISOString()
        const byId = new Map(this.snapshot.nodes.map(node => [node.id, node]))

        for (const mesh of meshNodes) {
            const existing = byId.get(mesh.node_id)
            const runtimes = [...(existing?.runtimes || [])]
            for (const service of mesh.software?.ai_services || []) {
                const id = `${mesh.node_id}:${service.name}:${service.endpoint}`
                const runtime: CapabilityRuntime = {
                    id, name: service.name, type: service.type, endpoint: service.endpoint,
                    status: service.status, models: service.models || [],
                    capabilities: [service.type, service.name], verifiedAt: mesh.last_heartbeat,
                    verificationSource: 'mesh-heartbeat',
                }
                const index = runtimes.findIndex(item => sameRuntime(item, runtime))
                if (index >= 0) runtimes[index] = runtime
                else runtimes.push(runtime)
            }
            byId.set(mesh.node_id, {
                id: mesh.node_id, hostname: mesh.hostname, host: mesh.ip,
                status: mesh.status, lastHeartbeat: mesh.last_heartbeat,
                hardware: mesh.hardware, software: mesh.software,
                capabilities: [...new Set([...(mesh.capabilities || []), ...runtimes.flatMap(runtime => runtime.capabilities)])], runtimes, updatedAt: now,
            })
        }

        // Older scanner versions created a synthetic `local` node. Once the
        // real node ID is known, migrate that evidence into the heartbeat node.
        if (localNodeId && localNodeId !== 'local' && byId.has('local')) {
            const local = byId.get('local')!
            const target = byId.get(localNodeId)
            if (target) {
                for (const runtime of local.runtimes) {
                    if (!target.runtimes.some(item => sameRuntime(item, runtime))) target.runtimes.push(runtime)
                }
                target.capabilities = [...new Set([...target.capabilities, ...local.capabilities])]
                byId.delete('local')
            }
        }

        for (const service of scan?.services || []) {
            const hintedNode = service.sourceNode && service.sourceNode !== 'local' ? service.sourceNode : undefined
            const isLocalService = service.host === 'localhost' || service.host === '127.0.0.1' || service.sourceNode === 'local'
            const matched = [...byId.values()]
                .filter(node =>
                    node.id === hintedNode
                    || node.hostname === hintedNode
                    || node.host === service.host
                    || (isLocalService && localNodeId && node.id === localNodeId))
                .sort((a, b) => {
                    const aExactHost = a.host === service.host ? 1 : 0
                    const bExactHost = b.host === service.host ? 1 : 0
                    return (nodePreference(b) + bExactHost * 20) - (nodePreference(a) + aExactHost * 20)
                })[0]
            const nodeId = matched?.id || hintedNode || (isLocalService ? (localNodeId || 'local') : service.host)
            const node = matched || byId.get(nodeId) || {
                id: nodeId, hostname: hintedNode || service.host, host: service.host,
                status: 'unknown' as const, capabilities: [], runtimes: [], updatedAt: now,
            }
            const runtime = runtimeFromService(service)
            const index = node.runtimes.findIndex(item => sameRuntime(item, runtime))
            if (index >= 0) node.runtimes[index] = runtime
            else node.runtimes.push(runtime)
            node.capabilities = [...new Set([...node.capabilities, ...runtime.capabilities])]
            node.updatedAt = now
            byId.set(nodeId, node)
        }

        this.snapshot = {
            version: 1,
            updatedAt: now,
            nodes: this.enrichMeasuredPerformance(canonicalizeNodes([...byId.values()])),
            tombstones: this.snapshot.tombstones || [],
        }
        this.save()
        return this.getSnapshot()
    }

    merge(remote: CapabilityGraphSnapshot, sourceNode?: string): CapabilityGraphSnapshot {
        if (remote?.version !== 1 || !Array.isArray(remote.nodes)) return this.getSnapshot()
        const tombstones = new Map((this.snapshot.tombstones || []).map(item => [item.id, item]))
        for (const item of remote.tombstones || []) {
            const current = tombstones.get(item.id)
            if (!current || Date.parse(item.deletedAt) > Date.parse(current.deletedAt)) tombstones.set(item.id, item)
        }
        const nodes = new Map(this.snapshot.nodes.map(node => [node.id, node]))
        for (const incoming of remote.nodes) {
            if (!incoming?.id || !Array.isArray(incoming.runtimes)) continue
            const existing = nodes.get(incoming.id)
            if (!existing || Date.parse(incoming.updatedAt) > Date.parse(existing.updatedAt)) {
                nodes.set(incoming.id, {
                    ...incoming,
                    runtimes: incoming.runtimes.filter(runtime => !tombstones.has(runtime.id)),
                })
            }
        }
        const mergedNodes = canonicalizeNodes([...nodes.values()]).map(node => ({
            ...node,
            runtimes: node.runtimes.filter(runtime => !tombstones.has(runtime.id)),
        }))
        this.snapshot = {
            version: 1,
            updatedAt: new Date().toISOString(),
            nodes: this.enrichMeasuredPerformance(mergedNodes),
            tombstones: [...tombstones.values()],
        }
        this.save()
        return this.getSnapshot()
    }

    pruneStale(
        runtimeMaxAgeMs = 24 * 60 * 60_000,
        nodeMaxAgeMs = 7 * 24 * 60 * 60_000,
        nodeOnlineMaxAgeMs = 75_000,
    ): CapabilityGraphSnapshot {
        const now = Date.now()
        const tombstones = new Map((this.snapshot.tombstones || []).map(item => [item.id, item]))
        const nodes = this.snapshot.nodes.flatMap(node => {
            const nodeAge = now - Date.parse(node.lastHeartbeat || node.updatedAt)
            if (Number.isFinite(nodeAge) && nodeAge > nodeMaxAgeMs) {
                for (const runtime of node.runtimes) tombstones.set(runtime.id, { id: runtime.id, deletedAt: new Date().toISOString(), sourceNode: node.id })
                return []
            }
            const runtimes = node.runtimes.filter(runtime => {
                const stale = now - Date.parse(runtime.verifiedAt) > runtimeMaxAgeMs
                if (stale) tombstones.set(runtime.id, { id: runtime.id, deletedAt: new Date().toISOString(), sourceNode: node.id })
                return !stale
            })
            const status = node.lastHeartbeat && nodeAge > nodeOnlineMaxAgeMs ? 'offline' as const : node.status
            return [{ ...node, status, runtimes, capabilities: [...new Set(runtimes.flatMap(runtime => runtime.capabilities))] }]
        })
        const tombstoneCutoff = now - 30 * 24 * 60 * 60_000
        this.snapshot = {
            version: 1, updatedAt: new Date().toISOString(), nodes,
            tombstones: [...tombstones.values()].filter(item => Date.parse(item.deletedAt) >= tombstoneCutoff),
        }
        this.save()
        return this.getSnapshot()
    }

    getSnapshot(): CapabilityGraphSnapshot {
        return JSON.parse(JSON.stringify(this.snapshot)) as CapabilityGraphSnapshot
    }

    findCandidates(query: { type?: string; model?: string; capability?: string; maxAgeMs?: number }): CapabilityCandidate[] {
        const now = Date.now()
        const maxAge = query.maxAgeMs ?? 5 * 60_000
        const candidates: CapabilityCandidate[] = []
        for (const node of this.snapshot.nodes) for (const runtime of node.runtimes) {
            if (node.status !== 'online' && node.status !== 'busy') continue
            if (runtime.status !== 'running') continue
            if (query.type && runtime.type !== query.type) continue
            if (query.model && !runtime.models.some(model => model.toLowerCase().includes(query.model!.toLowerCase()))) continue
            if (query.capability && ![...node.capabilities, ...runtime.capabilities].includes(query.capability)) continue
            const age = now - Date.parse(runtime.verifiedAt)
            if (!Number.isFinite(age) || age > maxAge) continue
            const reasons = ['live probe or heartbeat', `${runtime.name} running`]
            let score = 100 - Math.min(50, age / 10_000)
            if (node.hardware?.gpu_vram_mb) { score += Math.min(80, node.hardware.gpu_vram_mb / 512); reasons.push(`${node.hardware.gpu_vram_mb} MB VRAM`) }
            if (query.model && runtime.models.length) score += 30
            candidates.push({ nodeId: node.id, runtimeId: runtime.id, endpoint: runtime.endpoint, model: query.model, score, verifiedAt: runtime.verifiedAt, reasons })
        }
        return candidates.sort((a, b) => b.score - a.score)
    }
}

let singleton: CapabilityGraph | null = null
export function getCapabilityGraph(): CapabilityGraph {
    singleton ||= new CapabilityGraph()
    return singleton
}
