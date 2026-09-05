/**
 * Mesh Brain
 *
 * Nova's complete picture of her compute universe.
 * She doesn't just know what's running — she understands what each node
 * is CAPABLE of, what's MISSING, and what would make sense to install where.
 *
 * Flow:
 *   1. Discover all Tailscale nodes (not just configured ones)
 *   2. For each node: deep hardware scan via NodeIntelligence
 *   3. Classify each node into capability tiers
 *   4. Run gap analysis: what should be installed where?
 *   5. Build a human-readable mesh map Nova can explain and act on
 */

import { exec } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIntelligence, NodePlaybook } from './node-intelligence.js'

const DATA_DIR = join(process.cwd(), '.nova-data')
const BRAIN_FILE = join(DATA_DIR, 'mesh-brain.json')
const BRAIN_STALE_MS = 30 * 60 * 1000   // Re-scan every 30 min

// ============================================
// Types
// ============================================

export type NodeTier =
    | 'flagship'        // Best available: 30B+ models, fast inference
    | 'compute'         // Good: 13B-30B models, reliable compute
    | 'edge'            // Limited: 3B-7B models, sensors, relays
    | 'infrastructure'  // Services: docker, databases, proxies
    | 'unknown'

export interface InstallRecommendation {
    tool: string
    reason: string
    priority: 'high' | 'medium' | 'low'
    confidence: 'measured' | 'derived' | 'assumed'  // how certain is this recommendation
    installCmd?: string
    estimatedSizeGB?: number
}

export interface NodeProfile {
    name: string
    host: string
    tier: NodeTier
    playbook: NodePlaybook
    online: boolean

    // Computed capabilities
    maxModelSize: string        // "70B", "30B", "13B", "7B", "3B", "none"
    maxModelSizeB: number       // numeric billions
    inferenceSpeed: 'fast' | 'medium' | 'slow' | 'none'
    bestFor: string[]

    // Confidence tracking — what Nova actually measured vs what she inferred
    confidence: {
        ram: 'measured' | 'assumed'         // was hw.ram_gb probed or missing?
        gpu: 'measured' | 'derived' | 'none' // nvidia-smi hit, or inferred from arch
        storage: 'measured' | 'assumed'
        overall: 'high' | 'medium' | 'low'  // aggregate — drives recommendation threshold
    }

    // Gap analysis
    recommendations: InstallRecommendation[]
    missing: string[]
}

export interface MeshSnapshot {
    scannedAt: number
    nodes: NodeProfile[]
    summary: string             // Human-readable overview Nova can state
    routingTable: RoutingEntry[] // "for task X → use node Y because Z"
}

export interface RoutingEntry {
    task: string
    bestNode: string
    reason: string
    fallback?: string
}

// ============================================
// Capability Rules
// What hardware can do what — Nova's reasoning engine
// ============================================

