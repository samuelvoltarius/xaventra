/**
 * Nova Mesh Router — which node does a task?
 *
 * Mesh-Gehirn 2.88: the decision comes from node-strengths.ts (signed node
 * profiles, live load from the heartbeat, measured latency). No fixed node
 * list, no hosts in code, no ping, no SSH. The reason is one short human
 * line ("gpu-box: GPU frei, Modell geladen").
 */

import { collectNodeStrengths, formatStrengthList, rankNodes, shortReason, skillForTask, type NodeRanking, type NodeStrength, type Skill } from './node-strengths.js'

// ============================================
// Types
// ============================================

export interface RoutingDecision {
    nodeId: string
    nodeName: string
    /** One short human line: "gpu-box: GPU frei, Modell geladen". */
    reason: string
    score: number
    skill: Skill | null
    isLocal: boolean       // true = run on current node
    ranking?: NodeRanking
}

// ============================================
// Routing (Mesh-Gehirn 2.88): one source, node-strengths.ts
// ============================================
// 2.89: one skillForTask (node-strengths.ts) decides which strength a task needs; the former
// detectMeshTaskType / skillForContent / TASK_SKILL tables here are gone.

/**
 * Picks the node for a task from the signed strength profiles and says why in
 * one short line. Never pings, never SSH; delegation goes over the signed mesh
 * transport (spawn_subagent with mesh_node).
 */
export const routeTask = async (
    content: string,
    forceLocal = false,
    strengths?: readonly NodeStrength[],
): Promise<RoutingDecision> => {
    const skill = skillForTask(content)
    const local = (reason: string, score: number): RoutingDecision => ({ nodeId: localId(strengths), nodeName: localId(strengths), reason, score, skill, isLocal: true })
    if (forceLocal || !skill) return local(forceLocal ? 'lokal angefordert' : 'normale Aufgabe — läuft hier', 100)
    const nodes = strengths || await collectNodeStrengths()
    const ranking = rankNodes(skill, nodes)
    const best = ranking.ranked[0]
    if (!best) return local(shortReason(ranking), 0)
    console.log(`[MeshRouter] ${skill} → ${best.nodeId} (${shortReason(ranking)})`)
    return { nodeId: best.nodeId, nodeName: best.nodeId, reason: shortReason(ranking), score: best.score, skill, isLocal: best.local, ranking }
}

function localId(strengths?: readonly NodeStrength[]): string {
    return strengths?.find(node => node.local)?.nodeId || 'lokal'
}

// ============================================
// Remote Execution
// ============================================

export const executeRemote = async (
    _decision: RoutingDecision,
    _command: string,
    _timeoutMs = 30_000
): Promise<{ success: boolean; output: string; executionMs: number }> => {
    // R2: this built a shell string from registry-controlled host/user plus
    // the command, with host-key checking disabled. It has no callers; remote
    // work goes through the signed mesh transport. Refuse instead of running.
    return {
        success: false,
        output: 'executeRemote ist deaktiviert: entfernte Ausführung nur über den signierten Mesh-Transport.',
        executionMs: 0,
    }
}

// ============================================
// Diagnostics: "was kann welcher Knoten?"
// ============================================

export const getRoutingDiagnostics = async (): Promise<string> => formatStrengthList(await collectNodeStrengths())

export default {
    routeTask,
    executeRemote,
    getRoutingDiagnostics,
}
