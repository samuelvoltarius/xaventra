// Mesh Capability Orchestrator — Nova knows what every node + cloud can do
// No hardcoding. Dynamic discovery + intelligent routing.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CapabilityGraphSnapshot, CapabilityRuntime, CapabilityGraphNode } from './capability-graph.js'
import { getCapabilityGraph, capabilityNodeOnline, capabilityRuntimeAvailable, capabilityRuntimeTombstoned } from './capability-graph.js'
import { configuredCloudProviders } from '../llm/active-runtime.js'

const DATA_DIR = join(process.cwd(), '.nova-data', 'capabilities')

// ============================================
// Types
// ============================================

interface NodeCapability {
    name: string           // 'vision', 'tts', 'stt', 'llm', 'embedding', 'code-exec'
    provider: string       // 'moondream', 'whisper', 'piper', 'openai', 'ollama'
    quality: number        // 1-10 (gpt-5.4-vision=9, moondream=5)
    cost: 'free' | 'cheap' | 'expensive'
    speed: 'fast' | 'medium' | 'slow'
    available: boolean
}

interface MeshNode {
    name: string           // 'master', 'jetson', 'pi5'
    address: string        // Tailscale IP
    hardware: {
        gpu: boolean
        gpuType?: string     // 'orin-nano', 'none'
        ramGB: number
        arch: string         // 'x64', 'arm64'
    }
    capabilities: NodeCapability[]
    /** Deprecated compatibility alias: historically contains ALL runtime models. */
    ollamaModels: string[]
    runtimes?: Array<Pick<CapabilityRuntime, 'id' | 'name' | 'status' | 'models' | 'verifiedAt' | 'verificationSource'> & { available: boolean }>
    lastProbed: string
    online: boolean
}

interface CloudProvider {
    name: string           // 'openai', 'openai', 'minimax'
    capabilities: NodeCapability[]
    available: boolean
    apiKey: boolean        // Has API key configured
}

interface CapabilityRequest {
    capability: string     // What we need: 'vision', 'tts', 'stt', 'llm'
    preferLocal: boolean   // Prefer local over cloud
    preferQuality: boolean // Prefer quality over cost
    input?: string         // Context for decision
}

interface CapabilityMatch {
    source: 'node' | 'cloud'
    nodeName: string
    provider: string
    quality: number
    cost: string
    reason: string
}

// ============================================
// State
// ============================================

let nodes: MeshNode[] = []
let cloudProviders: CloudProvider[] = []

// Heartbeats and configured runtimes carry the runtime's own name as type ("vllm", "whisper", "lm-studio").
const LLM_RUNTIME = /^(llm|vllm|ollama|lm[-_ ]?studio|llama[-_. ]?cpp|llamacpp|llama[-_]?server|koboldcpp|openai[-_ ]?compatible|local)$/i
const STT_RUNTIME = /^(stt|whisper|whisper[-_.]?cpp|whisper[-_]?server|whisper[-_]?gpu|faster[-_]?whisper|vosk|parakeet)$/i
const TTS_RUNTIME = /^(tts|piper|kokoro|xtts|f5[-_]?tts)$/i

function capabilityNames(runtime: CapabilityRuntime): string[] {
    const names = new Set(runtime.capabilities || [])
    // The runtime name only counts when the type is generic; "embeddings" on a runtime named Ollama stays an embedding.
    const typed = ['embeddings', 'embedding', 'image', 'search', 'vlm', 'tts', 'stt'].includes(String(runtime.type))
    const labels = [runtime.type, ...(typed ? [] : [runtime.name])].map(value => String(value || '').trim())
    if (labels.some(label => LLM_RUNTIME.test(label))) names.add('llm')
    if (labels.some(label => STT_RUNTIME.test(label))) names.add('stt')
    if (labels.some(label => TTS_RUNTIME.test(label))) names.add('tts')
    if (runtime.type === 'llm') names.add('llm')
    if (runtime.type === 'vlm' || runtime.type === 'image') names.add('vision')
    if (runtime.type === 'embeddings') names.add('embedding')
    if (runtime.type === 'tts' || runtime.type === 'stt') names.add(runtime.type)
    return [...names].filter(name => ['vision', 'tts', 'stt', 'llm', 'embedding', 'code', 'tools'].includes(name))
}

