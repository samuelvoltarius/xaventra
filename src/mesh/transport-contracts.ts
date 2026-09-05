export type MeshMode = 'standalone' | 'direct' | 'ha'

export type MeshEnvelopeKind =
    | 'mesh.hello' | 'mesh.ack'
    | 'node.heartbeat' | 'node.capabilities' | 'node.tools'
    | 'tool.request' | 'agent.request' | 'mission.request'
    | 'codex.status.request' | 'codex.complete.request'
    | 'update.release'
    | 'run.progress' | 'run.evidence' | 'run.checkpoint' | 'run.result'

export type MeshRole = 'system' | 'owner' | 'admin' | 'worker' | 'observer'

export interface MeshPrincipal {
    id: string
    role: MeshRole
    channel?: string
}

export interface MeshFence {
    service: string
    epoch: number
    token: string
    authority: 'supabase' | 'witness' | 'static'
    expiresAt?: string
}

export interface MeshEnvelope<T = unknown> {
    version: 1
    id: string
    kind: MeshEnvelopeKind
    sourceNode: string
    targetNode: string | '*'
    createdAt: number
    expiresAt: number
    nonce: string
    sequence: number
    runId?: string
    principal: MeshPrincipal
    fence?: MeshFence
    payload: T
    payloadHash: string
    publicKey: string
    signature: string
}

export interface MeshAck {
    envelopeId: string
    peerId: string
    status: 'delivered' | 'queued' | 'rejected' | 'duplicate' | 'unreachable'
    transport: 'direct' | 'supabase' | 'relay' | 'local' | 'outbox'
    timestamp: number
    reason?: string
    evidenceHash?: string
}

export interface MeshPeer {
    nodeId: string
    url?: string
    transport: 'direct' | 'supabase' | 'relay' | 'local'
    status: 'online' | 'offline' | 'unknown'
    publicKey?: string
    allowedTools?: string[]
    roles?: MeshRole[]
    lastSeen?: number
    latencyMs?: number
}

export interface MeshTransportHealth {
    name: string
    healthy: boolean
    connectedPeers: number
    queued: number
    lastSuccessAt?: number
    lastError?: string
    encrypted?: boolean
    authenticated?: boolean
}

export type MeshHandler = (envelope: MeshEnvelope) => void | Promise<void>

export interface MeshTransport {
    readonly name: MeshAck['transport']
    discover(): Promise<MeshPeer[]>
    connect(peer: MeshPeer): Promise<void>
    send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck>
    broadcast(envelope: MeshEnvelope): Promise<void>
    subscribe(handler: MeshHandler): void
    health(): MeshTransportHealth
    close?(): Promise<void>
}

export interface HeartbeatPayload {
    status: 'online' | 'busy' | 'draining'
    uptimeMs: number
    load?: number
}

export interface CapabilityPayload {
    hostname?: string
    platform?: string
    hardware?: Record<string, unknown>
    runtimes: Array<{ name?: string; type: string; endpoint?: string; models?: string[]; capabilities?: string[]; status: string; verifiedAt: string }>
    capabilities: string[]
}

export interface ToolInventoryPayload {
    tools: Array<{ name: string; description?: string; category?: string }>
    inventoryHash: string
}

export interface ToolRequestPayload {
    tool: string
    arguments: Record<string, unknown>
    idempotencyKey: string
    timeoutMs?: number
}

export interface AgentRequestPayload {
    prompt: string
    taskType?: string
    allowedTools?: string[]
    successCriteria?: string[]
    budget?: { timeoutMs?: number; maxToolCalls?: number }
    idempotencyKey: string
}

export interface CodexStatusRequestPayload {
    idempotencyKey: string
}

export interface CodexCompletionRequestPayload {
    idempotencyKey: string
    model?: string
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string }>
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    toolChoice?: 'auto' | 'required'
}

export interface MissionRequestPayload {
    missionId: string
    checkpoint: string
    phase: string
    pendingActions: string[]
    idempotencyKey: string
}

export interface EvidencePayload {
    tool?: string
    requestHash?: string
    resultHash: string
    verified: boolean
    durationMs?: number
    artifactPaths?: string[]
}

export interface ResultPayload {
    requestId: string
    success: boolean
    result?: unknown
    error?: string
    evidence: EvidencePayload[]
}

export const COORDINATED_KINDS = new Set<MeshEnvelopeKind>(['mission.request'])

export function isSafeMeshKind(value: unknown): value is MeshEnvelopeKind {
    return typeof value === 'string' && new Set<MeshEnvelopeKind>([
        'mesh.hello', 'mesh.ack', 'node.heartbeat', 'node.capabilities', 'node.tools',
        'tool.request', 'agent.request', 'mission.request', 'codex.status.request', 'codex.complete.request', 'update.release', 'run.progress', 'run.evidence',
        'run.checkpoint', 'run.result',
    ]).has(value as MeshEnvelopeKind)
}
