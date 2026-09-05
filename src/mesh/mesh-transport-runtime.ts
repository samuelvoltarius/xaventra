import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { getCapabilityGraph } from './capability-graph.js'
import { DirectMeshTransport } from './direct-mesh-transport.js'
import { LocalMeshTransport } from './local-mesh-transport.js'
import { MeshIdentity } from './mesh-identity.js'
import { containsFreeShellPayload } from './mesh-policy.js'
import { MeshTransportRouter } from './mesh-transport-router.js'
import { RelayMeshTransport } from './relay-mesh-transport.js'
import { SupabaseMeshTransport } from './supabase-mesh-transport.js'
import type {
    AgentRequestPayload, CapabilityPayload, CodexCompletionRequestPayload, CodexStatusRequestPayload, MeshAck, MeshEnvelope, MeshMode, MeshPeer,
    MeshPrincipal, MissionRequestPayload, ResultPayload, ToolInventoryPayload, ToolRequestPayload,
} from './transport-contracts.js'
import { getLocalNodeId, getLocalNodeSnapshot } from './mesh-registry.js'
import { resolveConfigPath } from '../config/config-path.js'


type MessageHandler = (channel: string, userId: string, content: string, reply: (content: string) => Promise<void>) => Promise<void>

interface RuntimeConfig {
    mode: MeshMode
    allowTofu: boolean
    allowedTools?: string[]
    direct: { enabled: boolean; listenHost?: string; port?: number; peers: MeshPeer[]; allowInsecureLan?: boolean }
    supabase: { url?: string; key?: string; table?: string }
    relay: { url?: string; token?: string }
}

let router: MeshTransportRouter | null = null
let runtimeMessageHandler: MessageHandler | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const results = new Map<string, ResultPayload>()
const processed = new Map<string, ResultPayload>()
interface PeerState {
    nodeId: string; lastSeen: number; status?: string; uptimeMs?: number
    capabilities?: unknown; tools?: ToolInventoryPayload; publicKeyFingerprint?: string
}
const peerStatePath = join(getNovaDataDir(), 'mesh-peer-state.json')
let peerStates: Record<string, PeerState> = (() => {
    try { return JSON.parse(readFileSync(peerStatePath, 'utf8')) as Record<string, PeerState> } catch { return {} }
})()

function persistPeerStates(): void {
    const dir = getNovaDataDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const temporary = `${peerStatePath}.tmp`; writeFileSync(temporary, JSON.stringify(peerStates, null, 2)); renameSync(temporary, peerStatePath)
}

function rawConfig(): any {
    try { return JSON.parse(readFileSync(resolveConfigPath(), 'utf8')) } catch { return {} }
}

function loadRuntimeConfig(): RuntimeConfig {
    const config = rawConfig()
    const mesh = config.mesh || {}
    const direct = mesh.direct || {}
    const peers = (direct.peers || []).map((peer: any): MeshPeer => ({
        nodeId: String(peer.nodeId || peer.name || ''), url: peer.url ? String(peer.url) : undefined,
        transport: 'direct', status: 'unknown', publicKey: peer.publicKey ? String(peer.publicKey) : undefined,
        allowedTools: Array.isArray(peer.allowedTools) ? peer.allowedTools.map(String) : undefined,
        roles: Array.isArray(peer.roles) ? peer.roles : ['system', 'owner', 'admin', 'worker'],
    })).filter((peer: MeshPeer) => peer.nodeId)
    const supabase = {
        url: process.env.NOVA_MESH_SUPABASE_URL || config.supabase?.meshUrl,
        key: process.env.NOVA_MESH_SUPABASE_KEY || config.supabase?.meshKey,
        table: mesh.supabase?.table || 'nova_mesh_envelopes',
    }
    return {
        mode: mesh.mode || (supabase.url && supabase.key ? 'ha' : peers.length ? 'direct' : 'standalone'),
        allowTofu: mesh.security?.allowTofu === true,
        allowedTools: mesh.security?.allowedTools,
        direct: {
            enabled: direct.enabled !== false, listenHost: direct.listenHost || '0.0.0.0',
            port: Number(process.env.NOVA_MESH_DIRECT_PORT || direct.port || 9091), peers,
            allowInsecureLan: direct.allowInsecureLan === true,
        },
        supabase, relay: { url: mesh.relay?.url, token: process.env.NOVA_MESH_RELAY_TOKEN || mesh.relay?.token },
    }
}

