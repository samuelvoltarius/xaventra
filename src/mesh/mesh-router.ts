/**
 * Nova Mesh Router — Intelligent Task Routing
 *
 * Routes tasks to the best available node based on:
 * - Capability match (40% weight)
 * - Current load (30% weight)
 * - Network latency (30% weight)
 *
 * Uses data from:
 * - mesh-registry.ts (node capabilities, status)
 * - L21-node-health.ts (CPU/RAM/temp snapshots)
 * - model-router.ts (task type detection)
 */

import { exec } from 'node:child_process'

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
    host: string
    reason: string
    score: number
    taskType: MeshTaskType
    isLocal: boolean       // true = run on current node
    sshUser?: string
}

export interface NodeScore {
    nodeId: string
    nodeName: string
    host: string
    sshUser?: string
    capabilityScore: number  // 0-100
    loadScore: number        // 0-100 (100 = idle)
    latencyScore: number     // 0-100 (100 = fastest)
    totalScore: number       // weighted combination
    capabilities: string[]
    online: boolean
}

// ============================================
// Task → Capability Mapping
// ============================================

const TASK_REQUIREMENTS: Record<MeshTaskType, {
    required: string[]      // must have ALL of these
    preferred: string[]     // bonus points for these
    needsInternet?: boolean
    needsGPU?: boolean
}> = {
    llm_query: {
        required: ['internet'],
        preferred: ['openai'],
        needsInternet: true,
    },
    media_convert: {
        required: ['ffmpeg'],
        preferred: ['gpu', 'fast-disk'],
    },
    image_analysis: {
        required: ['python'],
        preferred: ['opencv', 'gpu', 'cuda'],
        needsGPU: true,
    },
    ml_inference: {
        required: ['python'],
        preferred: ['ollama', 'cuda', 'gpu', 'metal', 'apple-silicon'],
        needsGPU: true,
    },
    embedding: {
        required: ['python'],
        preferred: ['ollama', 'cuda', 'gpu', 'metal', 'apple-silicon'],
        needsGPU: true,
    },
    adb_command: {
        required: ['adb'],
        preferred: [],
    },
    file_transfer: {
        required: ['ssh'],
        preferred: [],
    },
    code_execution: {
        required: [],  // any node can run code
        preferred: ['python', 'node'],
    },
    system_command: {
        required: [],
        preferred: [],
    },
    general: {
        required: [],
        preferred: [],
    },
}

// ============================================
// Static Node Profiles (fallback)
// ============================================

interface NodeProfile {
    name: string
    host: string
    sshUser: string
    role: 'main' | 'edge' | 'primary-compute' | 'compute' | 'infrastructure'
    capabilities: string[]
    specialties: string[]
}

const NODE_PROFILES: Record<string, NodeProfile> = {
    'main-pc': {
        name: 'Main PC',
        host: 'localhost',
        sshUser: '',
        role: 'main',
        capabilities: ['internet', 'openai', 'node', 'python', 'ffmpeg', 'ssh', 'git'],
        specialties: ['llm-gateway', 'telegram', 'dashboard'],
    },
    'pi5': {
        name: 'Pi5',
        host: '100.64.0.21',
        sshUser: 'xaventra',
        role: 'edge',
        capabilities: ['node', 'python', 'ffmpeg', 'adb', 'ssh', 'git'],
        specialties: ['tv-control', 'beamer-control', 'media-playback'],
    },
    'jetson': {
        name: 'Jetson',
        host: '100.64.0.22',
        sshUser: 'xaventra',
        role: 'edge',
        capabilities: ['node', 'python', 'cuda', 'gpu', 'opencv', 'ollama', 'ssh', 'git'],
        specialties: ['ml-inference', 'image-processing', 'embedding'],
    },
    'macbook-pro': {
        name: 'MacBookPro',
        host: '100.64.0.23',
        sshUser: 'xaventra',
        role: 'primary-compute',
        // M3 Pro/Max 36GB unified memory — best local LLM node (30B+ models)
        capabilities: ['node', 'python', 'ollama', 'ssh', 'git', 'ffmpeg', 'apple-silicon', 'metal'],
        specialties: ['large-model-inference', 'ml-inference', 'embedding', 'long-context'],
    },
    'mac-mini': {
        name: 'MacMini',
        host: '100.64.0.24',
        sshUser: 'xaventra',
        role: 'compute',
        // Apple M4 16GB — fast 9B models
        capabilities: ['node', 'python', 'ollama', 'ssh', 'git', 'apple-silicon', 'metal'],
        specialties: ['ml-inference', 'embedding', 'voice-processing'],
    },
    // DGX Spark — coming soon, disabled until host is known
    // 'dgx-spark': {
    //     name: 'DGXSpark',
    //     host: '',    // fill in once online
    //     sshUser: '',
    //     role: 'primary-compute',
    //     capabilities: ['node', 'python', 'cuda', 'gpu', 'ollama', 'ssh', 'git'],
    //     specialties: ['large-model-inference', 'ml-inference', 'embedding', '1petaflop-ai'],
    // },
}

