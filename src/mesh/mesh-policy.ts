import { COORDINATED_KINDS, isSafeMeshKind, type AgentRequestPayload, type CodexCompletionRequestPayload, type CodexStatusRequestPayload, type MeshEnvelope, type MeshEnvelopeKind, type MeshMode, type MeshPeer, type MeshRole, type MissionRequestPayload, type RunCancelPayload, type ToolRequestPayload } from './transport-contracts.js'
import { MeshIdentity, MeshReplayGuard } from './mesh-identity.js'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { validExchangeRequest } from './node-exchange.js'
import { validNodeCaptureRequest } from './node-capture.js'

const NEVER_REMOTE = new Set([
    'run_command', 'system_executor', 'execute_command', 'bash', 'shell', 'powershell',
    'self_evolve', 'save_api_key', 'save_config', 'delete_file', 'mesh_deploy', 'mesh_update',
])

const DEFAULT_REMOTE_TOOLS = new Set([
    'read_file', 'list_directory', 'find_files', 'code_search', 'code_outline', 'view_code_item',
    'health_status', 'nova_status', 'nova_introspect', 'nova_capabilities', 'mesh_status', 'mesh_nodes', 'mesh_transport_status',
    'find_capability', 'resolve_capability', 'get_current_time',
])

/**
 * MI-6: minimum principal role per request kind (fail-closed). Observers may
 * only publish state; mission handoff and Codex access need a privileged role.
 */
const REQUEST_ROLES: Partial<Record<MeshEnvelopeKind, readonly MeshRole[]>> = {
    'tool.request': ['system', 'owner', 'admin', 'worker'],
    'agent.request': ['system', 'owner', 'admin', 'worker'],
    'mission.request': ['system', 'owner', 'admin'],
    'exchange.request': ['system', 'owner', 'admin'],
    'capture.request': ['system', 'owner', 'admin'],
    'codex.status.request': ['system', 'owner', 'admin'],
    'codex.complete.request': ['system', 'owner', 'admin'],
}

/** Tools whose arguments name filesystem locations; mesh callers stay inside the workspace. */
const REMOTE_PATH_TOOLS = new Set(['read_file', 'read_document', 'list_directory', 'find_files', 'code_search', 'code_outline', 'view_code_item'])
const PATH_ARGUMENT_KEY = /^(?:path|paths|file|files|file_path|filepath|dir|directory|root|cwd|target)$/i
/** Identity fields a remote caller must never inject into local tool arguments. */
const RESERVED_ARGUMENT_KEYS = new Set(['authorizationuserid', 'authuserid', 'userid', 'channel', 'principal', 'principalid', 'role', 'permission'])
const PROTECTED_PATH_SEGMENTS = new Set(['.nova-data', '.nova-learning', '.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker'])
const SECRET_BASENAMES: RegExp[] = [
    /^\.env(?:\..*)?$/i, /^xaventra\.config\.json$/i, /^nova\.config\.json$/i,
    /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i,
    /id_(?:rsa|ed25519|ecdsa|dsa)/i, /^\.git-credentials$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pgpass$/i,
]

/** Relative, no traversal, not in data/secret directories, not a secret file. */
export function isSafeRemotePath(value: unknown): boolean {
    if (typeof value !== 'string' || value.includes('\0')) return false
    const trimmed = value.trim()
    if (!trimmed) return false
    if (/^[\\/~]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) return false
    const segments = trimmed.split(/[\\/]+/).filter(Boolean)
    if (segments.some(segment => segment === '..' || PROTECTED_PATH_SEGMENTS.has(segment.toLowerCase()))) return false
    const base = segments[segments.length - 1] || ''
    return !SECRET_BASENAMES.some(pattern => pattern.test(base))
}

/**
 * Roles granted to a peer whose configuration does not list `roles`.
 * Deliberately non-privileged: owner/admin/system must be configured explicitly.
 */
export const DEFAULT_PEER_ROLES: readonly MeshRole[] = Object.freeze(['worker'] as MeshRole[])

export interface MeshTrustConfig {
    mode: MeshMode
    peers: MeshPeer[]
    /**
     * Explicit opt-in (config `mesh.security.allowTofu: true`, default false):
     * accept unknown or key-less peers and pin the first key seen per node id
     * for the lifetime of this policy. Such peers only get DEFAULT_PEER_ROLES
     * unless roles are configured.
     */
    allowTofu?: boolean
    allowedTools?: string[]
}

/** Node ids of configured peers that have no usable `publicKey` (migration warning). */
export function peersWithoutKeys(peers: MeshPeer[]): string[] {
    return peers.filter(peer => !peer.publicKey || !peer.publicKey.trim()).map(peer => peer.nodeId)
}

export class MeshPolicy {
    private readonly replay = new MeshReplayGuard(2 * 60_000, 20_000, join(getNovaDataDir(), 'mesh-replay-cache.json'))
    private readonly tofuKeys = new Map<string, string>()
    constructor(
        private readonly config: MeshTrustConfig,
        private readonly localNodeId: string,
        /** Public key of this node; envelopes claiming `localNodeId` must be signed with it. */
        private readonly localPublicKey?: string,
    ) {}

