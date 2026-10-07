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

export type MeshTaskType =
    | 'llm_query'        // LLM inference (needs internet/OpenAI)
    | 'media_convert'    // ffmpeg transcoding
    | 'image_analysis'   // opencv / vision
    | 'ml_inference'     // local ML model (ollama, etc.)
    | 'embedding'        // text embedding generation
    | 'adb_command'      // Android Debug Bridge (TV/Beamer control)
    | 'file_transfer'    // move files between nodes
    | 'code_execution'   // run scripts (python, node, bash)
    | 'system_command'   // OS-level commands
    | 'general'          // fallback — run locally

export interface RoutingDecision {
    nodeId: string
    nodeName: string
    /** One short human line: "gpu-box: GPU frei, Modell geladen". */
    reason: string
    score: number
    taskType: MeshTaskType
    skill: Skill | null
    isLocal: boolean       // true = run on current node
    ranking?: NodeRanking
}

// ============================================
// Task Type Detection (from message content)
// ============================================

export const detectMeshTaskType = (content: string): MeshTaskType => {
    const lower = content.toLowerCase()

    // ADB / TV / Beamer
    if (/\b(tv|fernseher|beamer|projektor|adb|hdmi|chromecast)\b/.test(lower)) {
        return 'adb_command'
    }

    // Media conversion
    if (/\b(konvertier|convert|transcode|ffmpeg|video.*umwandeln|audio.*extract|mp4|mkv|wav|compress)\b/.test(lower)) {
        return 'media_convert'
    }

    // Image analysis
    if (/\b(bild.*analys|image.*analy|gesichtserkennung|face.*detect|object.*detect|opencv)\b/.test(lower)) {
        return 'image_analysis'
    }

    // ML inference
    if (/\b(ollama|llama|inference|modell.*lokal|local.*model|embeddings?|vektori)\b/.test(lower)) {
        return 'ml_inference'
    }

    // Embedding
    if (/\b(embedding|einbetten|vektorisier|rag.*index)\b/.test(lower)) {
        return 'embedding'
    }

    // File transfer
    if (/\b(transfer|übertrag|kopier.*auf|send.*to.*node|scp|rsync)\b/.test(lower)) {
        return 'file_transfer'
    }

    // Code execution
    if (/\b(führ.*aus|execute|run.*script|python.*run|node.*run|bash.*run)\b/.test(lower)) {
        return 'code_execution'
    }

    // System command
    if (/\b(system|uptime|disk|speicher|temperatur|cpu|ram|neustarten|restart)\b/.test(lower)) {
        return 'system_command'
    }

    return 'general'
}

// ============================================
// Routing (Mesh-Gehirn 2.88): one source, node-strengths.ts
// ============================================

const TASK_SKILL: Partial<Record<MeshTaskType, Skill>> = {
    media_convert: 'medien',
    image_analysis: 'vision',
    ml_inference: 'llm',
    embedding: 'embedding',
    code_execution: 'code',
}

/** Which strength a message needs: wording first, then the legacy task type. */
export const skillForContent = (content: string): Skill | null => skillForTask(content) || TASK_SKILL[detectMeshTaskType(content)] || null

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
    const taskType = detectMeshTaskType(content)
    const skill = skillForContent(content)
    const local = (reason: string, score: number): RoutingDecision => ({ nodeId: localId(strengths), nodeName: localId(strengths), reason, score, taskType, skill, isLocal: true })
    if (forceLocal || !skill) return local(forceLocal ? 'lokal angefordert' : 'normale Aufgabe — läuft hier', 100)
    const nodes = strengths || await collectNodeStrengths()
    const ranking = rankNodes(skill, nodes)
    const best = ranking.ranked[0]
    if (!best) return local(shortReason(ranking), 0)
    console.log(`[MeshRouter] ${skill} → ${best.nodeId} (${shortReason(ranking)})`)
    return { nodeId: best.nodeId, nodeName: best.nodeId, reason: shortReason(ranking), score: best.score, taskType, skill, isLocal: best.local, ranking }
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
    detectMeshTaskType,
    getRoutingDiagnostics,
}