function runtimeQuality(runtime: CapabilityRuntime): number {
    const performance = (runtime.metadata?.performance || {}) as Record<string, { online?: boolean; avgLatencyMs?: number }>
    const live = Object.values(performance).filter(sample => sample.online !== false)
    if (!live.length) return runtime.status === 'running' ? 6 : 4
    const latency = Math.min(...live.map(sample => Number(sample.avgLatencyMs || 10_000)))
    if (latency < 500) return 9
    if (latency < 1_500) return 8
    if (latency < 5_000) return 7
    return 6
}

function mapHardware(node: CapabilityGraphNode): MeshNode['hardware'] {
    const hardware = node.hardware
    return {
        gpu: Boolean(hardware?.gpu),
        gpuType: hardware?.gpu,
        ramGB: Number(hardware?.ram_gb || 0),
        arch: hardware?.arch || 'unknown',
    }
}

/** Compatibility projection for older tools. The canonical graph remains the
 * single discovery authority; this function performs no network probing. */
export function nodesFromCapabilityGraph(snapshot: CapabilityGraphSnapshot): MeshNode[] {
    const now = Date.now()
    const tombstones = new Map((snapshot.tombstones || []).map(item => [item.id, item]))
    return snapshot.nodes
        .filter(node => node.status === 'online' || node.status === 'busy')
        .map(node => {
            const runtimes = node.runtimes.filter(runtime => !capabilityRuntimeTombstoned(runtime, tombstones.get(runtime.id)))
            const capabilities: NodeCapability[] = []
            for (const runtime of runtimes) {
                const quality = runtimeQuality(runtime)
                for (const name of capabilityNames(runtime)) for (const provider of runtime.models.length ? runtime.models : [runtime.name]) {
                    capabilities.push({
                        name,
                        provider,
                        quality,
                        cost: 'free',
                        speed: quality >= 8 ? 'fast' : quality >= 6 ? 'medium' : 'slow',
                        available: capabilityRuntimeAvailable(node, runtime, now),
                    })
                }
            }
            return {
                name: node.id,
                address: node.host || node.hostname,
                hardware: mapHardware(node),
                capabilities,
                ollamaModels: [...new Set(runtimes.flatMap(runtime => runtime.models))],
                // Only shareable display fields. Do not serialize endpoints or
                // arbitrary runtime metadata into the conversation prompt.
                runtimes: runtimes.map(runtime => ({
                    id: runtime.id, name: runtime.name, status: runtime.status,
                    models: [...runtime.models], verifiedAt: runtime.verifiedAt,
                    verificationSource: runtime.verificationSource,
                    available: capabilityRuntimeAvailable(node, runtime, now),
                })),
                lastProbed: node.lastHeartbeat || node.updatedAt,
                online: capabilityNodeOnline(node, now),
            }
        })
}

function refreshCapabilityProjection(): void {
    // Scans/heartbeats continue after boot. Never keep a second authoritative
    // inventory or probe the network on the synchronous chat/tool read path.
    try { nodes = nodesFromCapabilityGraph(getCapabilityGraph().getSnapshot()) }
    catch { nodes = [] } // Do not route from a stale cache after a read failure.
    cloudProviders = discoverCloudCapabilities()
}

// ============================================
// Discovery — Probe what each node has
// ============================================