    verify(envelope: MeshEnvelope): { accepted: boolean; reason?: string; duplicate?: boolean } {
        if (envelope.version !== 1 || !isSafeMeshKind(envelope.kind)) return { accepted: false, reason: 'invalid_schema' }
        if (!envelope.principal || typeof envelope.principal.id !== 'string' ||
            !['system', 'owner', 'admin', 'worker', 'observer'].includes(envelope.principal.role)) {
            return { accepted: false, reason: 'invalid_principal' }
        }
        if (envelope.targetNode !== '*' && envelope.targetNode !== this.localNodeId) return { accepted: false, reason: 'wrong_target' }
        if (!MeshIdentity.verify(envelope)) return { accepted: false, reason: 'invalid_signature' }
        const peer = this.config.peers.find(item => item.nodeId === envelope.sourceNode)
        const trust = this.trustedKey(envelope, peer)
        if (!trust.accepted) return trust
        // Authenticate against the trusted key itself, not just the key the envelope carries.
        if (!MeshIdentity.verifyWithKey(envelope, trust.key)) return { accepted: false, reason: 'invalid_signature' }
        const roles = envelope.sourceNode === this.localNodeId
            ? undefined
            : (peer?.roles?.length ? peer.roles : DEFAULT_PEER_ROLES)
        if (roles && !roles.includes(envelope.principal.role)) return { accepted: false, reason: 'role_not_allowed' }
        if (trust.pin) this.tofuKeys.set(envelope.sourceNode, trust.key)
        const replay = this.replay.accept(envelope)
        if (!replay.accepted) return { accepted: false, reason: replay.reason, duplicate: replay.reason === 'replay' }
        const requestRoles = REQUEST_ROLES[envelope.kind]
        if (requestRoles && !requestRoles.includes(envelope.principal.role)) return { accepted: false, reason: 'request_role_not_allowed' }
        if (COORDINATED_KINDS.has(envelope.kind)) {
            if (this.config.mode === 'standalone') return { accepted: false, reason: 'coordination_disabled_in_standalone' }
            if (this.config.mode === 'ha' && (!envelope.fence?.token || !envelope.fence.epoch)) {
                return { accepted: false, reason: 'missing_fence' }
            }
        }
        if (envelope.kind === 'tool.request') return this.verifyTool(envelope, peer)
        if (envelope.kind === 'capture.request') return validNodeCaptureRequest(envelope.payload) && envelope.targetNode !== '*'
            ? { accepted: true } : { accepted: false, reason: 'invalid_capture_request' }
        if (envelope.kind === 'exchange.request') return validExchangeRequest(envelope.payload) && envelope.targetNode !== '*'
            ? { accepted: true } : { accepted: false, reason: 'invalid_exchange_request' }
        if (envelope.kind === 'agent.request') return this.verifyAgent(envelope, peer)
        if (envelope.kind === 'run.cancel') return this.verifyRunCancel(envelope)
        if (envelope.kind === 'codex.status.request') return this.verifyCodexStatus(envelope)
        if (envelope.kind === 'codex.complete.request') return this.verifyCodexCompletion(envelope)
        if (envelope.kind === 'mission.request') return this.verifyMission(envelope)
        return { accepted: true }
    }

    /**
     * Verifies an envelope persisted in a shared store (legacy `nova_mesh_tasks`
     * rows). Same origin, key and role rules as verify(), but without the
     * replay cache (single execution is enforced by the fenced task claim) and
     * never trust-on-first-use: a stored row must not pin a new key.
     */
    verifyStored(
        envelope: MeshEnvelope,
        options: { kinds: MeshEnvelopeKind[]; requireLocalTarget?: boolean; requireUnexpired?: boolean; now?: number },
    ): { accepted: boolean; reason?: string } {
        try {
            if (!envelope || typeof envelope !== 'object' || envelope.version !== 1 || !options.kinds.includes(envelope.kind) ||
                typeof envelope.sourceNode !== 'string' || typeof envelope.publicKey !== 'string' || typeof envelope.signature !== 'string') {
                return { accepted: false, reason: 'invalid_schema' }
            }
            if (!envelope.principal || typeof envelope.principal.id !== 'string' ||
                !['system', 'owner', 'admin', 'worker', 'observer'].includes(envelope.principal.role)) {
                return { accepted: false, reason: 'invalid_principal' }
            }
            if (options.requireLocalTarget && envelope.targetNode !== this.localNodeId) return { accepted: false, reason: 'wrong_target' }
            if (options.requireUnexpired && !(envelope.expiresAt >= (options.now ?? Date.now()))) return { accepted: false, reason: 'expired' }
            if (!MeshIdentity.verify(envelope)) return { accepted: false, reason: 'invalid_signature' }
            const peer = this.config.peers.find(item => item.nodeId === envelope.sourceNode)
            if (envelope.sourceNode !== this.localNodeId && !peer?.publicKey?.trim()) {
                return { accepted: false, reason: peer ? 'missing_peer_key' : 'untrusted_node' }
            }
            const trust = this.trustedKey(envelope, peer)
            if (!trust.accepted) return trust
            if (!MeshIdentity.verifyWithKey(envelope, trust.key)) return { accepted: false, reason: 'invalid_signature' }
            const roles = envelope.sourceNode === this.localNodeId
                ? undefined
                : (peer?.roles?.length ? peer.roles : DEFAULT_PEER_ROLES)
            if (roles && !roles.includes(envelope.principal.role)) return { accepted: false, reason: 'role_not_allowed' }
            const requestRoles = REQUEST_ROLES[envelope.kind]
            if (requestRoles && !requestRoles.includes(envelope.principal.role)) return { accepted: false, reason: 'request_role_not_allowed' }
            if (envelope.kind === 'agent.request') return this.verifyAgent(envelope, peer)
            if (envelope.kind === 'mission.request') return this.verifyMission(envelope)
            return { accepted: true }
        } catch {
            return { accepted: false, reason: 'invalid_schema' }
        }
    }

