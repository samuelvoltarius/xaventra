import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { getCapabilityGraph } from './capability-graph.js'
import { DirectMeshTransport } from './direct-mesh-transport.js'
import { LocalMeshTransport } from './local-mesh-transport.js'
import { MeshIdentity } from './mesh-identity.js'
import { containsFreeShellPayload, DEFAULT_PEER_ROLES, peersWithoutKeys } from './mesh-policy.js'
import { MeshTransportRouter } from './mesh-transport-router.js'
import { RelayMeshTransport } from './relay-mesh-transport.js'
import { SupabaseMeshTransport } from './supabase-mesh-transport.js'
import type {
    AgentRequestPayload, CapabilityPayload, CodexCompletionRequestPayload, CodexStatusRequestPayload, MeshAck, MeshEnvelope, MeshFence, MeshMode, MeshPeer,
    MeshPrincipal, MissionRequestPayload, ResultPayload, RunCancelPayload, ToolInventoryPayload, ToolRequestPayload,
} from './transport-contracts.js'
import { getLocalNodeId, getLocalNodeSnapshot } from './mesh-registry.js'
import { resolveConfigPath } from '../config/config-path.js'
import { assertFenced, getFencingMode, getHeldFence, runWithDelegatedFence } from './fence.js'
import { checkDelegatedFence } from './fence-highwater.js'
import { heartbeatProfileFields, peerWantsProfile, sanitizeNodeProfile, type NodeProfile, type ProfilePublishState } from '../core/node-profile.js'
import { sanitizeSelfHealSummary, type SelfHealMeshSummary } from '../doctor/self-heal.js'
import { executeExchange, validExchangeRequest, validateExchangeResult, type ExchangeRequest, type ExchangeFile } from './node-exchange.js'
import { captureEnrolledNode, validateNodeCapture, validNodeCaptureRequest, type NodeCaptureRequest, type NodeCaptureReceipt } from './node-capture.js'


export interface MeshAgentExecutionOptions {
    abortSignal: AbortSignal
    allowedTools: string[]
    requestId: string
}