export async function probeNode(name: string, address: string): Promise<MeshNode> {
    const node: MeshNode = {
        name,
        address,
        hardware: { gpu: false, ramGB: 0, arch: 'unknown' },
        capabilities: [],
        ollamaModels: [],
        lastProbed: new Date().toISOString(),
        online: false,
    }

    // 1. Check if node is reachable
    try {
        const resp = await fetch(`http://${address}:11434/api/tags`, {
            signal: AbortSignal.timeout(5000),
        })
        if (resp.ok) {
            node.online = true
            const data = await resp.json() as any

            // List all Ollama models
            if (data.models) {
                node.ollamaModels = data.models.map((m: any) => m.name || m.model)

                // Derive capabilities from installed models
                for (const model of node.ollamaModels) {
                    const modelLC = model.toLowerCase()

                    // Vision models
                    if (modelLC.includes('moondream') || modelLC.includes('llava') || modelLC.includes('bakllava')) {
                        node.capabilities.push({
                            name: 'vision',
                            provider: model,
                            quality: modelLC.includes('llava') ? 7 : 5,
                            cost: 'free',
                            speed: 'medium',
                            available: true,
                        })
                    }

                    // LLM models
                    if (modelLC.includes('llama') || modelLC.includes('mistral') || modelLC.includes('gemma') ||
                        modelLC.includes('qwen') || modelLC.includes('phi') || modelLC.includes('deepseek')) {
                        node.capabilities.push({
                            name: 'llm',
                            provider: model,
                            quality: modelLC.includes('70b') ? 8 : modelLC.includes('13b') ? 6 : 5,
                            cost: 'free',
                            speed: modelLC.includes('70b') ? 'slow' : 'fast',
                            available: true,
                        })
                    }

                    // Embedding models
                    if (modelLC.includes('nomic') || modelLC.includes('embed') || modelLC.includes('mxbai')) {
                        node.capabilities.push({
                            name: 'embedding',
                            provider: model,
                            quality: 6,
                            cost: 'free',
                            speed: 'fast',
                            available: true,
                        })
                    }
                }
            }
        }
    } catch { /* node offline */ }

    // 2. Check for whisper (STT)
    try {
        const resp = await fetch(`http://${address}:8765/health`, {
            signal: AbortSignal.timeout(3000),
        })
        if (resp.ok) {
            node.capabilities.push({
                name: 'stt',
                provider: 'whisper',
                quality: 8,
                cost: 'free',
                speed: 'medium',
                available: true,
            })
        }
    } catch { /* no whisper */ }

    // 3. Check for TTS
    try {
        const resp = await fetch(`http://${address}:8766/health`, {
            signal: AbortSignal.timeout(3000),
        })
        if (resp.ok) {
            node.capabilities.push({
                name: 'tts',
                provider: 'piper',
                quality: 7,
                cost: 'free',
                speed: 'fast',
                available: true,
            })
        }
    } catch { /* no tts */ }

    // 4. Hardware detection from node name
    if (name === 'jetson' || name.includes('orin')) {
        node.hardware = { gpu: true, gpuType: 'orin-nano', ramGB: 8, arch: 'arm64' }
    } else if (name === 'pi5') {
        node.hardware = { gpu: false, ramGB: 8, arch: 'arm64' }
    } else if (name === 'master') {
        node.hardware = { gpu: true, gpuType: 'desktop', ramGB: 32, arch: 'x64' }
    }

    return node
}

// Discover cloud provider capabilities
export function discoverCloudCapabilities(config: unknown = (globalThis as any).__novaState?.config): CloudProvider[] {
    // 2.89 Paket C: which cloud providers are set up comes from the ONE place
    // (llm/active-runtime.ts). Before: a fixed list here (OpenAI twice, wrong embedding model,
    // no Gemini/Anthropic). Presence of a key only; "embedding" is NOT claimed for a cloud
    // provider that is not the memory's embedding source (memory embeds locally only).
    return configuredCloudProviders(config).map(view => ({
        name: view.name,
        available: view.keyPresent,
        apiKey: view.keyPresent,
        capabilities: view.capabilities
            .filter(name => name !== 'embedding')
            .map((name): NodeCapability => ({ name, provider: view.name, quality: view.active ? 9 : 8, cost: 'cheap', speed: 'fast', available: view.keyPresent })),
    }))
}

// ============================================
// Routing — Find best option for a capability
// ============================================

export function findBestCapability(request: CapabilityRequest): CapabilityMatch | null {
    refreshCapabilityProjection()
    const allOptions: CapabilityMatch[] = []

    // Collect from nodes
    for (const node of nodes) {
        if (!node.online) continue
        for (const cap of node.capabilities) {
            if (cap.name === request.capability && cap.available) {
                allOptions.push({
                    source: 'node',
                    nodeName: node.name,
                    provider: cap.provider,
                    quality: cap.quality,
                    cost: cap.cost,
                    reason: `${node.name} hat ${cap.provider} (lokal, ${cap.cost})`,
                })
            }
        }
    }

    // Collect from cloud
    for (const cloud of cloudProviders) {
        if (!cloud.available) continue
        for (const cap of cloud.capabilities) {
            if (cap.name === request.capability && cap.available) {
                allOptions.push({
                    source: 'cloud',
                    nodeName: cloud.name,
                    provider: cap.provider,
                    quality: cap.quality,
                    cost: cap.cost,
                    reason: `${cloud.name} Cloud (${cap.provider}, quality ${cap.quality}/10)`,
                })
            }
        }
    }

    if (allOptions.length === 0) return null

    // Sort by preference
    allOptions.sort((a, b) => {
        // Prefer local if requested
        if (request.preferLocal) {
            if (a.source === 'node' && b.source === 'cloud') return -1
            if (a.source === 'cloud' && b.source === 'node') return 1
        }

        // Prefer quality if requested
        if (request.preferQuality) {
            return b.quality - a.quality
        }

        // Default: quality first, then cost
        if (b.quality !== a.quality) return b.quality - a.quality
        const costOrder = { free: 0, cheap: 1, expensive: 2 }
        return (costOrder[a.cost as keyof typeof costOrder] || 0) - (costOrder[b.cost as keyof typeof costOrder] || 0)
    })

    return allOptions[0]
}