    private trustedKey(envelope: MeshEnvelope, peer?: MeshPeer): { accepted: true; key: string; pin?: boolean } | { accepted: false; reason: string } {
        if (envelope.sourceNode === this.localNodeId) {
            if (!this.localPublicKey || !samePublicKey(this.localPublicKey, envelope.publicKey)) return { accepted: false, reason: 'local_node_spoof' }
            return { accepted: true, key: this.localPublicKey }
        }
        const configuredKey = peer?.publicKey?.trim() ? peer.publicKey : undefined
        if (configuredKey) {
            if (!samePublicKey(configuredKey, envelope.publicKey)) return { accepted: false, reason: 'public_key_mismatch' }
            return { accepted: true, key: configuredKey }
        }
        if (!this.config.allowTofu) return { accepted: false, reason: peer ? 'missing_peer_key' : 'untrusted_node' }
        const pinned = this.tofuKeys.get(envelope.sourceNode)
        if (pinned) {
            if (!samePublicKey(pinned, envelope.publicKey)) return { accepted: false, reason: 'public_key_mismatch' }
            return { accepted: true, key: pinned }
        }
        return { accepted: true, key: envelope.publicKey, pin: true }
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
        if (Object.keys(payload.arguments).some(key => RESERVED_ARGUMENT_KEYS.has(key.toLowerCase()))) {
            return { accepted: false, reason: 'reserved_identity_argument' }
        }
        if (REMOTE_PATH_TOOLS.has(payload.tool)) {
            for (const [key, value] of Object.entries(payload.arguments)) {
                if (!PATH_ARGUMENT_KEY.test(key)) continue
                const values = Array.isArray(value) ? value : [value]
                if (!values.length || !values.every(isSafeRemotePath)) return { accepted: false, reason: 'remote_path_not_allowed' }
            }
        }
        const globallyAllowed = new Set(this.config.allowedTools?.length ? this.config.allowedTools : DEFAULT_REMOTE_TOOLS)
        if (!globallyAllowed.has(payload.tool)) return { accepted: false, reason: 'tool_not_globally_allowed' }
        if (peer?.allowedTools?.length && !peer.allowedTools.includes(payload.tool)) return { accepted: false, reason: 'tool_not_allowed_for_peer' }
        return { accepted: true }
    }

    private verifyRunCancel(envelope: MeshEnvelope): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<RunCancelPayload>
        if (!payload || typeof payload.requestId !== 'string' || payload.requestId.length < 8 || payload.requestId.length > 200 ||
            !validIdempotencyKey(payload.idempotencyKey) ||
            (payload.reason !== undefined && !['timeout', 'cancelled', 'shutdown'].includes(payload.reason))) {
            return { accepted: false, reason: 'invalid_run_cancel' }
        }
        if (!['system', 'owner', 'admin'].includes(envelope.principal.role)) {
            return { accepted: false, reason: 'run_cancel_role_not_allowed' }
        }
        return { accepted: true }
    }

    private verifyAgent(envelope: MeshEnvelope, peer?: MeshPeer): { accepted: boolean; reason?: string } {
        const payload = envelope.payload as Partial<AgentRequestPayload>
        if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 100_000) {
            return { accepted: false, reason: 'invalid_agent_request' }
        }
        if (!validIdempotencyKey(payload.idempotencyKey)) return { accepted: false, reason: 'invalid_idempotency_key' }
        if (payload.userId !== undefined && (typeof payload.userId !== 'string' || !payload.userId.trim() || payload.userId.length > 256)) {
            return { accepted: false, reason: 'invalid_agent_user' }
        }
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

function samePublicKey(a: string, b: string): boolean {
    return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim()
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