// ============================================
// Scoring Weights
// ============================================

const WEIGHTS = {
    capability: 0.4,
    load: 0.3,
    latency: 0.3,
}

// ============================================
// Runtime State
// ============================================

const latencyCache = new Map<string, { latencyMs: number; measuredAt: number }>()
const LATENCY_CACHE_TTL = 60_000 // 1 minute

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
// Node Scoring
// ============================================

const scoreCapability = (nodeCapabilities: string[], task: MeshTaskType): number => {
    const requirements = TASK_REQUIREMENTS[task]
    if (!requirements) return 50

    // Check required capabilities (must have ALL)
    for (const req of requirements.required) {
        if (!nodeCapabilities.includes(req)) return 0 // Hard fail
    }

    // Base score: 60 for meeting requirements
    let score = 60

    // Bonus for preferred capabilities
    const preferredHits = requirements.preferred.filter(p => nodeCapabilities.includes(p))
    score += (preferredHits.length / Math.max(requirements.preferred.length, 1)) * 40

    return Math.min(100, Math.round(score))
}

const scoreLoad = async (host: string): Promise<number> => {
    // Try to get load from health monitor
    try {
        const { getNodeHealthMonitor } = await import('../layers/L21-node-health.js')
        const monitor = getNodeHealthMonitor()
        const snapshots = monitor.getLastSnapshots()
        const snap = snapshots.find(s => s.host === host)

        if (snap?.online && snap.cpu) {
            // Convert load average to idle percentage
            const loadPerCore = snap.cpu.loadAvg1m / snap.cpu.cores
            const idlePercent = Math.max(0, 100 - (loadPerCore * 100))
            return Math.round(idlePercent)
        }
    } catch { /* no health data */ }

    // Default: assume 70% idle
    return 70
}

const scoreLatency = async (host: string): Promise<number> => {
    if (host === 'localhost') return 100 // Local is instant

    // Check cache
    const cached = latencyCache.get(host)
    if (cached && Date.now() - cached.measuredAt < LATENCY_CACHE_TTL) {
        return latencyToScore(cached.latencyMs)
    }

    // Measure latency via ping
    const latencyMs = await measureLatency(host)
    latencyCache.set(host, { latencyMs, measuredAt: Date.now() })

    return latencyToScore(latencyMs)
}

const latencyToScore = (ms: number): number => {
    if (ms < 5) return 100
    if (ms < 20) return 90
    if (ms < 50) return 80
    if (ms < 100) return 60
    if (ms < 500) return 40
    return 20
}

const measureLatency = (host: string): Promise<number> => {
    return new Promise<number>((resolve) => {
        const start = Date.now()
        const isWindows = process.platform === 'win32'
        const cmd = isWindows
            ? `ping -n 1 -w 2000 ${host}`
            : `ping -c 1 -W 2 ${host}`

        exec(cmd, { timeout: 5000 }, (err) => {
            if (err) {
                resolve(9999) // Unreachable
            } else {
                resolve(Date.now() - start)
            }
        })
    })
}

// ============================================
// Main Router
// ============================================

export const scoreAllNodes = async (task: MeshTaskType): Promise<NodeScore[]> => {
    const scores: NodeScore[] = []

    // Get dynamic nodes from mesh registry if available
    let dynamicNodes: Array<{ node_id: string; hostname: string; ip?: string; ssh_user?: string; capabilities: string[]; status: string }> = []
    try {
        const { getAvailableNodes } = await import('./mesh-registry.js')
        dynamicNodes = await getAvailableNodes()
    } catch { /* use static profiles */ }

    // Build node list from static profiles + dynamic discovery
    const nodeList: Array<{ id: string; name: string; host: string; sshUser: string; capabilities: string[]; online: boolean }> = []

    // Static profiles first
    for (const [id, profile] of Object.entries(NODE_PROFILES)) {
        nodeList.push({
            id,
            name: profile.name,
            host: profile.host,
            sshUser: profile.sshUser,
            capabilities: profile.capabilities,
            online: true, // Assume online, latency check will catch offline
        })
    }

    // Merge dynamic nodes (override static if same host)
    for (const dn of dynamicNodes) {
        const existingIdx = nodeList.findIndex(n => n.host === dn.ip)
        if (existingIdx >= 0) {
            // Merge capabilities
            const existing = nodeList[existingIdx]
            const merged = [...new Set([...existing.capabilities, ...dn.capabilities])]
            nodeList[existingIdx].capabilities = merged
        } else if (dn.ip) {
            nodeList.push({
                id: dn.node_id,
                name: dn.hostname,
                host: dn.ip,
                sshUser: dn.ssh_user || 'root',
                capabilities: dn.capabilities,
                online: dn.status === 'online',
            })
        }
    }

    // Score each node in parallel
    await Promise.all(nodeList.map(async (node) => {
        const capScore = scoreCapability(node.capabilities, task)
        const loadScore = await scoreLoad(node.host)
        const latScore = await scoreLatency(node.host)

        const total = Math.round(
            capScore * WEIGHTS.capability +
            loadScore * WEIGHTS.load +
            latScore * WEIGHTS.latency
        )

        scores.push({
            nodeId: node.id,
            nodeName: node.name,
            host: node.host,
            sshUser: node.sshUser,
            capabilityScore: capScore,
            loadScore: loadScore,
            latencyScore: latScore,
            totalScore: total,
            capabilities: node.capabilities,
            online: node.online && latScore > 10,
        })
    }))

    // Sort by total score descending
    scores.sort((a, b) => b.totalScore - a.totalScore)

    return scores
}