// Get all available capabilities as a formatted string
export function getCapabilityMap(): string {
    refreshCapabilityProjection()
    const lines = ['## Mesh Capability Map',
        'Automatisch erkannter Bestand. running + aktuelle Probe/Heartbeat = Routing-Kandidat; kein Beleg fuer Benutzer-Anmeldung oder erfolgreiche Tool-Ausfuehrung.',
        'installed/stopped/veraltet bedeutet NICHT nutzbar. Fehlend bedeutet nicht erkannt, nicht zwingend nicht installiert. Installation erfordert einen freigegebenen Setup-Plan.']

    for (const node of nodes) {
        const status = node.online ? '🟢' : '🔴'
        lines.push(`\n### ${status} ${node.name} (${node.address})`)
        lines.push(`Hardware: ${node.hardware.arch}, ${node.hardware.ramGB}GB RAM${node.hardware.gpu ? ', GPU: ' + node.hardware.gpuType : ''}`)

        for (const runtime of node.runtimes || []) {
            lines.push(`${runtime.name}: ${runtime.models.join(', ') || 'keine Modelle gemeldet'} | ${runtime.status} | ${runtime.available ? 'aktuell erreichbar' : 'nicht als nutzbar bestaetigt'} | ${runtime.verificationSource} ${runtime.verifiedAt}`)
        }

        if (node.capabilities.length > 0) {
            for (const cap of node.capabilities) {
                lines.push(`  - ${cap.name}: ${cap.provider} (${cap.available ? 'Routing-Kandidat' : 'nicht verfuegbar'})`)
            }
        } else {
            lines.push('  Keine Capabilities erkannt')
        }
    }

    lines.push('\n### ☁️ Cloud Providers (Konfiguration, keine Live-/Auth-Pruefung)')
    for (const cloud of cloudProviders) {
        const status = cloud.available ? '🟢' : '🔴'
        lines.push(`${status} ${cloud.name}: ${cloud.capabilities.map(c => c.name).join(', ')}`)
    }

    return lines.join('\n')
}

// What capabilities are MISSING across all nodes?
export function getMissingCapabilities(): string[] {
    refreshCapabilityProjection()
    const allNeeded = ['vision', 'tts', 'stt', 'llm', 'embedding']
    const allAvailable = new Set<string>()

    for (const node of nodes) {
        for (const cap of node.capabilities) {
            if (cap.available) allAvailable.add(cap.name)
        }
    }
    for (const cloud of cloudProviders) {
        for (const cap of cloud.capabilities) {
            if (cap.available) allAvailable.add(cap.name)
        }
    }

    return allNeeded.filter(n => !allAvailable.has(n))
}

/** Online node with a runtime that is marked running but whose last proof is too old (not re-confirmed yet). */
function unconfirmedRunning(capability: string): { node: string; runtime: string } | null {
    for (const node of nodes) {
        if (!node.online) continue
        for (const runtime of node.runtimes || []) {
            if (runtime.status !== 'running' || runtime.available) continue
            const provides = node.capabilities.some(cap => cap.name === capability
                && (runtime.models.length ? runtime.models.includes(cap.provider) : cap.provider === runtime.name))
            if (provides) return { node: node.name, runtime: runtime.name }
        }
    }
    return null
}

