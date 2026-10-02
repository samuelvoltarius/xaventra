/**
 * Nova Mesh Router — Aufgaben dorthin, wo sie am besten laufen.
 *
 * 2.86 Paket J ("Ein Mesh-Gehirn"): the router no longer keeps its own fixed
 * node list (it had invented addresses) and no longer pings nodes. It maps the
 * detected task type to a strength and asks the one strength module
 * (`node-strengths.ts`, `rankNodes`) built from signed node profiles, the
 * Capability-Graph and validated owner runs. Delegation itself goes only
 * through the signed mesh transport (spawn_subagent with mesh_node).
 */

import { collectStrengthFacts, formatStrengthMap, rankNodes, rankingReason, type NodeRanking, type StrengthCapability, type StrengthFacts } from './node-strengths.js'

// ============================================
// Types
// ============================================

export type MeshTaskType =
    | 'llm_query'        // LLM inference (runs through the model router on the main)
    | 'image_generation' // create pictures (GPU / image service)
    | 'media_convert'    // ffmpeg transcoding
    | 'image_analysis'   // opencv / vision
    | 'speech_to_text'   // whisper & co.
    | 'text_to_speech'   // piper & co.
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
    reason: string
    score: number
    taskType: MeshTaskType
    isLocal: boolean       // true = run on current node
    /** Strength the task was ranked by; undefined = stays local by rule. */
    capability?: StrengthCapability
    ranking?: NodeRanking
}

/** Task type → strength. Types without one stay on the local node (device control, OS commands, chat). */
export const TASK_STRENGTH: Record<MeshTaskType, StrengthCapability | null> = {
    llm_query: null,
    image_generation: 'bilder',
    media_convert: 'medien',
    image_analysis: 'vision',
    speech_to_text: 'stt',
    text_to_speech: 'tts',
    ml_inference: 'llm',
    embedding: 'embedding',
    adb_command: null,
    file_transfer: 'speicher',
    code_execution: 'rechnen',
    system_command: null,
    general: null,
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

    // Image generation (2.86 Paket J: "Knoten A hat GPU → Bilder")
    if (/\b(erzeug\w*|generier\w*|mal\w*|zeichne\w*|create|generate|draw)\b.*\b(bild|bilder|image|picture|grafik|illustration|logo)\b|\b(stable.?diffusion|comfyui|sdxl|flux)\b/.test(lower)) {
        return 'image_generation'
    }

    // Media conversion
    if (/\b(konvertier|convert|transcode|ffmpeg|video.*umwandeln|audio.*extract|mp4|mkv|wav|compress)\b/.test(lower)) {
        return 'media_convert'
    }

    // Image analysis
    if (/\b(bild.*analys|image.*analy|gesichtserkennung|face.*detect|object.*detect|opencv)\b/.test(lower)) {
        return 'image_analysis'
    }

    // Speech (STT/TTS)
    if (/\b(transkri\w*|transcrib\w*|whisper|sprachaufnahme|diktat)\b/.test(lower)) {
        return 'speech_to_text'
    }
    if (/\b(vorlesen|text.?to.?speech|tts|sprachausgabe|piper)\b/.test(lower)) {
        return 'text_to_speech'
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
// Main Router
// ============================================

function localNodeId(facts: StrengthFacts): string {
    return facts.nodes.find(node => node.local)?.nodeId || 'lokal'
}

export const routeTask = async (
    content: string,
    forceLocal = false,
    facts?: StrengthFacts,
): Promise<RoutingDecision> => {
    const taskType = detectMeshTaskType(content)
    const capability = TASK_STRENGTH[taskType]
    if (forceLocal || !capability) {
        const local = facts ? localNodeId(facts) : 'lokal'
        return {
            nodeId: local, nodeName: local, score: 100, taskType, isLocal: true,
            reason: taskType === 'llm_query' ? 'Sprachmodell-Anfragen wählt der Modell-Router auf dem Main' : 'Allgemeine Aufgabe — läuft lokal',
        }
    }
    const current = facts || await collectStrengthFacts()
    const ranking = rankNodes(capability, current)
    const best = ranking.ranked[0]
    if (!best) {
        const local = localNodeId(current)
        return { nodeId: local, nodeName: local, score: 0, taskType, isLocal: true, capability, ranking, reason: `${rankingReason(ranking)} — läuft lokal` }
    }
    const isLocal = current.nodes.some(node => node.local && node.nodeId === best.nodeId)
    console.log(`[MeshRouter] ${taskType} → ${best.nodeId} (${capability}, Platz 1 von ${ranking.ranked.length})`)
    return { nodeId: best.nodeId, nodeName: best.nodeId, score: best.score, taskType, isLocal, capability, ranking, reason: rankingReason(ranking) }
}

/** Prompt block for the model: where the task runs best and how to get it there (signed mesh only). */
export function meshRoutingPromptBlock(decision: RoutingDecision): string {
    const how = decision.isLocal
        ? 'Lokal ausführen.'
        : `Nicht lokal: über den signierten Mesh-Weg delegieren — spawn_subagent mit mesh_node="${decision.nodeId}" (oder "auto")${decision.capability ? ` und faehigkeit="${decision.capability}"` : ''}. Kein ssh, keine anderen Wege.`
    return `## 🌐 MESH ROUTING (automatisch erkannt)
Aufgabentyp: **${decision.taskType}**
Empfohlener Knoten: **${decision.nodeId}**${decision.isLocal ? ' (dieser Knoten)' : ''}
Grund: ${decision.reason}
${how}`
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
// Diagnostics
// ============================================

export const getRoutingDiagnostics = async (facts?: StrengthFacts): Promise<string> => {
    return formatStrengthMap(facts || await collectStrengthFacts())
}

export default {
    routeTask,
    executeRemote,
    detectMeshTaskType,
    getRoutingDiagnostics,
    TASK_STRENGTH,
}