type MessageHandler = (
    channel: string,
    userId: string,
    content: string,
    reply: (content: string) => Promise<void>,
    image?: { data: string; mimeType: string },
    execution?: MeshAgentExecutionOptions,
) => Promise<void>

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
const activeAgentRuns = new Map<string, AbortController>()
const cancelledAgentRuns = new Map<string, number>()
const exchangePending = new Map<string, { node: string; expiresAt: number }>()
const capturePending = new Map<string, { node: string; receive: (value: unknown) => void }>()
const forRequest = (result: ResultPayload, requestId: string): ResultPayload => ({ ...result, requestId })
/** MI-17: idempotency/result caches are bounded (oldest entries evicted first). */
export const MAX_PROCESSED_RESULTS = 2_000
export const MAX_PENDING_RESULTS = 1_000
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > max) {
        const oldest = map.keys().next()
        if (oldest.done) break
        map.delete(oldest.value)
    }
}
interface PeerState {
    nodeId: string; lastSeen: number; status?: string; uptimeMs?: number
    /** Hotfix 2.80.1: the peer's process start id, to notice a restart. */
    bootId?: string
    capabilities?: unknown; tools?: ToolInventoryPayload; publicKeyFingerprint?: string
    /** Kept separately: capability-graph snapshots reuse node.capabilities without a profile. */
    profile?: NodeProfile; profileSeen?: number
    /** Stufe 3: the worker's self-heal summary, sent only on change; workers never notify the owner themselves. */
    selfHeal?: SelfHealMeshSummary; selfHealSeen?: number
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
        // Fail-closed: privileged roles (system/owner/admin) must be configured explicitly per peer.
        roles: Array.isArray(peer.roles) && peer.roles.length ? peer.roles : [...DEFAULT_PEER_ROLES],
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

/** Wächter: peers that may deliver samples — configured AND with a pinned publicKey. */
export function watchKnownNodes(peers: readonly MeshPeer[] = loadRuntimeConfig().direct.peers): string[] {
    return peers.filter(peer => peer.nodeId && String(peer.publicKey || '').trim()).map(peer => peer.nodeId)
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
    const keyless = peersWithoutKeys(config.direct.peers)
    if (keyless.length) {
        console.warn(`[MeshTransport] WARNING: peers without publicKey will be ${config.allowTofu ? 'trusted on first use (mesh.security.allowTofu=true)' : 'REJECTED (missing_peer_key)'}: ${keyless.join(', ')}. ` +
            'Migration: run `npm run mesh:identity` on each peer and copy its publicKey into mesh.direct.peers[].publicKey ' +
            `and list roles explicitly (default is ${DEFAULT_PEER_ROLES.join(',')}).`)
    }
    console.log(`[MeshTransport] mode=${config.mode} node=${nodeId} direct=:${config.direct.port} peers=${config.direct.peers.length} key=${MeshIdentity.fingerprint(identity.publicKey)}`)
    return router
}

export function getMeshTransport(): MeshTransportRouter | null { return router }

export async function requestNodeCapture(node: string, payload: NodeCaptureRequest): Promise<NodeCaptureReceipt> {
    if (!node || node === '*' || !validNodeCaptureRequest(payload)) throw new Error('invalid capture target/context')
    const check = async () => { await assertFenced('nova-main', { live: true, mode: 'enforce', effect: 'mesh:capture.request' }) }
    await check()
    if (node === getLocalNodeId()) return captureEnrolledNode(node, check)
    if (capturePending.size >= 4) throw new Error('Capture concurrency limit reached')
    const transport = router || initMeshTransportRuntime()
    const envelope = transport.create('capture.request', node, payload, { ttlMs: 30_000, fence: currentMainMeshFence() })
    let timer: ReturnType<typeof setTimeout> | undefined
    const response = new Promise<unknown>(resolve => {
        capturePending.set(envelope.id, { node, receive: resolve })
        timer = setTimeout(() => resolve(null), 30_000)
    })
    try {
        const ack = await transport.send(node, envelope)
        if (!['delivered', 'duplicate'].includes(ack.status)) throw new Error('No direct node capture path')
        const reply = await response as ResultPayload | null
        if (reply?.success !== true) throw new Error(typeof reply?.error === 'string' ? reply.error.slice(0, 200) : 'Node capture timed out; no image confirmed')
        await check()
        return validateNodeCapture(reply.result, node)
    } finally { clearTimeout(timer); capturePending.delete(envelope.id) }
}

export function currentCaptureNodes(): string[] {
    return [getLocalNodeId(), ...Object.values(peerStates).filter(p => Date.now() - p.lastSeen < 120_000 && watchKnownNodes().includes(p.nodeId)).map(p => p.nodeId)].filter((id, i, all) => all.indexOf(id) === i).slice(0, 16)
}

/** Main orchestrates transfers; remote receipts are bound to the requested node. */
export async function requestNodeExchange(node: string, payload: ExchangeRequest): Promise<unknown> {
    if (!validExchangeRequest(payload) || !node || node === '*') throw new Error('invalid exchange target/request')
    await assertFenced('nova-main', { live: true, mode: 'enforce', effect: 'mesh:exchange.request' })
    if (node === getLocalNodeId()) return executeExchange(payload, undefined, async () => {
        await assertFenced('nova-main', { live: true, mode: 'enforce', effect: 'mesh:exchange.commit' })
    })
    const transport = router || initMeshTransportRuntime()
    const envelope = transport.create('exchange.request', node, payload, { ttlMs: 30_000, fence: currentMainMeshFence() })
    if (exchangePending.size >= 64) throw new Error('too many pending exchanges')
    exchangePending.set(envelope.id, { node, expiresAt: envelope.expiresAt })
    try {
        const ack = await transport.send(node, envelope)
        if (ack.status === 'rejected' || ack.status === 'unreachable') throw new Error(`exchange not delivered: ${ack.status}`)
        const result = await waitForMeshRunResult(envelope.id, 30_000)
        if (!result) throw new Error('exchange receipt timed out; transfer is unconfirmed')
        if (result.success !== true) throw new Error('exchange failed; no confirmed success receipt')
        return validateExchangeResult(payload, result.result)
    } finally { exchangePending.delete(envelope.id); results.delete(envelope.id) }
}

export async function transferNodeExchange(source: string, target: string, name: string): Promise<ExchangeFile> {
    const file = await requestNodeExchange(source, { operation: 'read', name }) as ExchangeFile
    if (!file || file.name !== name || !validExchangeRequest({ operation: 'write', name, base64: file.base64, sha256: file.sha256 })) throw new Error('invalid exchange source receipt')
    const bytes = Buffer.from(file.base64!, 'base64')
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('exchange source hash mismatch')
    const receipt = await requestNodeExchange(target, { operation: 'write', name, base64: file.base64, sha256: file.sha256 }) as ExchangeFile
    if (receipt?.name !== name || receipt.bytes !== file.bytes || receipt.sha256 !== file.sha256) throw new Error('exchange destination receipt mismatch')
    return { name, bytes: receipt.bytes, sha256: receipt.sha256 }
}

/** CL-07: the Main fence that delegated work carries (signed with the envelope). */
export function currentMainMeshFence(): MeshFence | undefined {
    const fence = getHeldFence('nova-main')
    if (!fence) return undefined
    return {
        service: fence.service, epoch: fence.epoch, token: fence.token,
        authority: fence.coordinator === 'witness' ? 'witness' : fence.coordinator === 'local' ? 'static' : 'supabase',
    }
}

/**
 * CL-07 receiver check for delegated work: token must match the sending node,
 * the epoch must not be below the persisted high-water mark (which it raises),
 * and where a coordinator is reachable the fence is confirmed live. observe:
 * logged only; enforce: the request is refused.
 */
export async function verifyDelegatedEnvelopeFence(envelope: MeshEnvelope, live = true): Promise<{ ok: boolean; reason: string }> {
    if (!envelope.fence?.token || !envelope.fence.epoch) return { ok: false, reason: 'delegated request carries no Main fence' }
    return checkDelegatedFence({
        service: envelope.fence.service, epoch: envelope.fence.epoch, token: envelope.fence.token, sourceNode: envelope.sourceNode,
    }, { live })
}

async function admitDelegatedEnvelope(envelope: MeshEnvelope): Promise<string | null> {
    const verdict = await verifyDelegatedEnvelopeFence(envelope)
    if (verdict.ok) return null
    if (getFencingMode() === 'enforce') {
        console.warn(`[MeshTransport] ${envelope.kind} from ${envelope.sourceNode} refused (fenced): ${verdict.reason}`)
        return verdict.reason
    }
    console.warn(`[MeshTransport] observe: ${envelope.kind} from ${envelope.sourceNode} would be refused: ${verdict.reason}`)
    return null
}

function withEnvelopeFence<T>(envelope: MeshEnvelope, fn: () => Promise<T>): Promise<T> {
    const fence = envelope.fence
    if (!fence?.token || !fence.epoch) return fn()
    return runWithDelegatedFence({ service: fence.service, epoch: fence.epoch, token: fence.token, sourceNode: envelope.sourceNode }, fn)
}

export async function sendAgentRequest(targetNode: string, prompt: string, options: Partial<AgentRequestPayload> = {}): Promise<{ requestId: string; ack: MeshAck }> {
    const transport = router || initMeshTransportRuntime()
    const runId = randomUUID()
    const payload: AgentRequestPayload = {
        prompt, userId: options.userId, taskType: options.taskType, allowedTools: options.allowedTools,
        successCriteria: options.successCriteria, budget: options.budget,
        idempotencyKey: options.idempotencyKey || runId,
    }
    await assertFenced('nova-main', { live: true, effect: 'mesh:agent.request' })
    const envelope = transport.create('agent.request', targetNode, payload, { runId, ttlMs: Math.max(60_000, payload.budget?.timeoutMs || 0), fence: currentMainMeshFence() })
    return { requestId: envelope.id, ack: await transport.send(targetNode, envelope) }
}

/**
 * Signs a payload for storage in a shared table (legacy `nova_mesh_tasks`).
 * Readers accept such rows only after verifyStoredMeshEnvelope().
 */
export function signStoredMeshEnvelope<T>(
    kind: 'agent.request' | 'mission.request',
    targetNode: string | '*',
    payload: T,
    options: { runId?: string; fence?: MeshFence; ttlMs?: number } = {},
): MeshEnvelope<T> {
    const transport = router || initMeshTransportRuntime()
    return transport.create(kind, targetNode, payload, options)
}

/**
 * Parses and verifies a stored envelope: signature against the configured
 * peer key (or the local key), configured peer roles and the payload schema.
 * Rows that fail are never executed (fail-closed).
 */
export function verifyStoredMeshEnvelope<T>(
    raw: string,
    options: { kinds: Array<'agent.request' | 'mission.request'>; requireLocalTarget?: boolean; requireUnexpired?: boolean },
): { accepted: boolean; envelope?: MeshEnvelope<T>; reason?: string } {
    let envelope: MeshEnvelope<T>
    try { envelope = JSON.parse(raw) as MeshEnvelope<T> } catch { return { accepted: false, reason: 'invalid_json' } }
    const transport = router || initMeshTransportRuntime()
    const decision = transport.verifyStored(envelope as MeshEnvelope, options)
    return decision.accepted ? { accepted: true, envelope } : { accepted: false, reason: decision.reason || 'rejected' }
}

export async function cancelMeshRun(
    targetNode: string,
    requestId: string,
    reason: RunCancelPayload['reason'] = 'cancelled',
): Promise<MeshAck> {
    const transport = router || initMeshTransportRuntime()
    const payload: RunCancelPayload = { requestId, reason, idempotencyKey: `cancel:${requestId}` }
    const envelope = transport.create('run.cancel', targetNode, payload, { runId: requestId, ttlMs: 60_000 })
    return transport.send(targetNode, envelope)
}

export async function sendToolRequest(targetNode: string, payload: ToolRequestPayload): Promise<{ requestId: string; ack: MeshAck }> {
    const transport = router || initMeshTransportRuntime()
    const runId = randomUUID()
    await assertFenced('nova-main', { live: true, effect: 'mesh:tool.request' })
    const envelope = transport.create('tool.request', targetNode, payload, { runId, ttlMs: Math.max(30_000, payload.timeoutMs || 0), fence: currentMainMeshFence() })
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

export async function waitForMeshRunResult(requestId: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<ResultPayload | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (signal?.aborted) return undefined
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

/** node.capabilities → peer state. The Knotenprofil is bounded, bound to the
 * authenticated source node, and kept when a message carries none (profiles
 * are only sent on start/change; graph snapshots never carry one). */
export function peerStateWithCapabilities(previous: PeerState | undefined, sourceNode: string, payload: unknown, publicKeyFingerprint: string, now = Date.now()): PeerState {
    const profile = sanitizeNodeProfile((payload as { profile?: unknown } | null)?.profile)
    const selfHeal = sanitizeSelfHealSummary((payload as { selfHeal?: unknown } | null)?.selfHeal)
    // Hotfix 2.80.1: the 60 s graph snapshot is the peer's view of the whole
    // mesh, not its own advertisement; it must not replace the runtime list
    // the peer sent about itself (discovery reads that list).
    const isSnapshot = Boolean((payload as { snapshot?: unknown } | null)?.snapshot)
    const ownAdvertisement = previous?.capabilities && !(previous.capabilities as { snapshot?: unknown }).snapshot
    const capabilities = isSnapshot && ownAdvertisement ? previous!.capabilities : payload
    return {
        ...previous, nodeId: sourceNode, lastSeen: now, capabilities, publicKeyFingerprint,
        ...(profile ? { profile: { ...profile, nodeId: sourceNode }, profileSeen: now } : {}),
        ...(selfHeal ? { selfHeal, selfHealSeen: now } : {}),
    }
}

/** node.heartbeat → peer state, bound to the authenticated source node. */
export function peerStateWithHeartbeat(previous: PeerState | undefined, sourceNode: string, payload: unknown, publicKeyFingerprint: string, now = Date.now()): PeerState {
    const value = (payload && typeof payload === 'object' ? payload : {}) as { status?: unknown; uptimeMs?: unknown; bootId?: unknown }
    const bootId = typeof value.bootId === 'string' ? value.bootId.replace(/[^\w.:-]/g, '').slice(0, 80) : undefined
    return {
        ...previous, nodeId: sourceNode, lastSeen: now,
        status: typeof value.status === 'string' ? value.status.slice(0, 20) : undefined,
        uptimeMs: Number.isFinite(Number(value.uptimeMs)) ? Number(value.uptimeMs) : undefined,
        publicKeyFingerprint,
        ...(bootId ? { bootId } : {}),
    }
}

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

/** Process start id, announced in every heartbeat (Hotfix 2.80.1). */
const BOOT_ID = randomUUID()
let profilePublishState: ProfilePublishState = { last: null, resendWanted: false, lastForcedAt: null }
let lastPublishedSelfHeal: { fingerprint: string; sentAt: number } | null = null
export function startMeshDataPlane(intervalMs = 30_000): void {
    if (heartbeatTimer) return
    const publish = async () => {
        const transport = router || initMeshTransportRuntime()
        const heartbeat = transport.create('node.heartbeat', '*', { status: 'online', uptimeMs: Math.round(process.uptime() * 1000), ...heartbeatProfileFields(BOOT_ID, peerStates) })
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
        try {
            const { collectNodeProfile, profileFingerprint, decideProfilePublish } = await import('../core/node-profile.js')
            const profile = await collectNodeProfile()
            const decision = decideProfilePublish(profilePublishState, profileFingerprint(profile), Date.now())
            profilePublishState = decision.next
            if (decision.publish) capabilityPayload.profile = profile as unknown as Record<string, unknown>
        } catch { /* profile is optional; capabilities still publish */ }
        try {
            const { currentSelfHealMeshSummary } = await import('../doctor/self-heal-runtime.js')
            const { selfHealSummaryFingerprint } = await import('../doctor/self-heal.js')
            const { shouldPublishProfile } = await import('../core/node-profile.js')
            const summary = currentSelfHealMeshSummary()
            const fingerprint = selfHealSummaryFingerprint(summary)
            if (summary && shouldPublishProfile(fingerprint, lastPublishedSelfHeal, Date.now())) {
                capabilityPayload.selfHeal = summary as unknown as Record<string, unknown>
                lastPublishedSelfHeal = { fingerprint, sentAt: Date.now() }
            }
        } catch { /* self-heal summary is optional */ }
        try {
            // Wächter: only with autonomy.watch.enabled, only nodes without autonomy authority, every 5 min.
            const { watchSampleForMesh } = await import('../watch/runtime.js')
            const sample = await watchSampleForMesh()
            if (sample) capabilityPayload.watch = sample as unknown as Record<string, unknown>
        } catch { /* watch sample is optional */ }
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
    for (const pending of capturePending.values()) pending.receive(null)
    capturePending.clear()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    for (const controller of activeAgentRuns.values()) controller.abort()
    activeAgentRuns.clear()
    await router?.close()
    router = null
    runtimeMessageHandler = undefined
}

async function handleEnvelope(envelope: MeshEnvelope, messageHandler?: MessageHandler): Promise<void> {
    if (!router) return
    if (envelope.kind === 'capture.response') {
        const result = envelope.payload as ResultPayload
        const pending = capturePending.get(result?.requestId)
        if (pending?.node === envelope.sourceNode) pending.receive(result)
        return
    }
    if (envelope.kind === 'capture.request') {
        const check = async () => {
            if (!(await verifyDelegatedEnvelopeFence(envelope)).ok || envelope.fence?.service !== 'nova-main' || envelope.expiresAt < Date.now()) throw new Error('Capture Main authority expired')
        }
        let result: ResultPayload
        try {
            if (!validNodeCaptureRequest(envelope.payload)) throw new Error('Invalid capture context')
            await check()
            result = makeResult(envelope.id, true, await captureEnrolledNode(getLocalNodeId(), check))
        } catch (error) { result = makeResult(envelope.id, false, undefined, String(error).slice(0, 200)) }
        await router.send(envelope.sourceNode, router.create('capture.response', envelope.sourceNode, result, { ttlMs: 30_000 }))
        return
    }
    if (envelope.kind === 'exchange.response') {
        const result = envelope.payload as ResultPayload
        const pending = exchangePending.get(result?.requestId)
        if (pending && pending.node === envelope.sourceNode && pending.expiresAt >= Date.now()) {
            rememberBounded(results, result.requestId, result, MAX_PENDING_RESULTS)
        }
        return
    }
    if (envelope.kind === 'exchange.request') {
        let result: ResultPayload
        try {
            const fence = await verifyDelegatedEnvelopeFence(envelope)
            if (!fence.ok || envelope.fence?.service !== 'nova-main') throw new Error('exchange Main fence rejected')
            result = makeResult(envelope.id, true, await executeExchange(envelope.payload as ExchangeRequest, undefined, async () => {
                if (!(await verifyDelegatedEnvelopeFence(envelope)).ok || envelope.expiresAt < Date.now()) throw new Error('exchange authority expired before commit')
            }))
        } catch (error) { result = makeResult(envelope.id, false, undefined, String(error).slice(0, 200)) }
        const response = router.create('exchange.response', envelope.sourceNode, result, { ttlMs: 30_000 })
        await router.send(envelope.sourceNode, response)
        return
    }
    if (envelope.kind === 'node.heartbeat') {
        const previous = peerStates[envelope.sourceNode]
        if (peerWantsProfile(getLocalNodeId(), previous?.bootId, envelope.payload)) profilePublishState = { ...profilePublishState, resendWanted: true }
        peerStates[envelope.sourceNode] = peerStateWithHeartbeat(previous, envelope.sourceNode, envelope.payload, MeshIdentity.fingerprint(envelope.publicKey))
        persistPeerStates(); return
    }
    if (envelope.kind === 'node.tools') {
        peerStates[envelope.sourceNode] = { ...peerStates[envelope.sourceNode], nodeId: envelope.sourceNode, lastSeen: Date.now(), tools: envelope.payload as ToolInventoryPayload, publicKeyFingerprint: MeshIdentity.fingerprint(envelope.publicKey) }
        persistPeerStates(); return
    }
    if (envelope.kind === 'run.result') {
        const result = envelope.payload as ResultPayload
        if (exchangePending.has(result?.requestId) || capturePending.has(result?.requestId)) return
        if (result?.requestId) {
            rememberBounded(results, result.requestId, result, MAX_PENDING_RESULTS)
            try {
                const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
                for (const evidence of result.evidence || []) getOutcomeLedger().recordTool(envelope.runId || result.requestId, { ...evidence, sourceNode: envelope.sourceNode, transportVerified: true })
                const isIntermediateCodexInference = (result.evidence || []).some(item => item.tool === 'codex_inference')
                // A signed transport envelope proves origin and delivery, not
                // task completion. The requesting ExecutionKernel consumes the
                // result/evidence and is the sole success authority. Remote
                // failures may still terminate the caller's durable run.
                if (!isIntermediateCodexInference && !result.success) {
                    getOutcomeLedger().fail(envelope.runId || result.requestId, { error: result.error, sourceNode: envelope.sourceNode })
                }
            } catch { /* ledger optional */ }
        }
        return
    }
    if (envelope.kind === 'node.capabilities') {
        const payload = envelope.payload as { snapshot?: any } & CapabilityPayload
        getCapabilityGraph().setLocalNodeId(getLocalNodeId())
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
        peerStates[envelope.sourceNode] = peerStateWithCapabilities(peerStates[envelope.sourceNode], envelope.sourceNode, payload, MeshIdentity.fingerprint(envelope.publicKey))
        persistPeerStates()
        if (payload.watch) {
            try {
                // Signature already verified by the router; the watch additionally
                // requires a configured peer with a pinned key (no TOFU node).
                const { ingestPeerWatchSample } = await import('../watch/runtime.js')
                await ingestPeerWatchSample(envelope.sourceNode, payload.watch, watchKnownNodes())
            } catch { /* watch optional */ }
        }
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
        if (cached) return sendResult(envelope, forRequest(cached, envelope.id))
        if (!messageHandler) throw new Error('agent handler unavailable')
        const agentFenceRefusal = await admitDelegatedEnvelope(envelope)
        if (agentFenceRefusal) {
            await sendResult(envelope, makeResult(envelope.id, false, undefined, `fenced: ${agentFenceRefusal}`))
            return
        }
        const now = Date.now()
        for (const [requestId, expiresAt] of cancelledAgentRuns) if (expiresAt <= now) cancelledAgentRuns.delete(requestId)
        if (cancelledAgentRuns.has(envelope.id)) {
            const result = makeResult(envelope.id, false, undefined, 'mesh agent request cancelled before execution')
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS)
            await sendResult(envelope, result)
            return
        }
        const controller = new AbortController()
        activeAgentRuns.set(envelope.id, controller)
        let output = ''
        try {
            await withEnvelopeFence(envelope, () => messageHandler(
                'mesh-direct',
                payload.userId || envelope.principal.id,
                payload.prompt,
                async content => { if (!controller.signal.aborted) output += content },
                undefined,
                { abortSignal: controller.signal, allowedTools: payload.allowedTools || [], requestId: envelope.id },
            ))
            if (controller.signal.aborted) throw new Error('mesh agent request cancelled')
            const result = makeResult(envelope.id, true, output)
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        } finally {
            activeAgentRuns.delete(envelope.id)
        }
        return
    }
    if (envelope.kind === 'run.cancel') {
        const payload = envelope.payload as RunCancelPayload
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, forRequest(cached, envelope.id))
        cancelledAgentRuns.set(payload.requestId, Date.now() + 24 * 60 * 60_000)
        const controller = activeAgentRuns.get(payload.requestId)
        controller?.abort()
        const result = makeResult(envelope.id, true, { requestId: payload.requestId, cancelled: Boolean(controller) })
        rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS)
        await sendResult(envelope, result)
        return
    }
    if (envelope.kind === 'codex.status.request') {
        const payload = envelope.payload as CodexStatusRequestPayload
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, forRequest(cached, envelope.id))
        try {
            const { getCodexRuntimeStatus } = await import('../auth/codex-runtime.js')
            const status = await getCodexRuntimeStatus(envelope.principal.id)
            const result = makeResult(envelope.id, true, { available: status.available, authenticated: status.authenticated, nodeId: status.nodeId })
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'codex.complete.request') {
        const payload = envelope.payload as CodexCompletionRequestPayload
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, forRequest(cached, envelope.id))
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
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'tool.request') {
        const payload = envelope.payload as ToolRequestPayload
        if (containsFreeShellPayload(payload.arguments)) throw new Error('free shell payload rejected')
        const cached = processed.get(payload.idempotencyKey)
        if (cached) return sendResult(envelope, forRequest(cached, envelope.id))
        const toolFenceRefusal = await admitDelegatedEnvelope(envelope)
        if (toolFenceRefusal) {
            await sendResult(envelope, makeResult(envelope.id, false, undefined, `fenced: ${toolFenceRefusal}`))
            return
        }
        const started = Date.now()
        try {
            const { getToolRegistry } = await import('../tools/complete-registry.js')
            // Remote callers act as an unprivileged guest: identity fields are
            // never taken from the envelope payload (policy rejects them, too).
            const { authorizationUserId: _a, authUserId: _b, userId: _c, channel: _d, ...toolArguments } = payload.arguments as Record<string, unknown>
            const resultValue = await withEnvelopeFence(envelope, () => getToolRegistry().execute(payload.tool, toolArguments))
            const resultHash = createHash('sha256').update(JSON.stringify(resultValue)).digest('hex')
            const result: ResultPayload = { requestId: envelope.id, success: true, result: resultValue, evidence: [{ tool: payload.tool, requestHash: envelope.payloadHash, resultHash, verified: true, durationMs: Date.now() - started }] }
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        } catch (error) {
            const result = makeResult(envelope.id, false, undefined, String(error).slice(0, 500))
            rememberBounded(processed, payload.idempotencyKey, result, MAX_PROCESSED_RESULTS); await sendResult(envelope, result)
        }
        return
    }
    if (envelope.kind === 'mission.request') {
        const payload = envelope.payload as MissionRequestPayload
        if (!envelope.fence) throw new Error('mission handoff requires fence')
        const { acceptMissionHandoff } = await import('../core/autonomous-executor.js')
        // MI-1/MI-6: the sender of a handed-off mission is the verified node, never the checkpoint's channel/createdBy.
        let checkpoint: string
        try {
            checkpoint = JSON.stringify({ ...(JSON.parse(payload.checkpoint) as Record<string, unknown>), channel: 'mesh', createdBy: `mesh:${envelope.sourceNode}` })
        } catch {
            await sendResult(envelope, makeResult(envelope.id, false, undefined, 'mission checkpoint rejected'))
            return
        }
        const accepted = acceptMissionHandoff(checkpoint, { ownerNode: getLocalNodeId(), leaseEpoch: envelope.fence.epoch, fencingToken: envelope.fence.token })
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