// Suggest where to install a missing capability
export function suggestInstallation(capability: string): string | null {
    refreshCapabilityProjection()
    if (!['stt', 'tts', 'vision', 'embedding', 'llm'].includes(capability)) return null
    const available = findBestCapability({ capability, preferLocal: true, preferQuality: false })
    if (available) return `${capability} bereits verfuegbar: ${available.nodeName}/${available.provider}. Vor Neuinstallation vorhandenen Kandidaten pruefen.`

    const online = nodes.filter(node => node.online)
    // A runtime that ran at the last look but is not re-confirmed yet (restart, first scan pending)
    // is not "installed ollama": wait for the scan, do not point at another runtime or an install.
    const pending = unconfirmedRunning(capability)
    if (pending) return `${capability}: ${pending.runtime} auf ${pending.node} lief laut letztem Stand, ist aber noch nicht neu bestaetigt. Naechsten Scan abwarten, nicht neu installieren.`
    for (const node of online) {
        const providers = new Set(node.capabilities.filter(cap => cap.name === capability).map(cap => cap.provider))
        const installed = node.runtimes?.find(runtime =>
            ['installed', 'stopped'].includes(runtime.status) && (providers.has(runtime.name) || runtime.models.some(model => providers.has(model))))
        if (installed) return `${capability}: ${installed.name} auf ${node.name} bereits installiert/gemeldet (${installed.status}, ${installed.verifiedAt}). Zuerst Start/Konfiguration pruefen, nicht erneut installieren. Setup-Plan und Freigabe vor Aenderungen.`
    }
    if (!online.length) return `${capability} nicht erkannt; kein aktuell erreichbarer Node belegt. Erst lokalen oder angemeldeten Node-Bestand pruefen.`
    const candidates = online.map(node => `${node.name} (${node.hardware.arch}, ${node.hardware.ramGB || 'unbekannt'} GB RAM${node.hardware.gpuType ? `, ${node.hardware.gpuType}` : ''})`)
    return `${capability} nicht als nutzbar erkannt. Bestand fuer Setup-Plan: ${candidates.join('; ')}. OS, Architektur, freie Ressourcen und kompatible Installationswege mit self_setup_plan/self_setup_research pruefen; noch keine Eignungszusage. Aenderungen erst nach Freigabe und mit Funktionspruefung.`
}

// Stufe 1 (30.09.2026): the former autoProvision/findOrProvision installed
// fixed packages over ssh without host-key checking, behind a confirm
// string the model could write itself. Removed; installation comes back only
// as a signed catalog with owner ticket and rollback (STUFENPLAN Stufe 2).

// ============================================
// Persistence
// ============================================

function saveState(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'nodes.json'), JSON.stringify(nodes, null, 2))
        writeFileSync(join(DATA_DIR, 'cloud.json'), JSON.stringify(cloudProviders, null, 2))
    } catch { }
}

function loadState(): void {
    try {
        const nodesPath = join(DATA_DIR, 'nodes.json')
        const cloudPath = join(DATA_DIR, 'cloud.json')
        if (existsSync(nodesPath)) nodes = JSON.parse(readFileSync(nodesPath, 'utf-8'))
        if (existsSync(cloudPath)) cloudProviders = JSON.parse(readFileSync(cloudPath, 'utf-8'))
    } catch { }
}

// ============================================
// Init — Full discovery on startup
// ============================================

export async function initCapabilityOrchestrator(): Promise<void> {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    console.log('[Capabilities] Hydrating legacy view from canonical Capability Graph...')
    refreshCapabilityProjection()

    // Discover cloud capabilities
    cloudProviders = discoverCloudCapabilities()
    const cloudCount = cloudProviders.filter(c => c.available).length
    console.log(`[Capabilities]   Cloud: ${cloudCount} providers available`)

    // Report missing capabilities
    const unconfirmed = getMissingCapabilities().filter(name => unconfirmedRunning(name))
    if (unconfirmed.length > 0) console.log(`[Capabilities] ⏳ Noch nicht neu bestaetigt (lief beim letzten Stand, wartet auf den ersten Scan): ${unconfirmed.join(', ')}`)
    const missing = getMissingCapabilities().filter(name => !unconfirmed.includes(name))
    if (missing.length > 0) {
        console.log(`[Capabilities] ⚠️ Missing: ${missing.join(', ')}`)
        for (const m of missing) {
            const suggestion = suggestInstallation(m)
            if (suggestion) console.log(`[Capabilities]   → ${suggestion}`)
        }
    }

    saveState()
    const totalCaps = nodes.reduce((s, n) => s + n.capabilities.length, 0) +
        cloudProviders.reduce((s, c) => s + c.capabilities.length, 0)
    console.log(`[Capabilities] ✅ Projected: ${totalCaps} capabilities across ${nodes.length} live nodes + ${cloudCount} cloud (0 network probes)`)
}
