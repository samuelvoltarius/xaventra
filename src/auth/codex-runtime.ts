import { hostname } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    CodexAppServerLLM,
    CodexWithFallbackLLM,
    codexPrincipalHash,
    getLocalCodexNodeId,
    logoutCodex,
    readCodexStatus,
    startCodexLogin,
    type CodexLoginStart,
    type CodexPublicStatus,
} from './codex-app-server.js'
import type { LLMCallOptions, LLMMessage, LLMResponse, ToolDefinition } from '../llm/nova-llm-sdk.js'
import { createLocalLLM } from '../llm/local-llm.js'
import { getCapabilityGraph, type CapabilityGraphNode, type CapabilityRuntime } from '../mesh/capability-graph.js'
import { getLocalNodeId } from '../mesh/mesh-registry.js'
import { getNovaConfig } from '../core/config.js'
import { getNovaDataDir } from '../core/data-root.js'

export interface CodexRoutingConfig {
    enabled?: boolean
    preferWhenAuthenticated?: boolean
    model?: string
    fallbackModel?: string
    fallbackEndpoint?: string
}

class RemoteCodexLLM {
    readonly providerId = 'openai-codex-mesh'
    constructor(
        private readonly targetNode: string,
        private readonly principalId: string,
        readonly modelId: string,
        private readonly runId: string,
    ) {}

    async complete(messages: LLMMessage[], tools: ToolDefinition[] = [], options: LLMCallOptions = {}): Promise<LLMResponse> {
        const { sendCodexCompletionRequest, waitForMeshRunResult } = await import('../mesh/mesh-transport-runtime.js')
        const sent = await sendCodexCompletionRequest(this.targetNode, this.principalId, {
            model: this.modelId,
            messages: messages.map(message => ({ role: message.role, content: message.content, toolCallId: message.toolCallId })),
            tools,
            toolChoice: options.toolChoice,
        }, this.runId)
        if (!['delivered', 'queued', 'duplicate'].includes(sent.ack.status)) throw new Error(`Codex mesh route rejected: ${sent.ack.reason || sent.ack.status}`)
        const result = await waitForMeshRunResult(sent.requestId, 75_000)
        if (!result?.success) throw new Error(result?.error || 'Codex mesh route timed out')
        return result.result as LLMResponse
    }
}

const remoteRouteCache = new Map<string, { nodeId: string; expiresAt: number }>()

export function rankCodexProbeCandidates(nodes: CapabilityGraphNode[], localNode: string, now = Date.now()): CapabilityGraphNode[] {
    return nodes
        .filter(node => {
            const age = now - Date.parse(node.lastHeartbeat || node.updatedAt)
            return node.id !== localNode && ['online', 'busy'].includes(node.status) && Number.isFinite(age) && age < 2 * 60_000
        })
        .sort((a, b) => {
            const advertised = (node: CapabilityGraphNode) => node.runtimes.some(runtime => runtime.type === 'codex' && runtime.capabilities.includes('authenticated'))
                ? 2 : node.runtimes.some(runtime => runtime.type === 'codex') ? 1 : 0
            return advertised(b) - advertised(a)
                || Number(b.hardware?.gpu_vram_mb || 0) - Number(a.hardware?.gpu_vram_mb || 0)
        })
}

async function findRemoteCodexNode(principalId: string, forceProbe = false): Promise<string | null> {
    const key = `${getLocalCodexNodeId()}:${principalId}`
    const cached = remoteRouteCache.get(key)
    if (!forceProbe && cached && cached.expiresAt > Date.now()) return cached.nodeId
    const localNode = getLocalCodexNodeId()
    const candidates = rankCodexProbeCandidates(getCapabilityGraph().getSnapshot().nodes, localNode).slice(0, 5)
    const { sendCodexStatusRequest, waitForMeshRunResult } = await import('../mesh/mesh-transport-runtime.js')
    for (const node of candidates) {
        try {
            const sent = await sendCodexStatusRequest(node.id, principalId)
            if (!['delivered', 'queued', 'duplicate'].includes(sent.ack.status)) continue
            const result = await waitForMeshRunResult(sent.requestId, 4_000)
            const status = result?.result as { authenticated?: boolean } | undefined
            if (result?.success && status?.authenticated) {
                remoteRouteCache.set(key, { nodeId: node.id, expiresAt: Date.now() + 60_000 })
                return node.id
            }
        } catch { /* try next aggregate candidate */ }
    }
    return null
}

