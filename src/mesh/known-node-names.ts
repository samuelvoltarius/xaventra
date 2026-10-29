/**
 * 2.90.0 hand-over to a named node.
 *
 * Live 29.10. 14:00 „Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist
 * und wer ich bin.“ ended after 9 tools (nova_capabilities twice, mesh_nodes,
 * mesh_services …) without a delegation: the sentence reached only the live
 * route `mesh` (status, nodes, strengths); no hand-over tool was offered.
 * The hand-over goes the signed mesh path, spawn_subagent with mesh_node (D1:
 * cancellable, carries the requester and allowed tools), never mesh_delegate.
 *
 * Only real nodes count: ids and hostnames from the local registry file and
 * the signed peer profiles. A hand-over needs a hand-over form („gib … an X“,
 * „lass X machen“, „auf X: …“, „führ das auf X aus“); a question about a node
 * („wie geht es ns1?“) stays a status question.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { runLimits, type RunLimits } from '../core/run-limits.js'

export interface KnownNodeName { nodeId: string; hostname?: string }

const CACHE_MS = 30_000
let cache: { at: number; nodes: KnownNodeName[] } | null = null
let override: KnownNodeName[] | null = null

export function setKnownNodeNamesForTests(nodes: KnownNodeName[] | null): void {
    override = nodes
    cache = null
}

function readJson(path: string): any {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}

/** Registry nodes (mesh.json) and peers with a signed profile (mesh-peer-state.json); read-only, cached 30 s. */
export function knownNodeNames(now = Date.now()): KnownNodeName[] {
    if (override) return override
    if (cache && now - cache.at < CACHE_MS) return cache.nodes
    const byId = new Map<string, KnownNodeName>()
    const add = (nodeId: unknown, hostname: unknown) => {
        const id = String(nodeId || '').trim()
        if (!id) return
        const host = String(hostname || '').trim() || byId.get(id)?.hostname
        byId.set(id, { nodeId: id, ...(host ? { hostname: host } : {}) })
    }
    // mesh-registry.ts keeps mesh.json under the working directory; the runtime root may differ.
    for (const path of new Set([join(process.cwd(), '.nova-data', 'mesh.json'), getNovaDataDir('mesh.json')])) {
        for (const node of readJson(path)?.nodes ?? []) add(node?.node_id, node?.hostname)
    }
    for (const peer of Object.values(readJson(getNovaDataDir('mesh-peer-state.json')) ?? {}) as any[]) {
        add(peer?.nodeId, peer?.profile?.hostname)
    }
    cache = { at: now, nodes: [...byId.values()] }
    return cache.nodes
}

/** Words that name Xaventra or the mesh as a whole, never one node. */
const GENERIC = new Set(['xaventra', 'nova', 'node', 'knoten', 'main', 'mesh', 'localhost'])

function aliasesOf(node: KnownNodeName): string[] {
    const out = new Set<string>()
    for (const value of [node.nodeId, node.hostname, node.nodeId.replace(/^(?:xaventra|nova)-/i, '')]) {
        const alias = String(value || '').trim().toLowerCase()
        if (alias.length >= 2 && !GENERIC.has(alias)) out.add(alias)
    }
    return [...out]
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HANDOVER_VERB = /(?<![\p{L}])(?:gib|gebt|übergib|uebergib|übergeben|uebergeben|schick\p{L}*|sende\p{L}*|delegier\p{L}*|reich\p{L}*|führ\p{L}*|fuehr\p{L}*|erledig\p{L}*|mach\p{L}*)(?![\p{L}])/iu

/** The one real node a sentence hands a task to, or null (none, unknown or ambiguous). */
export function handoffTargetNode(text: string, nodes: readonly KnownNodeName[] = knownNodeNames()): { nodeId: string; alias: string } | null {
    const value = String(text || '').slice(0, 2000)
    const hits = new Map<string, string>()
    for (const node of nodes) {
        for (const alias of aliasesOf(node)) {
            const name = `(?<![\\p{L}\\p{N}_-])${escape(alias)}(?![\\p{L}\\p{N}_-])`
            const toNode = new RegExp(`(?<![\\p{L}])(?:an|auf|zu)\\s+(?:(?:den|dem|die)\\s+)?(?:(?:knoten|node|server|rechner)\\s+)?${name}`, 'iu')
            const colon = new RegExp(`(?:^|\\s)(?:an|auf)\\s+${name}\\s*:`, 'iu')
            const letDo = new RegExp(`(?<![\\p{L}])lass\\p{L}*\\s+(?:(?:das|es|die aufgabe|den job)\\s+)?(?:(?:den|dem)\\s+)?(?:(?:knoten|node)\\s+)?${name}`, 'iu')
            if (colon.test(value) || letDo.test(value) || (toNode.test(value) && HANDOVER_VERB.test(value))) {
                hits.set(node.nodeId, alias)
                break
            }
        }
    }
    if (hits.size !== 1) return null
    const [[nodeId, alias]] = [...hits]
    return { nodeId, alias }
}

/** Time for the final answer after the node returns (one follow-up model call, nova-runner TIMEOUT_FOLLOWUP). */
const FINAL_ANSWER_MS = 60_000
const RESERVE_MS = 20_000
const MAX_WAIT_S = 180
const MIN_WAIT_S = 15

/**
 * How long the hand-over may wait for the node: under the spawn_subagent tool
 * limit and the whole run limit, minus the final answer and a reserve — the
 * peer test with a ~110 s limit and a 90 s wait ended without any answer.
 */
export function handoffWaitSeconds(limits: RunLimits = runLimits()): number {
    const bound = Math.min(limits.toolTimeoutMs.slow, limits.totalTimeoutMs)
    const seconds = Math.floor((bound - FINAL_ANSWER_MS - RESERVE_MS) / 1000)
    return Math.max(MIN_WAIT_S, Math.min(MAX_WAIT_S, seconds))
}
