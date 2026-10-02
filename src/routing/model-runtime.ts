/**
 * Phase 6d — runtime glue for the multi-router (only used when
 * `routing.multi.enabled=true`): cloud spend log for the daily budget, and
 * turning a measured route decision into an LLM client. A cloud client is
 * always wrapped in the cleaned-prompt guard; an Ollama endpoint is loaded
 * first through the memory guard — if that fails the runner keeps its default.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { createCloudSafeClient } from './cloud-prompt.js'
import type { MultiRouteDecision } from './task-model-routing.js'

const spendFile = (dataDir?: string) => dataDir ? join(dataDir, 'model-control', 'cloud-spend.json') : getNovaDataDir('model-control', 'cloud-spend.json')
const dayOf = (now: Date) => now.toISOString().slice(0, 10)

export function getCloudSpendToday(dataDir?: string, now = new Date()): number {
    try {
        const raw = JSON.parse(readFileSync(spendFile(dataDir), 'utf8'))
        return raw?.day === dayOf(now) && Number.isFinite(raw.eur) ? Math.max(0, raw.eur) : 0
    } catch { return 0 }
}

export function recordCloudSpend(eur: number, dataDir?: string, now = new Date()): number {
    const amount = Number.isFinite(eur) && eur > 0 ? eur : 0
    const total = getCloudSpendToday(dataDir, now) + amount
    const file = spendFile(dataDir)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file, { day: dayOf(now), eur: Math.round(total * 10_000) / 10_000 })
    return total
}

const CLIENT_PROVIDER: Record<string, 'claude' | 'openai' | 'local'> = {
    vllm: 'local', ollama: 'local', 'local-other': 'local', anthropic: 'claude', openai: 'openai',
}

export interface AppliedRoute { client: any; cloud: boolean; notice?: string }

/** 2.85: one notice per local outage; reset as soon as a decision is not an outage fallback. */
let outageNoticeSent = false

/** Client for a measured decision or a local-outage fallback, or null (runner keeps its default client). Codex stays on its own path. */
export async function applyMultiRouteEndpoint(decision: MultiRouteDecision): Promise<AppliedRoute | null> {
    const endpoint = decision.endpoint
    if (decision.basis !== 'ausfall') outageNoticeSent = false
    if ((decision.basis !== 'messung' && decision.basis !== 'ausfall') || !endpoint || decision.target === 'codex') return null
    const provider = CLIENT_PROVIDER[endpoint.kind]
    if (!provider) {
        console.warn(`[MultiRouter] Kein Client für ${endpoint.kind}; Standardmodell bleibt.`)
        return null
    }
    if (endpoint.kind === 'ollama' && endpoint.baseUrl) {
        const [{ ensureOllamaModel, createOllamaHttpPort, nodeMemoryFromProfile }, profile] = await Promise.all([
            import('./local-model-control.js'), profileForNode(endpoint.node),
        ])
        const ensured = await ensureOllamaModel(
            { node: endpoint.node || 'unbekannt', baseUrl: endpoint.baseUrl, model: endpoint.model, taskClass: decision.taskClass },
            { port: createOllamaHttpPort(), memory: nodeMemoryFromProfile(profile) },
        )
        if (ensured.status !== 'geladen' && ensured.status !== 'schon-geladen') {
            console.warn(`[MultiRouter] Ollama ${endpoint.model}: ${ensured.status} (${ensured.reason}); Standardmodell bleibt.`)
            return null
        }
    }
    const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
    let client: any = await createNovaLLMClient({
        model: endpoint.model, provider, role: 'chat', isolated: true,
        ...(endpoint.privacy === 'lokal' && endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
    } as any)
    if (endpoint.node) client.nodeId = endpoint.node
    const cloud = endpoint.privacy === 'cloud'
    if (cloud) {
        client = createCloudSafeClient(client)
        recordCloudSpend(endpoint.costEurPerCall ?? 0)
    }
    let notice = decision.notice
    if (decision.basis === 'ausfall') {
        if (outageNoticeSent) notice = undefined
        else outageNoticeSent = true
    }
    return { client, cloud, ...(notice ? { notice } : {}) }
}

/** Node profile of the local node or a mesh peer (null when unknown). */
export async function profileForNode(nodeId: string | undefined): Promise<any> {
    try {
        const [{ collectNodeProfile }, { getLocalNodeId }, { getMeshPeerStates }] = await Promise.all([
            import('../core/node-profile.js'), import('../mesh/mesh-registry.js'), import('../mesh/mesh-transport-runtime.js'),
        ])
        if (!nodeId || nodeId === getLocalNodeId()) return await collectNodeProfile()
        return Object.values(getMeshPeerStates()).find((peer: any) => peer?.nodeId === nodeId)?.profile || null
    } catch { return null }
}