function configuredCodexModel(): string {
    return getNovaConfig().codex?.model || 'gpt-5.4'
}

export interface CodexDisplayModel {
    provider: 'openai-codex'
    model: string
    local: false
    nodeId: string
    available: boolean
    authenticated: boolean
    preferred: boolean
}

export function capabilityRuntimeForCodexStatus(status: CodexPublicStatus, model = 'gpt-5.4'): CapabilityRuntime {
    return {
        id: `${status.nodeId}:codex-app-server`,
        name: 'Codex app-server',
        type: 'codex',
        endpoint: 'local://codex-app-server',
        status: status.available ? 'running' : 'stopped',
        models: status.available ? [model] : [],
        capabilities: status.authenticated ? ['codex', 'oauth', 'authenticated'] : ['codex', 'oauth'],
        verifiedAt: status.checkedAt,
        verificationSource: 'probe',
        // Replicated metadata is intentionally aggregate-only. Never add a
        // principal, email, login id, user code or credential here.
        metadata: { available: status.available, authenticated: status.authenticated },
    }
}

export function authIndexPath(nodeId: string): string {
    const safeNode = nodeId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'node'
    return getNovaDataDir('codex-auth-index', `${safeNode}.json`)
}

function updateAggregateAuthStatus(status: CodexPublicStatus, principalId: string): CodexPublicStatus {
    const path = authIndexPath(status.nodeId)
    let hashes = new Set<string>()
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { authenticatedProfileHashes?: string[] }
        hashes = new Set((parsed.authenticatedProfileHashes || []).filter(value => /^[a-f0-9]{32}$/.test(value)))
    } catch { /* first run */ }
    const principalHash = codexPrincipalHash(principalId)
    if (status.authenticated) hashes.add(principalHash)
    else hashes.delete(principalHash)
    const dir = getNovaDataDir('codex-auth-index')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, authenticatedProfileHashes: [...hashes].sort() }), { mode: 0o600 })
    renameSync(temporary, path)
    return { ...status, authenticated: hashes.size > 0, authMode: hashes.size > 0 ? 'chatgpt' : null, planType: null }
}

function publishStatus(status: CodexPublicStatus, principalId: string): void {
    const aggregate = updateAggregateAuthStatus(status, principalId)
    const canonicalNodeId = getLocalNodeId()
    const runtime = capabilityRuntimeForCodexStatus({ ...aggregate, nodeId: canonicalNodeId }, configuredCodexModel())
    getCapabilityGraph().upsertLocalRuntime(canonicalNodeId, hostname(), runtime)
}

export async function getCodexRuntimeStatus(principalId: string): Promise<CodexPublicStatus> {
    const status = await readCodexStatus(principalId)
    publishStatus(status, principalId)
    return status
}

export async function getCodexDisplayModel(principalId: string): Promise<CodexDisplayModel> {
    const status = await getCodexRuntimeStatus(principalId)
    const config = getNovaConfig().codex
    const remoteNodeId = !status.authenticated && config?.preferWhenAuthenticated !== false
        ? await findRemoteCodexNode(principalId)
        : null
    return {
        provider: 'openai-codex',
        model: config?.model || 'gpt-5.4',
        local: false,
        nodeId: remoteNodeId || status.nodeId,
        available: status.available || Boolean(remoteNodeId),
        authenticated: status.authenticated || Boolean(remoteNodeId),
        preferred: (status.authenticated || Boolean(remoteNodeId)) && config?.preferWhenAuthenticated !== false,
    }
}