export function initMeshTransportRuntime(messageHandler?: MessageHandler): MeshTransportRouter {
    if (messageHandler) runtimeMessageHandler = messageHandler
    if (router) return router
    const nodeId = getLocalNodeId()
    const config = loadRuntimeConfig()
    const identity = new MeshIdentity(nodeId)
    const principal: MeshPrincipal = { id: `node:${nodeId}`, role: 'system', channel: 'mesh' }
    const local = new LocalMeshTransport(nodeId)
    const direct = new DirectMeshTransport(identity, principal, config.direct)
    if (config.direct.enabled) direct.start()
    const supabase = new SupabaseMeshTransport(nodeId, config.supabase)
    const relay = new RelayMeshTransport(nodeId, config.relay)
    router = new MeshTransportRouter(identity, principal, { mode: config.mode, peers: config.direct.peers, allowTofu: config.allowTofu, allowedTools: config.allowedTools }, [direct, supabase, relay, local])
    router.subscribe(envelope => handleEnvelope(envelope, runtimeMessageHandler))
    console.log(`[MeshTransport] mode=${config.mode} node=${nodeId} direct=:${config.direct.port} peers=${config.direct.peers.length} key=${MeshIdentity.fingerprint(identity.publicKey)}`)
    return router
}

export function getMeshTransport(): MeshTransportRouter | null { return router }

export async function sendAgentRequest(targetNode: string, prompt: string, options: Partial<AgentRequestPayload> = {}): Promise<{ requestId: string; ack: MeshAck }> {
    const transport = router || initMeshTransportRuntime()
    const runId = randomUUID()
    const payload: AgentRequestPayload = {
        prompt, taskType: options.taskType, allowedTools: options.allowedTools,
        successCriteria: options.successCriteria, budget: options.budget,
        idempotencyKey: options.idempotencyKey || runId,
    }
    const envelope = transport.create('agent.request', targetNode, payload, { runId, ttlMs: Math.max(60_000, payload.budget?.timeoutMs || 0) })
    return { requestId: envelope.id, ack: await transport.send(targetNode, envelope) }
}

export async function sendToolRequest(targetNode: string, payload: ToolRequestPayload): Promise<{ requestId: string; ack: MeshAck }> {
    const transport = router || initMeshTransportRuntime()
    const runId = randomUUID()
    const envelope = transport.create('tool.request', targetNode, payload, { runId, ttlMs: Math.max(30_000, payload.timeoutMs || 0) })
    return { requestId: envelope.id, ack: await transport.send(targetNode, envelope) }
}

export async function sendCodexStatusRequest(targetNode: string, principalId: string): Promise<{ requestId: string; ack: MeshAck }> {
    const transport = router || initMeshTransportRuntime()
    const runId = randomUUID()
    const payload: CodexStatusRequestPayload = { idempotencyKey: `codex-status:${runId}` }
    const envelope = transport.create('codex.status.request', targetNode, payload, {
        runId, ttlMs: 30_000, principal: { id: principalId, role: 'system', channel: 'mesh-codex' },
    })
    return { requestId: envelope.id, ack: await transport.send(targetNode, envelope) }
}

export async function sendCodexCompletionRequest(
    targetNode: string,
    principalId: string,
    payload: Omit<CodexCompletionRequestPayload, 'idempotencyKey'>,
    runId: string = randomUUID(),
): Promise<{ requestId: string; ack: MeshAck }> {
    const transport = router || initMeshTransportRuntime()
    const envelope = transport.create('codex.complete.request', targetNode, { ...payload, idempotencyKey: `codex-complete:${runId}` }, {
        runId, ttlMs: 90_000, principal: { id: principalId, role: 'system', channel: 'mesh-codex' },
    })
    return { requestId: envelope.id, ack: await transport.send(targetNode, envelope) }
}