export const routeTask = async (
    content: string,
    forceLocal = false
): Promise<RoutingDecision> => {
    const taskType = detectMeshTaskType(content)

    // Force local for general tasks or when explicitly requested
    if (forceLocal || taskType === 'general' || taskType === 'llm_query') {
        return {
            nodeId: 'main-pc',
            nodeName: 'Main PC',
            host: 'localhost',
            reason: taskType === 'llm_query'
                ? 'LLM queries run through OpenAI on main'
                : 'General task — running locally',
            score: 100,
            taskType,
            isLocal: true,
        }
    }

    const scores = await scoreAllNodes(taskType)
    const onlineScores = scores.filter(s => s.online && s.capabilityScore > 0)

    if (onlineScores.length === 0) {
        // No capable nodes — fall back to local
        return {
            nodeId: 'main-pc',
            nodeName: 'Main PC',
            host: 'localhost',
            reason: `No capable nodes for ${taskType} — running locally`,
            score: 50,
            taskType,
            isLocal: true,
        }
    }

    const best = onlineScores[0]
    const isLocal = best.host === 'localhost'

    console.log(
        `[MeshRouter] ${taskType} → ${best.nodeName} ` +
        `(score: ${best.totalScore} | cap: ${best.capabilityScore} load: ${best.loadScore} lat: ${best.latencyScore})`
    )

    return {
        nodeId: best.nodeId,
        nodeName: best.nodeName,
        host: best.host,
        sshUser: best.sshUser,
        reason: `Best node for ${taskType}: ${best.nodeName} (score ${best.totalScore}/100)`,
        score: best.totalScore,
        taskType,
        isLocal,
    }
}

// ============================================
// Remote Execution
// ============================================

export const executeRemote = async (
    decision: RoutingDecision,
    command: string,
    timeoutMs = 30_000
): Promise<{ success: boolean; output: string; executionMs: number }> => {
    if (decision.isLocal) {
        // Execute locally
        const start = Date.now()
        return new Promise((resolve) => {
            exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
                resolve({
                    success: !err,
                    output: stdout || stderr || (err?.message ?? ''),
                    executionMs: Date.now() - start,
                })
            })
        })
    }

    // Execute via SSH
    const start = Date.now()
    const sshCmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${decision.sshUser}@${decision.host} "${command.replace(/"/g, '\\"')}"`

    return new Promise((resolve) => {
        exec(sshCmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
            const executionMs = Date.now() - start

            // Record OTel metric
            try {
                const { recordMeshEvent } = require('../infra/telemetry.js')
                recordMeshEvent({
                    event: err ? 'remote_exec_fail' : 'remote_exec_ok',
                    nodeId: decision.nodeId,
                })
            } catch { /* no telemetry */ }

            resolve({
                success: !err,
                output: stdout || stderr || (err?.message ?? ''),
                executionMs,
            })
        })
    })
}

// ============================================
// Diagnostics
// ============================================

export const getRoutingDiagnostics = async (): Promise<string> => {
    const lines: string[] = ['🌐 **Mesh Router Status**\n']

    // Live-ping all nodes in parallel (don't rely on stale cache)
    const entries = Object.entries(NODE_PROFILES)
    const results = await Promise.all(entries.map(async ([id, profile]) => {
        if (profile.host === 'localhost') {
            return { id, profile, latencyMs: 0, online: true }
        }
        const latencyMs = await measureLatency(profile.host)
        latencyCache.set(profile.host, { latencyMs, measuredAt: Date.now() })
        return { id, profile, latencyMs, online: latencyMs < 5000 }
    }))

    for (const { id, profile, latencyMs, online } of results) {
        const status = online ? '🟢' : '🔴'
        const latStr = profile.host === 'localhost' ? 'local' : `${latencyMs}ms`
        lines.push(`${status} **${profile.name}** (${profile.host}) — ${latStr}`)
        lines.push(`   Capabilities: ${profile.capabilities.join(', ')}`)
        lines.push(`   Specialties: ${profile.specialties.join(', ')}`)
        lines.push('')
    }

    return lines.join('\n')
}

export default {
    routeTask,
    scoreAllNodes,
    executeRemote,
    detectMeshTaskType,
    getRoutingDiagnostics,
    NODE_PROFILES,
}