export async function beginCodexRuntimeLogin(principalId: string, mode: 'device' | 'browser' = 'device'): Promise<CodexLoginStart> {
    const login = await startCodexLogin(principalId, mode)
    publishStatus(await readCodexStatus(principalId), principalId)
    return login
}

export async function endCodexRuntimeLogin(principalId: string): Promise<void> {
    await logoutCodex(principalId)
    publishStatus(await readCodexStatus(principalId), principalId)
}

export interface CodexFallbackTarget {
    endpoint: string
    model: string
    nodeId: string
    hostname?: string
}

function endpointIdentity(value: string): string {
    try {
        const url = new URL(value)
        url.hash = ''
        url.search = ''
        url.pathname = url.pathname.replace(/\/v1\/?$/i, '').replace(/\/+$/, '')
        return url.toString().replace(/\/$/, '').toLowerCase()
    } catch {
        return value.trim().replace(/\/v1\/?$/i, '').replace(/\/+$/, '').toLowerCase()
    }
}

export function sameRuntimeEndpoint(first: string, second: string): boolean {
    return endpointIdentity(first) === endpointIdentity(second)
}

export function resolveVllmFallback(config: CodexRoutingConfig): CodexFallbackTarget | null {
    if (config.fallbackEndpoint) {
        const match = getCapabilityGraph().getSnapshot().nodes.find(node =>
            node.runtimes.some(runtime => sameRuntimeEndpoint(runtime.endpoint, config.fallbackEndpoint!)))
        return {
            endpoint: config.fallbackEndpoint,
            model: config.fallbackModel || 'auto',
            nodeId: match?.id || 'configured',
            hostname: match?.hostname,
        }
    }
    const now = Date.now()
    const localNode = getLocalCodexNodeId()
    const candidates = getCapabilityGraph().getSnapshot().nodes.flatMap(node => node.runtimes.flatMap(runtime => {
        const looksLikeVllm = runtime.type.toLowerCase() === 'vllm' || runtime.name.toLowerCase().includes('vllm') || /:8000(?:\/|$)/.test(runtime.endpoint)
        const age = now - Date.parse(runtime.verifiedAt)
        if (!looksLikeVllm || !['online', 'busy'].includes(node.status) || runtime.status !== 'running' || !runtime.endpoint || !Number.isFinite(age) || age > 15 * 60_000) return []
        const model = config.fallbackModel && config.fallbackModel !== 'auto'
            ? config.fallbackModel
            : runtime.models.find(item => !/embed|nomic|bge|mxbai/i.test(item))
        if (!model) return []
        const score = (node.id === localNode ? 1000 : 0) + (node.status === 'online' ? 100 : 0) + Number(node.hardware?.gpu_vram_mb || 0) / 1024 - age / 60_000
        return [{ endpoint: runtime.endpoint, model, nodeId: node.id, hostname: node.hostname, score }]
    })).sort((a, b) => b.score - a.score)
    if (candidates[0]) {
        const { endpoint, model, nodeId, hostname } = candidates[0]
        return { endpoint, model, nodeId, hostname }
    }

    // Bootstrap fallback before the first capability scan. This contains only
    // public runtime coordinates from config, never authentication material.
    const cfg = (globalThis as any).__novaState?.config || {}
    for (const node of cfg.nodes || []) {
        const endpoint = node?.services?.vllm
        if (endpoint && (node.runtime === 'vllm' || String(endpoint).includes(':8000'))) {
            return {
                endpoint,
                model: config.fallbackModel || node?.hardware?.model || 'auto',
                nodeId: String(node.id || node.nodeId || node.name || node.host || 'configured'),
                hostname: node.hostname || node.name,
            }
        }
    }
    return null
}

export interface CodexContinuityProbe {
    available: boolean
    activeNodeId?: string
    localStatus: CodexPublicStatus
    knownNodeIds: string[]
    fallback: CodexFallbackTarget | null
    checkedAt: string
}

