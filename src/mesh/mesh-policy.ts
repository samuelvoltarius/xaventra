import { COORDINATED_KINDS, isSafeMeshKind, type AgentRequestPayload, type CodexCompletionRequestPayload, type CodexStatusRequestPayload, type MeshEnvelope, type MeshMode, type MeshPeer, type MissionRequestPayload, type ToolRequestPayload } from './transport-contracts.js'
import { MeshIdentity, MeshReplayGuard } from './mesh-identity.js'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'

const NEVER_REMOTE = new Set([
    'run_command', 'system_executor', 'execute_command', 'bash', 'shell', 'powershell',
    'self_evolve', 'save_api_key', 'save_config', 'delete_file', 'mesh_deploy', 'mesh_update',
])

const DEFAULT_REMOTE_TOOLS = new Set([
    'read_file', 'list_directory', 'find_files', 'code_search', 'code_outline', 'view_code_item',
    'health_status', 'nova_status', 'nova_introspect', 'nova_capabilities', 'mesh_status', 'mesh_nodes', 'mesh_transport_status',
    'find_capability', 'resolve_capability', 'get_current_time',
])

export interface MeshTrustConfig {
    mode: MeshMode
    peers: MeshPeer[]
    allowTofu?: boolean
    allowedTools?: string[]
}

export class MeshPolicy {
    private readonly replay = new MeshReplayGuard(2 * 60_000, 20_000, join(getNovaDataDir(), 'mesh-replay-cache.json'))
    constructor(private readonly config: MeshTrustConfig, private readonly localNodeId: string) {}

    verify(envelope: MeshEnvelope): { accepted: boolean; reason?: string; duplicate?: boolean } {
        if (envelope.version !== 1 || !isSafeMeshKind(envelope.kind)) return { accepted: false, reason: 'invalid_schema' }
        if (!envelope.principal || typeof envelope.principal.id !== 'string' ||
            !['system', 'owner', 'admin', 'worker', 'observer'].includes(envelope.principal.role)) {
            return { accepted: false, reason: 'invalid_principal' }
        }
        if (envelope.targetNode !== '*' && envelope.targetNode !== this.localNodeId) return { accepted: false, reason: 'wrong_target' }
        if (!MeshIdentity.verify(envelope)) return { accepted: false, reason: 'invalid_signature' }
        const peer = this.config.peers.find(item => item.nodeId === envelope.sourceNode)
        if (!peer && !this.config.allowTofu && envelope.sourceNode !== this.localNodeId) return { accepted: false, reason: 'untrusted_node' }
        if (peer?.publicKey && MeshIdentity.fingerprint(peer.publicKey) !== MeshIdentity.fingerprint(envelope.publicKey)) {
            return { accepted: false, reason: 'public_key_mismatch' }
        }
        if (peer?.roles?.length && !peer.roles.includes(envelope.principal.role)) return { accepted: false, reason: 'role_not_allowed' }
        const replay = this.replay.accept(envelope)
        if (!replay.accepted) return { accepted: false, reason: replay.reason, duplicate: replay.reason === 'replay' }
        if (COORDINATED_KINDS.has(envelope.kind)) {
            if (this.config.mode === 'standalone') return { accepted: false, reason: 'coordination_disabled_in_standalone' }
            if (this.config.mode === 'ha' && (!envelope.fence?.token || !envelope.fence.epoch)) {
                return { accepted: false, reason: 'missing_fence' }
            }
        }
        if (envelope.kind === 'tool.request') return this.verifyTool(envelope, peer)
        if (envelope.kind === 'agent.request') return this.verifyAgent(envelope, peer)
        if (envelope.kind === 'codex.status.request') return this.verifyCodexStatus(envelope)
        if (envelope.kind === 'codex.complete.request') return this.verifyCodexCompletion(envelope)
        if (envelope.kind === 'mission.request') return this.verifyMission(envelope)
        return { accepted: true }
    }