function classifyNode(p: NodePlaybook): {
    tier: NodeTier
    maxModelSizeB: number
    maxModelSize: string
    inferenceSpeed: 'fast' | 'medium' | 'slow' | 'none'
    bestFor: string[]
    confidence: NodeProfile['confidence']
} {
    const ram = p.hardware.ram_gb || 0
    const isUnified = p.hardware.memory_type === 'unified'
    const isMetal = p.hardware.gpu_type === 'metal' || !!p.hardware.metal
    const isCuda = p.hardware.gpu_type === 'cuda'
    const vram = p.hardware.gpu_vram_gb || 0
    const arch = p.arch || ''
    const isArm = arch.includes('arm') || arch.includes('aarch')
    const bestFor: string[] = []

    // Track what was actually measured vs assumed
    const ramMeasured = !!p.hardware.ram_gb                          // nproc/sysctl fired
    const gpuMeasured = p.hardware.gpu_type === 'cuda'               // nvidia-smi fired
    const gpuDerived  = p.hardware.gpu_type === 'metal'              // inferred from arch+os
    const storageMeasured = !!p.hardware.storage_type

    const confidence: NodeProfile['confidence'] = {
        ram:     ramMeasured  ? 'measured' : 'assumed',
        gpu:     gpuMeasured  ? 'measured' : gpuDerived ? 'derived' : 'none',
        storage: storageMeasured ? 'measured' : 'assumed',
        overall: 'low',      // computed below
    }
    const measuredCount = [ramMeasured, gpuMeasured || gpuDerived, storageMeasured].filter(Boolean).length
    confidence.overall = measuredCount >= 3 ? 'high' : measuredCount >= 1 ? 'medium' : 'low'

    // Effective memory for LLM inference
    // Unified memory (Apple Silicon): full RAM available
    // CUDA: VRAM is the bottleneck (can offload to RAM but slowly)
    // CPU-only: RAM * 0.8 (OS overhead)
    const effectiveGB = isCuda ? vram :
        isUnified ? ram :
        Math.floor(ram * 0.8)

    // Model size rules (quantized Q4/Q8):
    // 70B needs ~40GB, 32B needs ~20GB, 13B needs ~8GB, 7B needs ~5GB, 3B needs ~2GB
    let maxModelSizeB = 0
    let maxModelSize = 'none'
    let inferenceSpeed: 'fast' | 'medium' | 'slow' | 'none' = 'none'

    if (effectiveGB >= 40) {
        maxModelSizeB = 70; maxModelSize = '70B'
        inferenceSpeed = isCuda ? 'fast' : isMetal ? 'fast' : 'medium'
    } else if (effectiveGB >= 20) {
        maxModelSizeB = 32; maxModelSize = '32B'
        inferenceSpeed = isMetal ? 'fast' : 'medium'
    } else if (effectiveGB >= 10) {
        maxModelSizeB = 13; maxModelSize = '13B'
        inferenceSpeed = isMetal ? 'fast' : isCuda ? 'fast' : 'medium'
    } else if (effectiveGB >= 5) {
        maxModelSizeB = 7; maxModelSize = '7B'
        inferenceSpeed = 'medium'
    } else if (effectiveGB >= 2) {
        maxModelSizeB = 3; maxModelSize = '3B'
        inferenceSpeed = 'slow'
    }

    // Best-for capabilities
    if (maxModelSizeB >= 30) bestFor.push('large-llm', 'long-context', 'reasoning')
    if (maxModelSizeB >= 13) bestFor.push('llm', 'coding-assistant')
    if (maxModelSizeB >= 7)  bestFor.push('fast-llm', 'embedding')
    if (maxModelSizeB >= 3)  bestFor.push('small-llm')

    if (isCuda && vram >= 8)  bestFor.push('image-generation', 'cuda-inference', 'whisper-gpu')
    if (isCuda && vram >= 4)  bestFor.push('embedding-gpu')
    if (isMetal)              bestFor.push('metal-inference', 'voice-local')
    if (p.software['ffmpeg']) bestFor.push('media-convert', 'audio-process')
    if (p.software['docker']) bestFor.push('containerized-services')
    if (p.software['faster_whisper'] || p.software['whisper']) bestFor.push('stt')
    if (p.software['comfyui'] || p.software['stable_diffusion']) bestFor.push('image-generation')

    // Edge nodes (Pi, Jetson, low RAM)
    if (ram <= 8 && !isCuda) {
        bestFor.push('relay', 'sensor', 'edge-logic')
        if (isArm) bestFor.push('llama-cpp')
    }

    // Tier classification
    let tier: NodeTier = 'unknown'
    if (maxModelSizeB >= 30) tier = 'flagship'
    else if (maxModelSizeB >= 13 || (isCuda && vram >= 8)) tier = 'compute'
    else if (ram > 0) tier = 'edge'
    if (p.software['docker'] && ram < 8) tier = 'infrastructure'

    return { tier, maxModelSizeB, maxModelSize, inferenceSpeed, bestFor, confidence }
}

// ============================================
// Gap Analysis — what SHOULD be on this node?
// ============================================