export async function waitForMeshRunResult(requestId: string, timeoutMs = 10_000): Promise<ResultPayload | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const result = results.get(requestId)
        if (result) {
            results.delete(requestId)
            return result
        }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
}

export function getMeshRunResult(requestId: string): ResultPayload | undefined { return results.get(requestId) }
export function getMeshPeerStates(): Readonly<Record<string, PeerState>> { return Object.freeze({ ...peerStates }) }

export async function publishMeshCheckpoint(targetNode: string, runId: string, payload: Record<string, unknown>, fence?: any): Promise<MeshAck> {
    const transport = router || initMeshTransportRuntime()
    const envelope = transport.create('run.checkpoint', targetNode, payload, { runId, fence, ttlMs: 24 * 60 * 60_000 })
    return transport.send(targetNode, envelope)
}

export async function publishMeshEvidence(targetNode: string, runId: string, payload: Record<string, unknown>): Promise<MeshAck> {
    const transport = router || initMeshTransportRuntime()
    const envelope = transport.create('run.evidence', targetNode, payload, { runId, ttlMs: 24 * 60 * 60_000 })
    return transport.send(targetNode, envelope)
}

export function startMeshDataPlane(intervalMs = 30_000): void {
    if (heartbeatTimer) return
    const publish = async () => {
        const transport = router || initMeshTransportRuntime()
        const heartbeat = transport.create('node.heartbeat', '*', { status: 'online', uptimeMs: Math.round(process.uptime() * 1000) })
        await transport.broadcast(heartbeat)
        const localNode = getLocalNodeSnapshot()
        const verifiedAt = localNode?.last_heartbeat || new Date().toISOString()
        const capabilityPayload: CapabilityPayload = {
            hostname: localNode?.hostname,
            platform: localNode?.platform,
            hardware: localNode?.hardware as unknown as Record<string, unknown> | undefined,
            capabilities: localNode?.capabilities || [],
            runtimes: (localNode?.software?.ai_services || []).map(service => ({
                name: service.name,
                type: service.type,
                endpoint: service.endpoint,
                models: service.models,
                capabilities: [service.type, service.name],
                status: service.status,
                verifiedAt,
            })),
        }
        const capability = transport.create('node.capabilities', '*', capabilityPayload)
        await transport.broadcast(capability)
        try {
            const { getToolRegistry } = await import('../tools/complete-registry.js')
            const tools = getToolRegistry().getAll().map(tool => ({ name: tool.name, description: tool.description, category: tool.category }))
            const inventoryHash = createHash('sha256').update(JSON.stringify(tools.map(tool => tool.name).sort())).digest('hex')
            const inventory = transport.create<ToolInventoryPayload>('node.tools', '*', { tools, inventoryHash })
            await transport.broadcast(inventory)
        } catch { /* registry may not be initialized during fast boot */ }
    }
    void publish()
    heartbeatTimer = setInterval(() => { void publish() }, intervalMs)
    if (heartbeatTimer.unref) heartbeatTimer.unref()
}

export async function stopMeshTransportRuntime(): Promise<void> {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    await router?.close()
    router = null
    runtimeMessageHandler = undefined
}