    private verifyTool(envelope: MeshEnvelope, peer?: MeshPeer): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<ToolRequestPayload>
        if (!payload || typeof payload.tool !== 'string' || !payload.arguments || typeof payload.arguments !== 'object') {
            return { accepted: false, reason: 'invalid_tool_request' }
        }
        if (!validIdempotencyKey(payload.idempotencyKey)) return { accepted: false, reason: 'invalid_idempotency_key' }
        if (payload.timeoutMs !== undefined && (!Number.isFinite(payload.timeoutMs) || payload.timeoutMs < 1 || payload.timeoutMs > 15 * 60_000)) {
            return { accepted: false, reason: 'invalid_timeout' }
        }
        if (NEVER_REMOTE.has(payload.tool)) return { accepted: false, reason: 'tool_never_remote' }
        if (containsFreeShellPayload(payload.arguments)) return { accepted: false, reason: 'free_shell_payload' }
        const globallyAllowed = new Set(this.config.allowedTools?.length ? this.config.allowedTools : DEFAULT_REMOTE_TOOLS)
        if (!globallyAllowed.has(payload.tool)) return { accepted: false, reason: 'tool_not_globally_allowed' }
        if (peer?.allowedTools?.length && !peer.allowedTools.includes(payload.tool)) return { accepted: false, reason: 'tool_not_allowed_for_peer' }
        return { accepted: true }
    }

    private verifyAgent(envelope: MeshEnvelope, peer?: MeshPeer): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<AgentRequestPayload>
        if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 100_000) {
            return { accepted: false, reason: 'invalid_agent_request' }
        }
        if (!validIdempotencyKey(payload.idempotencyKey)) return { accepted: false, reason: 'invalid_idempotency_key' }
        if (payload.allowedTools !== undefined && (!Array.isArray(payload.allowedTools) || payload.allowedTools.some(tool => typeof tool !== 'string'))) {
            return { accepted: false, reason: 'invalid_agent_tool_list' }
        }
        const globallyAllowed = new Set(this.config.allowedTools?.length ? this.config.allowedTools : DEFAULT_REMOTE_TOOLS)
        for (const tool of payload.allowedTools || []) {
            if (NEVER_REMOTE.has(tool) || !globallyAllowed.has(tool)) return { accepted: false, reason: 'agent_tool_not_globally_allowed' }
            if (peer?.allowedTools?.length && !peer.allowedTools.includes(tool)) return { accepted: false, reason: 'agent_tool_not_allowed_for_peer' }
        }
        return { accepted: true }
    }

    private verifyMission(envelope: MeshEnvelope): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<MissionRequestPayload>
        if (!payload || typeof payload.missionId !== 'string' || typeof payload.checkpoint !== 'string' ||
            typeof payload.phase !== 'string' || !Array.isArray(payload.pendingActions) ||
            payload.pendingActions.some(action => typeof action !== 'string') || !validIdempotencyKey(payload.idempotencyKey)) {
            return { accepted: false, reason: 'invalid_mission_request' }
        }
        return { accepted: true }
    }

    private verifyCodexStatus(envelope: MeshEnvelope): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<CodexStatusRequestPayload>
        return validIdempotencyKey(payload?.idempotencyKey) ? { accepted: true } : { accepted: false, reason: 'invalid_codex_status_request' }
    }

    private verifyCodexCompletion(envelope: MeshEnvelope): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<CodexCompletionRequestPayload>
        if (!validIdempotencyKey(payload?.idempotencyKey) || !Array.isArray(payload?.messages) || payload.messages.length > 200) {
            return { accepted: false, reason: 'invalid_codex_completion_request' }
        }
        if (payload.messages.some(message => !message || typeof message.content !== 'string' || message.content.length > 500_000)) {
            return { accepted: false, reason: 'invalid_codex_messages' }
        }
        if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length > 250 || payload.tools.some(tool => !tool || typeof tool.name !== 'string'))) {
            return { accepted: false, reason: 'invalid_codex_tools' }
        }
        return { accepted: true }
    }
}

export function containsFreeShellPayload(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(containsFreeShellPayload)
    const object = value as Record<string, unknown>
    return Object.entries(object).some(([key, item]) =>
        (['command', 'cmd', 'shell', 'script'].includes(key.toLowerCase()) && typeof item === 'string') ||
        containsFreeShellPayload(item))
}

function validIdempotencyKey(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 8 && value.length <= 200
}