function analyzeGaps(p: NodePlaybook, classification: ReturnType<typeof classifyNode>): {
    recommendations: InstallRecommendation[]
    missing: string[]
} {
    const recs: InstallRecommendation[] = []
    const missing: string[] = []
    const { maxModelSizeB, confidence } = classification
    const isCuda = p.hardware.gpu_type === 'cuda'
    const hasOllama = !!p.software['ollama']

    // Confidence gate: skip speculative install recommendations when we have low confidence.
    // "measured" = probe actually fired. "derived" = inferred from arch+os. "assumed" = default fallback.
    // Rule: only emit HIGH-priority recs if RAM is at least derived. Skip everything on 'low' overall confidence.
    const canRecommend = confidence.overall !== 'low'
    const canRecommendStrong = confidence.ram === 'measured'

    // Ollama — should be on any node that can run inference.
    // Only skip if we have no idea how much RAM the node has.
    if (!hasOllama && maxModelSizeB >= 3 && canRecommend) {
        recs.push({
            tool: 'ollama',
            reason: `${maxModelSizeB}B Modelle lokal ausführen`,
            priority: 'high',
            confidence: canRecommendStrong ? 'measured' : 'derived',
            installCmd: 'curl -fsSL https://ollama.ai/install.sh | sh',
        })
        missing.push('ollama')
    }

    // LLM model recommendations based on memory — only when RAM was actually measured
    if (hasOllama && canRecommendStrong) {
        const existing = new Set(p.ollamaModels || [])
        const hasAnyModel = existing.size > 0
        const hasEmbedding = [...existing].some(m => m.includes('embed') || m.includes('nomic') || m.includes('mxbai'))

        if (maxModelSizeB >= 30 && !hasAnyModel) {
            recs.push({ tool: 'qwen2.5:32b', reason: `${p.hardware.ram_gb}GB RAM gemessen → 32B läuft flüssig`, priority: 'high', confidence: 'measured', installCmd: 'ollama pull qwen2.5:32b', estimatedSizeGB: 20 })
            recs.push({ tool: 'llama3.3:70b', reason: `${p.hardware.ram_gb}GB → 70B quantisiert möglich`, priority: 'medium', confidence: 'measured', installCmd: 'ollama pull llama3.3:70b', estimatedSizeGB: 43 })
        } else if (maxModelSizeB >= 13 && !hasAnyModel) {
            recs.push({ tool: 'qwen2.5:14b', reason: `${p.hardware.ram_gb}GB RAM gemessen → 14B passt gut`, priority: 'high', confidence: 'measured', installCmd: 'ollama pull qwen2.5:14b', estimatedSizeGB: 9 })
        } else if (maxModelSizeB >= 7 && !hasAnyModel) {
            recs.push({ tool: 'qwen2.5:7b', reason: `${p.hardware.ram_gb}GB RAM → 7B Allrounder`, priority: 'high', confidence: 'measured', installCmd: 'ollama pull qwen2.5:7b', estimatedSizeGB: 5 })
        }

        if (!hasEmbedding && maxModelSizeB >= 3) {
            recs.push({ tool: 'nomic-embed-text', reason: 'Embedding-Modell fehlt — Nova braucht es für ihr Gedächtnis', priority: 'high', confidence: 'measured', installCmd: 'ollama pull nomic-embed-text', estimatedSizeGB: 0.3 })
            missing.push('embedding-model')
        }
    } else if (hasOllama && canRecommend && !canRecommendStrong) {
        // RAM not directly measured — lower-confidence suggestion, no model size claim
        recs.push({ tool: 'nomic-embed-text', reason: 'Ollama vorhanden aber RAM nicht gemessen — Embedding-Modell als sicherer Einstieg', priority: 'medium', confidence: 'derived', installCmd: 'ollama pull nomic-embed-text', estimatedSizeGB: 0.3 })
    }

    // Image generation — only when nvidia-smi actually confirmed GPU+VRAM (measured, not derived)
    if (isCuda && confidence.gpu === 'measured' && (p.hardware.gpu_vram_gb || 0) >= 8
        && !p.software['comfyui'] && !p.software['stable_diffusion']) {
        recs.push({
            tool: 'ComfyUI',
            reason: `${p.hardware.gpu} ${p.hardware.gpu_vram_gb}GB VRAM gemessen → Stable Diffusion XL möglich`,
            priority: 'medium',
            confidence: 'measured',
            installCmd: 'git clone https://github.com/comfyanonymous/ComfyUI && cd ComfyUI && pip install -r requirements.txt',
        })
        missing.push('image-generation')
    }

    // faster-whisper — decent CPU or confirmed GPU
    const hasWhisper = p.software['faster_whisper'] || p.software['whisper']
    if (!hasWhisper && canRecommend && (maxModelSizeB >= 7 || (isCuda && confidence.gpu === 'measured' && (p.hardware.gpu_vram_gb || 0) >= 4))) {
        recs.push({
            tool: 'faster-whisper',
            reason: 'Lokale STT für Voice-Pipeline',
            priority: 'medium',
            confidence: canRecommendStrong ? 'measured' : 'derived',
            installCmd: 'pip install faster-whisper',
        })
        missing.push('stt')
    }

    // llama.cpp — ARM nodes without Ollama, only when RAM measured
    if (!hasOllama && maxModelSizeB > 0 && maxModelSizeB <= 7 && p.arch?.includes('arm') && canRecommendStrong) {
        recs.push({
            tool: 'llama.cpp',
            reason: `ARM, ${p.hardware.ram_gb}GB gemessen — llama.cpp effizienter als Ollama`,
            priority: 'high',
            confidence: 'measured',
            installCmd: 'git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && make',
        })
        missing.push('llm-runtime')
    }

    return { recommendations: recs, missing }
}