/** Principal-specific availability check. The capability graph only carries
 * aggregate auth state; this probe verifies User x Node over the signed mesh. */
export async function probeCodexContinuity(principalId: string, config: CodexRoutingConfig): Promise<CodexContinuityProbe> {
    const localStatus = await getCodexRuntimeStatus(principalId)
    let activeNodeId: string | undefined
    if (localStatus.authenticated && config.preferWhenAuthenticated !== false) activeNodeId = localStatus.nodeId
    else if (config.preferWhenAuthenticated !== false) activeNodeId = await findRemoteCodexNode(principalId, true) || undefined
    const knownNodeIds = getCapabilityGraph().getSnapshot().nodes
        .filter(node => node.runtimes.some(runtime => runtime.type === 'codex'))
        .sort((a, b) => {
            const score = (node: typeof a) => node.runtimes.some(runtime => runtime.type === 'codex' && runtime.capabilities.includes('authenticated'))
                ? 2 : node.runtimes.some(runtime => runtime.type === 'codex' && runtime.status === 'running') ? 1 : 0
            return score(b) - score(a)
        })
        .map(node => node.id)
    return {
        available: Boolean(activeNodeId),
        activeNodeId,
        localStatus,
        knownNodeIds,
        fallback: resolveVllmFallback(config),
        checkedAt: new Date().toISOString(),
    }
}

export async function createCodexRoutedClient(params: {
    principalId: string
    runId: string
    config: CodexRoutingConfig
    existingClient?: any
    onFallback?: (reason: string, route: string) => void
}): Promise<{ client: any; route: 'codex' | 'codex-remote' | 'local-vllm' | 'existing'; status: CodexPublicStatus; fallback?: CodexFallbackTarget }> {
    const status = await getCodexRuntimeStatus(params.principalId)
    const vllm = resolveVllmFallback(params.config)
    let fallback = params.existingClient
    let fallbackRoute: 'local-vllm' | 'existing' = 'existing'
    if (vllm) {
        const local = createLocalLLM({
            baseUrl: vllm.endpoint,
            model: vllm.model,
            name: 'Nova vLLM fallback',
            requestTimeoutMs: 60_000,
        }) as any
        local.modelId = vllm.model
        local.providerId = 'local-vllm'
        local.nodeId = vllm.nodeId
        fallback = local
        fallbackRoute = 'local-vllm'
    }
    if (!fallback) {
        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
        fallback = await createNovaLLMClient({ provider: 'local', model: params.config.fallbackModel || 'auto' })
        fallbackRoute = 'local-vllm'
    }

    if (status.authenticated && params.config.preferWhenAuthenticated !== false) {
        const codex = new CodexAppServerLLM(params.principalId, status.nodeId, params.config.model || 'gpt-5.4')
        return {
            client: new CodexWithFallbackLLM(codex, fallback, reason => params.onFallback?.(reason, fallbackRoute)),
            route: 'codex', status, fallback: vllm || undefined,
        }
    }
    if (params.config.preferWhenAuthenticated !== false) {
        const remoteNode = await findRemoteCodexNode(params.principalId)
        if (remoteNode) {
            const remote = new RemoteCodexLLM(remoteNode, params.principalId, params.config.model || 'gpt-5.4', params.runId)
            return {
                client: new CodexWithFallbackLLM(remote, fallback, reason => params.onFallback?.(reason, fallbackRoute)),
                route: 'codex-remote',
                status: { ...status, nodeId: remoteNode, available: true, authenticated: true },
                fallback: vllm || undefined,
            }
        }
    }
    params.onFallback?.(status.available ? 'Codex auf diesem Node für diesen User nicht angemeldet' : 'Codex auf diesem Node nicht installiert', fallbackRoute)
    return { client: fallback, route: fallbackRoute, status, fallback: vllm || undefined }
}