async function handleEnvelope(envelope: MeshEnvelope, messageHandler?: MessageHandler): Promise<void> {
    if (!router) return
    if (envelope.kind === 'node.heartbeat') {
        const payload = envelope.payload as { status?: string; uptimeMs?: number }
        peerStates[envelope.sourceNode] = { ...peerStates[envelope.sourceNode], nodeId: envelope.sourceNode, lastSeen: Date.now(), status: payload.status, uptimeMs: payload.uptimeMs, publicKeyFingerprint: MeshIdentity.fingerprint(envelope.publicKey) }
        persistPeerStates(); return
    }
    if (envelope.kind === 'node.tools') {
        peerStates[envelope.sourceNode] = { ...peerStates[envelope.sourceNode], nodeId: envelope.sourceNode, lastSeen: Date.now(), tools: envelope.payload as ToolInventoryPayload, publicKeyFingerprint: MeshIdentity.fingerprint(envelope.publicKey) }
        persistPeerStates(); return
    }
    if (envelope.kind === 'run.result') {
        const result = envelope.payload as ResultPayload
        if (result?.requestId) {
            results.set(result.requestId, result)
            try {
                const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
                for (const evidence of result.evidence || []) getOutcomeLedger().recordTool(envelope.runId || result.requestId, { ...evidence, sourceNode: envelope.sourceNode, transportVerified: true })
                const isIntermediateCodexInference = (result.evidence || []).some(item => item.tool === 'codex_inference')
                if (!isIntermediateCodexInference) {
                    if (result.success) getOutcomeLedger().complete(envelope.runId || result.requestId, { meshResult: result.result, sourceNode: envelope.sourceNode })
                    else getOutcomeLedger().fail(envelope.runId || result.requestId, { error: result.error, sourceNode: envelope.sourceNode })
                }
            } catch { /* ledger optional */ }
        }
        return
    }
    if (envelope.kind === 'node.capabilities') {
        const payload = envelope.payload as { snapshot?: any } & CapabilityPayload
        if (payload.snapshot) getCapabilityGraph().merge(payload.snapshot, envelope.sourceNode)
        else if (Array.isArray(payload.runtimes)) {
            const now = new Date().toISOString()
            getCapabilityGraph().merge({
                version: 1,
                updatedAt: now,
                nodes: [{
                    id: envelope.sourceNode,
                    hostname: payload.hostname || envelope.sourceNode,
                    status: 'online',
                    lastHeartbeat: now,
                    hardware: payload.hardware as any,
                    capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.map(String) : [],
                    runtimes: payload.runtimes.map((runtime, index) => ({
                        id: `${envelope.sourceNode}:${runtime.name || runtime.type}:${runtime.endpoint || index}`,
                        name: runtime.name || runtime.type,
                        type: runtime.type,
                        endpoint: runtime.endpoint || '',
                        status: ['running', 'installed', 'stopped'].includes(runtime.status) ? runtime.status as 'running' | 'installed' | 'stopped' : 'stopped',
                        models: Array.isArray(runtime.models) ? runtime.models.map(String) : [],
                        capabilities: Array.isArray(runtime.capabilities) ? runtime.capabilities.map(String) : [runtime.type],
                        verifiedAt: runtime.verifiedAt || now,
                        verificationSource: 'mesh-heartbeat' as const,
                    })),
                    updatedAt: now,
                }],
                tombstones: [],
            }, envelope.sourceNode)
        }
        peerStates[envelope.sourceNode] = { ...peerStates[envelope.sourceNode], nodeId: envelope.sourceNode, lastSeen: Date.now(), capabilities: payload, publicKeyFingerprint: MeshIdentity.fingerprint(envelope.publicKey) }
        persistPeerStates()
        return
    }
    if (envelope.kind === 'run.evidence') {
        if (!envelope.runId) throw new Error('evidence requires runId')
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        getOutcomeLedger().recordTool(envelope.runId, { ...(envelope.payload as Record<string, unknown>), sourceNode: envelope.sourceNode, envelopeId: envelope.id, transportVerified: true })
        return
    }
    if (envelope.kind === 'run.progress') {
        if (!envelope.runId) throw new Error('progress requires runId')
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        getOutcomeLedger().recordPlan(envelope.runId, { meshProgress: envelope.payload, sourceNode: envelope.sourceNode, envelopeId: envelope.id })
        return
    }
    if (envelope.kind === 'run.checkpoint') {
        if (!envelope.runId) throw new Error('checkpoint requires runId')
        const payload = envelope.payload as Record<string, any>
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        getOutcomeLedger().saveCheckpoint({
            runId: envelope.runId, backend: String(payload.backend || 'mesh'), backendState: typeof payload.backendState === 'string' ? payload.backendState : JSON.stringify(payload.state || payload),
            phase: String(payload.phase || 'running'), pendingActions: Array.isArray(payload.pendingActions) ? payload.pendingActions.map(String) : [],
            completedIdempotencyKeys: Array.isArray(payload.completedIdempotencyKeys) ? payload.completedIdempotencyKeys.map(String) : [],
            ownerNode: envelope.sourceNode, leaseEpoch: envelope.fence?.epoch,
        })
        return
    }
    if (envelope.kind === 'agent.request') {
        const payload = envelope.payload as AgentRequestPayload
        if (!payload?.prompt || containsFreeShellPayload(payload)) throw new Error('invalid agent request')
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, cached)
        if (!messageHandler) throw new Error('agent handler unavailable')
        let output = ''
        try {
            await messageHandler('mesh-direct', envelope.principal.id, payload.prompt, async content => { output += content })
            const result = makeResult(envelope.id, true, output)
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'codex.status.request') {
        const payload = envelope.payload as CodexStatusRequestPayload
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, cached)
        try {
            const { getCodexRuntimeStatus } = await import('../auth/codex-runtime.js')
            const status = await getCodexRuntimeStatus(envelope.principal.id)
            const result = makeResult(envelope.id, true, { available: status.available, authenticated: status.authenticated, nodeId: status.nodeId })
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'codex.complete.request') {
        const payload = envelope.payload as CodexCompletionRequestPayload
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, cached)
        const startedAt = Date.now()
        try {
            const [{ CodexAppServerLLM }, { getCodexRuntimeStatus }] = await Promise.all([
                import('../auth/codex-app-server.js'), import('../auth/codex-runtime.js'),
            ])
            const status = await getCodexRuntimeStatus(envelope.principal.id)
            if (!status.authenticated) throw new Error('Codex is not authenticated for this principal on this node')
            const llm = new CodexAppServerLLM(envelope.principal.id, status.nodeId, payload.model || 'gpt-5.4')
            const completion = await llm.complete(payload.messages as any, payload.tools as any, { toolChoice: payload.toolChoice })
            const resultHash = createHash('sha256').update(JSON.stringify(completion)).digest('hex')
            const result: ResultPayload = {
                requestId: envelope.id,
                success: true,
                result: completion,
                evidence: [{ tool: 'codex_inference', requestHash: envelope.payloadHash, resultHash, verified: true, durationMs: Date.now() - startedAt }],
            }
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'tool.request') {
        const payload = envelope.payload as ToolRequestPayload
        if (containsFreeShellPayload(payload.arguments)) throw new Error('free shell payload rejected')
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, cached)
        const started = Date.now()
        try {
            const { getToolRegistry } = await import('../tools/complete-registry.js')
            const resultValue = await getToolRegistry().execute(payload.tool, payload.arguments)
            const resultHash = createHash('sha256').update(JSON.stringify(resultValue)).digest('hex')
            const result: ResultPayload = { requestId: envelope.id, success: true, result: resultValue, evidence: [{ tool: payload.tool, requestHash: envelope.payloadHash, resultHash, verified: true, durationMs: Date.now() - started }] }
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            processed.set(payload.idempotencyKey, result); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'mission.request') {
        const payload = envelope.payload as MissionRequestPayload
        if (!envelope.fence) throw new Error('mission handoff requires fence')
        const { acceptMissionHandoff } = await import('../core/autonomous-executor.js')
        const accepted = acceptMissionHandoff(payload.checkpoint, { ownerNode: getLocalNodeId(), leaseEpoch: envelope.fence.epoch, fencingToken: envelope.fence.token })
        await sendResult(envelope, makeResult(envelope.id, accepted, accepted ? `Mission ${payload.missionId} accepted` : undefined, accepted ? undefined : 'mission checkpoint rejected'))
    }
}

function makeResult(requestId: string, success: boolean, result?: unknown, error?: string): ResultPayload {
    const resultHash = createHash('sha256').update(JSON.stringify(result ?? error ?? null)).digest('hex')
    return { requestId, success, result, error, evidence: [{ resultHash, verified: true }] }
}

async function sendResult(request: MeshEnvelope, result: ResultPayload): Promise<void> {
    if (!router) return
    const response = router.create('run.result', request.sourceNode, result, { runId: request.runId, ttlMs: 24 * 60 * 60_000 })
    await router.send(request.sourceNode, response)
}

export function meshTransportPublicIdentity(): { nodeId: string; publicKey: string; fingerprint: string } | null {
    if (!router) return null
    return { nodeId: router.identity.nodeId, publicKey: router.identity.publicKey, fingerprint: MeshIdentity.fingerprint(router.identity.publicKey) }
}