// ============================================
// Tailscale Discovery
// ============================================

function getTailscaleNodes(): Promise<Array<{ name: string, ip: string, os: string, online: boolean }>> {
    return new Promise(resolve => {
        exec('tailscale status --json', { timeout: 8000 }, (err, stdout) => {
            if (err || !stdout) { resolve([]); return }
            try {
                const data = JSON.parse(stdout)
                const nodes: Array<{ name: string, ip: string, os: string, online: boolean }> = []

                // Self node
                if (data.Self) {
                    nodes.push({
                        name: data.Self.HostName || 'self',
                        ip: data.Self.TailscaleIPs?.[0] || '',
                        os: data.Self.OS || '',
                        online: true,
                    })
                }

                // Peer nodes
                if (data.Peer) {
                    for (const peer of Object.values(data.Peer) as any[]) {
                        nodes.push({
                            name: peer.HostName || peer.DNSName?.split('.')[0] || '',
                            ip: peer.TailscaleIPs?.[0] || '',
                            os: peer.OS || '',
                            online: peer.Online === true,
                        })
                    }
                }
                resolve(nodes)
            } catch { resolve([]) }
        })
    })
}

// ============================================
// Mesh Brain — Main Engine
// ============================================

export class MeshBrain {
    private snapshot: MeshSnapshot | null = null

    async scan(configNodes: Array<{ name: string, host: string }>): Promise<MeshSnapshot> {
        console.log('[MeshBrain] 🧠 Starte vollständigen Mesh-Scan...')

        // 1. Get all Tailscale nodes
        const tailscaleNodes = await getTailscaleNodes()
        console.log(`[MeshBrain] 📡 Tailscale: ${tailscaleNodes.length} Nodes gefunden`)

        // 2. Merge: config nodes + tailscale nodes (dedup by IP)
        const allHosts = new Map<string, { name: string, host: string, online: boolean }>()

        for (const cn of configNodes) {
            if (!cn.host || cn.host === 'localhost' || !(cn as any).enabled !== false) {
                const ip = cn.host.includes('@') ? cn.host.split('@')[1] : cn.host
                if (ip && ip !== 'localhost') allHosts.set(ip, { name: cn.name, host: cn.host, online: true })
            }
        }
        for (const tn of tailscaleNodes) {
            if (tn.ip && !allHosts.has(tn.ip)) {
                // New node not in config — try to SSH as common users
                const sshHost = `${tn.os?.toLowerCase().includes('windows') ? '' : 'root@'}${tn.ip}`
                allHosts.set(tn.ip, { name: tn.name, host: sshHost, online: tn.online })
            }
        }

        // 3. For each host: deep scan (parallel, timeout per node)
        const profiles: NodeProfile[] = []
        const scanPromises = [...allHosts.entries()].map(async ([ip, info]) => {
            if (!info.online) {
                // Still try to load cached playbook
                const cached = NodeIntelligence.load(info.name)
                if (cached) {
                    const cls = classifyNode(cached)
                    const gaps = analyzeGaps(cached, cls)
                    profiles.push({ name: info.name, host: info.host, tier: cls.tier, playbook: cached, online: false, ...cls, ...gaps })
                }
                return
            }

            try {
                const playbook = await NodeIntelligence.getOrDiscover(info.host, info.name)
                const cls = classifyNode(playbook)
                const gaps = analyzeGaps(playbook, cls)
                profiles.push({
                    name: info.name,
                    host: info.host,
                    tier: cls.tier,
                    playbook,
                    online: true,
                    ...cls,
                    ...gaps,
                })
                console.log(`[MeshBrain] ✅ ${info.name}: ${cls.tier} — max ${cls.maxModelSize} — ${cls.bestFor.slice(0, 3).join(', ')}`)
            } catch (e) {
                console.log(`[MeshBrain] ⚠️ ${info.name} (${ip}): Scan fehlgeschlagen`)
            }
        })

        await Promise.allSettled(scanPromises)

        // 4. Build routing table
        const routingTable = this.buildRoutingTable(profiles)

        // 5. Build summary
        const summary = this.buildSummary(profiles, routingTable)

        this.snapshot = { scannedAt: Date.now(), nodes: profiles, summary, routingTable }
        this.save()

        console.log(`[MeshBrain] 🏁 Scan abgeschlossen: ${profiles.length} Nodes, ${routingTable.length} Routing-Einträge`)
        return this.snapshot
    }

    private buildRoutingTable(nodes: NodeProfile[]): RoutingEntry[] {
        const online = nodes.filter(n => n.online)
        const entries: RoutingEntry[] = []

        const best = (task: string, filter: (n: NodeProfile) => boolean, reason: (n: NodeProfile) => string): void => {
            const candidates = online.filter(filter).sort((a, b) => b.maxModelSizeB - a.maxModelSizeB)
            if (candidates.length > 0) {
                entries.push({ task, bestNode: candidates[0].name, reason: reason(candidates[0]), fallback: candidates[1]?.name })
            }
        }

        best('large-llm', n => n.maxModelSizeB >= 30, n => `${n.name} hat ${n.playbook.hardware.ram_gb}GB ${n.playbook.hardware.memory_type || 'RAM'} — kann ${n.maxModelSize} lokal`)
        best('fast-llm', n => n.maxModelSizeB >= 7 && n.inferenceSpeed === 'fast', n => `${n.name} — ${n.maxModelSize} bei ${n.inferenceSpeed} Speed`)
        best('embedding', n => n.bestFor.includes('embedding') || n.bestFor.includes('embedding-gpu'), n => `${n.name} hat Ollama + passendes Modell`)
        best('image-generation', n => n.bestFor.includes('image-generation'), n => `${n.name} hat ${n.playbook.hardware.gpu} ${n.playbook.hardware.gpu_vram_gb}GB VRAM`)
        best('stt-voice', n => n.bestFor.includes('stt') || n.bestFor.includes('voice-local'), n => `${n.name} hat Whisper/faster-whisper`)
        best('media-convert', n => n.bestFor.includes('media-convert'), n => `${n.name} hat ffmpeg`)
        best('cuda-inference', n => n.bestFor.includes('cuda-inference'), n => `${n.name} hat CUDA GPU`)

        return entries
    }

    private buildSummary(nodes: NodeProfile[], routing: RoutingEntry[]): string {
        const online = nodes.filter(n => n.online)
        const offline = nodes.filter(n => !n.online)
        const lines: string[] = []

        lines.push(`Nova sieht ${nodes.length} Nodes im Mesh (${online.length} online, ${offline.length} offline):\n`)

        for (const n of nodes.sort((a, b) => b.maxModelSizeB - a.maxModelSizeB)) {
            const status = n.online ? '🟢' : '🔴'

            // Show confidence next to each measured value so it's clear what's real
            const ramStr = n.playbook.hardware.ram_gb
                ? `${n.playbook.hardware.ram_gb}GB RAM${n.confidence.ram === 'measured' ? '' : ' (geschätzt)'}`
                : 'RAM unbekannt'
            const gpuStr = n.playbook.hardware.gpu
                ? ` | GPU: ${n.playbook.hardware.gpu} ${n.playbook.hardware.gpu_vram_gb || '?'}GB${n.confidence.gpu === 'measured' ? '' : ' (abgeleitet)'}`
                : n.playbook.hardware.metal ? ' | Metal (unified)' : ''
            const modelStr = n.maxModelSizeB > 0
                ? `max ${n.maxModelSize}${n.confidence.overall !== 'high' ? '~' : ''}`
                : 'kein Inference'

            lines.push(`${status} ${n.name} [${n.tier}] — ${ramStr}${gpuStr} → ${modelStr}`)

            // Recommendations: only show if confidence warrants it, with their own confidence marker
            const recs = n.recommendations.filter(r => r.priority === 'high' || n.confidence.overall === 'high')
            if (recs.length > 0) {
                const recStr = recs.slice(0, 2).map(r =>
                    `${r.tool}${r.confidence !== 'measured' ? ` (${r.confidence})` : ''}`
                ).join(', ')
                lines.push(`   ⚡ Empfehlung: ${recStr}`)
            }
        }

        lines.push('\nOptimales Routing:')
        for (const r of routing.slice(0, 5)) {
            // Always show reason + fallback
            const fb = r.fallback ? ` | Fallback: ${r.fallback}` : ''
            lines.push(`  ${r.task} → ${r.bestNode} (${r.reason})${fb}`)
        }

        return lines.join('\n')
    }

    getSnapshot(): MeshSnapshot | null {
        return this.snapshot
    }

    load(): MeshSnapshot | null {
        try {
            if (existsSync(BRAIN_FILE)) {
                const data = JSON.parse(readFileSync(BRAIN_FILE, 'utf-8'))
                if (Date.now() - data.scannedAt < BRAIN_STALE_MS) {
                    this.snapshot = data
                    return data
                }
            }
        } catch { /* ignore */ }
        return null
    }

    save(): void {
        if (!this.snapshot) return
        try {
            if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
            writeFileSync(BRAIN_FILE, JSON.stringify(this.snapshot, null, 2))
        } catch { /* ignore */ }
    }

    /**
     * Nova can call this to get a full mesh overview in natural language
     */
    async explain(configNodes: Array<{ name: string, host: string }>): Promise<string> {
        const snap = this.load() || await this.scan(configNodes)
        return snap.summary
    }

    /**
     * Best node for a given task type
     */
    getBestNodeFor(task: string): RoutingEntry | null {
        return this.snapshot?.routingTable.find(r => r.task === task) || null
    }

    /**
     * All recommendations across all nodes
     */
    getAllRecommendations(): Array<{ node: string, rec: InstallRecommendation }> {
        if (!this.snapshot) return []
        return this.snapshot.nodes.flatMap(n =>
            n.recommendations.map(rec => ({ node: n.name, rec }))
        ).sort((a, b) => {
            const p = { high: 0, medium: 1, low: 2 }
            return p[a.rec.priority] - p[b.rec.priority]
        })
    }
}

let brainInstance: MeshBrain | null = null
export function getMeshBrain(): MeshBrain {
    if (!brainInstance) brainInstance = new MeshBrain()
    return brainInstance
}

export default { MeshBrain, getMeshBrain }
