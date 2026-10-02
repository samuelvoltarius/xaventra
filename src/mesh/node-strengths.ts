/**
 * Knoten-Stärken (2.86 Paket J „Ein Mesh-Gehirn“, Alfred 02.10.2026).
 *
 * DAS eine Modul für „wer kann was am besten“. Es bewertet nur gemessene Fakten:
 *  - Hardware aus dem signierten Knotenprofil (node.capabilities, an die
 *    authentifizierte Quelle gebunden) und aus dem Capability-Graph,
 *  - laufende Software aus dem Capability-Graph (Scanner + Herzschlag-Runtimes)
 *    und dem Profil (Dienste, Werkzeuge),
 *  - Erfolgsraten aus dem Outcome-Ledger, nur validierte Owner-Läufe
 *    (`ownerKernelRun`, die eine Regel), erst ab MIN_MEASURED_SAMPLES Läufen.
 *
 * `rankNodes(fuer, facts)` ist rein und deterministisch (Gleichstand → Knoten-ID)
 * und liefert je Platz eine Begründung. Paket K (Main-Nachfolge) nutzt
 * `rankNodes('main', await collectStrengthFacts())`.
 *
 * Hier wird nichts installiert, gestartet, angepingt oder per SSH abgefragt;
 * kein neuer Port, keine neue Verbindungsart.
 */
import { readFileSync } from 'node:fs'
import type { NodeProfile } from '../core/node-profile.js'

export const STRENGTH_CAPABILITIES = [
    'bilder', 'grosse-modelle', 'llm', 'embedding', 'stt', 'tts', 'vision', 'medien', 'speicher', 'rechnen',
] as const
export type StrengthCapability = typeof STRENGTH_CAPABILITIES[number]
export type RankTarget = StrengthCapability | 'main'

export const STRENGTH_LABELS: Record<RankTarget, string> = {
    bilder: 'Bilder erzeugen',
    'grosse-modelle': 'Große Modelle',
    llm: 'Sprachmodell',
    embedding: 'Embeddings (Gedächtnis)',
    stt: 'Sprache → Text',
    tts: 'Text → Sprache',
    vision: 'Bilder verstehen',
    medien: 'Video/Audio umwandeln',
    speicher: 'Speicher & Sicherungen',
    rechnen: 'Allgemeine Rechenarbeit',
    main: 'Main (Nachfolge)',
}

/** A peer without a signed message for this long is listed but not ranked (same as the Software-Scout). */
export const STRENGTH_STALE_MS = 10 * 60_000
/** A measured success rate counts only from this many validated owner runs (same as the multi-router). */
export const MIN_MEASURED_SAMPLES = 5

export interface StrengthRuntime { name: string; type: string; models: string[]; running: boolean }

export interface StrengthNodeFacts {
    nodeId: string
    /** The node this code runs on (always fresh). */
    local: boolean
    /** Last signed message of the peer (ms). */
    lastSeen?: number
    /** Daemon uptime from the signed heartbeat (ms). */
    uptimeMs?: number
    role?: 'main' | 'worker'
    hardware: {
        cpus: number
        ramGB: number
        gpuName: string | null
        gpuBackend: string
        gpuVramGB?: number
        viaVllm: boolean
        /** GPU shares the system RAM (Apple Silicon, GB10). */
        unifiedMemory?: boolean
        diskTotalGB?: number
        diskFreeGB?: number
    }
    runtimes: StrengthRuntime[]
    tools: string[]
    selfCheck?: 'ok' | 'warn' | 'crit'
    /** NAS: data volume only (models/backups), never system packages. */
    modelOnly?: boolean
}

export interface StrengthMeasurement { nodeId: string; capability: StrengthCapability; samples: number; successes: number }
export interface StrengthFacts { nodes: StrengthNodeFacts[]; measurements: StrengthMeasurement[]; now: number }

export interface RankedNode { nodeId: string; place: number; score: number; reasons: string[] }
export interface NodeRanking {
    fuer: RankTarget
    label: string
    ranked: RankedNode[]
    /** Listed with the reason instead of silently dropped. */
    excluded: Array<{ nodeId: string; reason: string }>
}
export interface RankOptions {
    /** Suitability by hardware only, without requiring a running service (where to install). */
    nurHardware?: boolean
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const EMBED = /embed|nomic|bge|mxbai|e5-|gte-|minilm/i
const lower = (value: unknown) => String(value ?? '').toLowerCase()
const round = (value: number) => Math.round(value)
const gpuUsable = (hw: StrengthNodeFacts['hardware']) => Boolean(hw.gpuName) && ['cuda', 'metal', 'rocm', 'vulkan'].includes(lower(hw.gpuBackend)) || hw.viaVllm

/** Memory a model can actually use: VRAM on a discrete GPU, all RAM when unified, else 80 % RAM. */
export function effectiveModelMemoryGB(hw: StrengthNodeFacts['hardware']): { gb: number; how: string } {
    if (hw.unifiedMemory || (hw.viaVllm && !hw.gpuVramGB)) return { gb: Math.max(0, hw.ramGB), how: 'gemeinsamer Speicher' }
    if (hw.gpuVramGB && lower(hw.gpuBackend) === 'cuda') return { gb: hw.gpuVramGB, how: 'VRAM' }
    return { gb: Math.floor(Math.max(0, hw.ramGB) * 0.8), how: 'RAM' }
}

function running(node: StrengthNodeFacts, match: (runtime: StrengthRuntime) => boolean): StrengthRuntime[] {
    return node.runtimes.filter(runtime => runtime.running && match(runtime))
        .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
}
const isLlm = (runtime: StrengthRuntime) => ['llm', 'vllm', 'ollama', 'lmstudio', 'llamacpp'].includes(lower(runtime.type))
    && runtime.models.some(model => !EMBED.test(model))
const isEmbedding = (runtime: StrengthRuntime) => lower(runtime.type) === 'embeddings' || lower(runtime.type) === 'embedding' || runtime.models.some(model => EMBED.test(model))
const isImage = (runtime: StrengthRuntime) => lower(runtime.type) === 'image' || /comfy|stable.?diffusion|automatic1111|fooocus|invoke/.test(lower(runtime.name))
const isVision = (runtime: StrengthRuntime) => ['vlm', 'vision'].includes(lower(runtime.type)) || runtime.models.some(model => /llava|moondream|-vl\b|vl:|vision/i.test(model))
const describeRuntime = (runtime: StrengthRuntime) => `${runtime.name}${runtime.models.length ? ` (${runtime.models.slice(0, 2).join(', ')}${runtime.models.length > 2 ? ', …' : ''})` : ''}`

interface Assessment { score: number; reasons: string[]; excluded?: string }

function assess(target: RankTarget, node: StrengthNodeFacts, options: RankOptions): Assessment {
    const hw = node.hardware
    const reasons: string[] = []
    let score = 0
    const memory = effectiveModelMemoryGB(hw)
    const gpu = gpuUsable(hw)
    const gpuText = hw.gpuName ? `GPU ${hw.gpuName} (${hw.viaVllm ? 'via vLLM' : hw.gpuBackend})${hw.gpuVramGB ? `, ${hw.gpuVramGB} GB VRAM` : ''}` : ''
    const needService = (found: StrengthRuntime[], what: string): Assessment | null => {
        if (found.length) {
            score += 100 + Math.min(20, found.length * 5)
            reasons.push(`läuft: ${found.map(describeRuntime).join(', ')}`)
            return null
        }
        if (options.nurHardware) { reasons.push(`kein ${what} läuft (Eignung nach Hardware)`); return null }
        return { score: 0, reasons, excluded: `kein ${what} läuft` }
    }
    switch (target) {
        case 'bilder': {
            const image = running(node, isImage)
            if (!image.length && !gpu) return { score: 0, reasons, excluded: 'keine nutzbare GPU und kein Bild-Dienst' }
            if (image.length) { score += 100; reasons.push(`Bild-Dienst läuft: ${image.map(describeRuntime).join(', ')}`) }
            if (gpu) { score += 40 + Math.min(80, memory.gb * 2); reasons.push(gpuText) }
            break
        }
        case 'grosse-modelle': {
            if (memory.gb < 16) return { score: 0, reasons, excluded: `zu wenig nutzbarer Speicher für große Modelle (${memory.gb} GB ${memory.how})` }
            score += memory.gb
            reasons.push(`${memory.gb} GB nutzbarer Speicher (${memory.how})`)
            if (gpu) { score += 20; reasons.push(gpuText) }
            const llm = running(node, isLlm)
            if (llm.length) { score += 20; reasons.push(`Modell läuft: ${llm.map(describeRuntime).join(', ')}`) }
            break
        }
        case 'llm': {
            const excluded = needService(running(node, isLlm), 'Sprachmodell')
            if (excluded) return excluded
            score += Math.min(60, memory.gb / 2)
            reasons.push(`${memory.gb} GB nutzbarer Speicher (${memory.how})`)
            break
        }
        case 'embedding': {
            const excluded = needService(running(node, isEmbedding), 'Embedding-Modell')
            if (excluded) return excluded
            if (gpu) { score += 10; reasons.push(gpuText) }
            break
        }
        case 'stt': case 'tts': {
            const excluded = needService(running(node, runtime => lower(runtime.type) === target || runtime.name.toLowerCase().includes(target === 'stt' ? 'whisper' : 'piper')), target === 'stt' ? 'Spracherkennungs-Dienst' : 'Sprachausgabe-Dienst')
            if (excluded) return excluded
            if (gpu) { score += 20; reasons.push(gpuText) }
            score += Math.min(16, hw.cpus)
            break
        }
        case 'vision': {
            const excluded = needService(running(node, isVision), 'Bildverständnis-Modell')
            if (excluded) return excluded
            if (gpu) { score += 20; reasons.push(gpuText) }
            score += Math.min(40, memory.gb / 2)
            break
        }
        case 'medien': {
            if (!node.tools.includes('ffmpeg') && !options.nurHardware) return { score: 0, reasons, excluded: 'ffmpeg nicht vorhanden' }
            if (node.tools.includes('ffmpeg')) { score += 60; reasons.push('ffmpeg vorhanden') }
            score += Math.min(64, hw.cpus * 2)
            reasons.push(`${hw.cpus} Kerne`)
            if (gpu) { score += 20; reasons.push(gpuText) }
            break
        }
        case 'speicher': {
            if (hw.diskFreeGB === undefined) return { score: 0, reasons, excluded: 'freie Platte nicht gemeldet' }
            score += Math.min(10_000, hw.diskFreeGB) / 10
            reasons.push(`${hw.diskFreeGB} GB frei${hw.diskTotalGB ? ` von ${hw.diskTotalGB} GB` : ''}`)
            if (node.modelOnly) { score += 20; reasons.push('Datenspeicher-Knoten') }
            break
        }
        case 'rechnen': {
            score += Math.min(64, hw.cpus) * 2 + Math.min(256, hw.ramGB) / 4
            reasons.push(`${hw.cpus} Kerne, ${hw.ramGB} GB RAM`)
            if (node.modelOnly) { score -= 40; reasons.push('nur Datenspeicher-Knoten') }
            break
        }
        case 'main': {
            score += Math.min(256, hw.ramGB) / 2 + Math.min(64, hw.cpus)
            reasons.push(`${hw.ramGB} GB RAM, ${hw.cpus} Kerne`)
            const llm = running(node, isLlm)
            if (llm.length) { score += 40; reasons.push(`lokales Modell läuft: ${llm.map(describeRuntime).join(', ')} (denkt ohne Cloud)`) }
            if (hw.diskFreeGB !== undefined) { score += Math.min(30, hw.diskFreeGB / 20); reasons.push(`${hw.diskFreeGB} GB Platte frei`) }
            if (node.uptimeMs !== undefined) {
                const hours = node.uptimeMs / 3_600_000
                score += Math.min(20, hours / 12)
                reasons.push(`läuft seit ${hours >= 48 ? `${round(hours / 24)} Tagen` : `${round(hours)} Std.`}`)
            }
            if (node.role === 'main') { score += 5; reasons.push('ist derzeit Main') }
            if (node.selfCheck === 'warn') { score -= 10; reasons.push('Selbstprüfung mit Warnung') }
            if (node.modelOnly) { score -= 100; reasons.push('nur Datenspeicher-Knoten (keine Systempakete)') }
            break
        }
        default:
            throw new Error(`Unbekannte Fähigkeit: ${String(target)}`)
    }
    return { score, reasons }
}

/**
 * Wer kann `fuer` am besten? Rein und deterministisch: gleiche Fakten → gleiche
 * Rangliste; Gleichstand nach Knoten-ID. Veraltete oder kritische Knoten und
 * Knoten ohne Voraussetzung stehen mit Grund unter `excluded`.
 */
export function rankNodes(fuer: RankTarget, facts: StrengthFacts, options: RankOptions = {}): NodeRanking {
    if (!(STRENGTH_CAPABILITIES as readonly string[]).includes(fuer) && fuer !== 'main') throw new Error(`Unbekannte Fähigkeit: ${String(fuer)}`)
    const measured = new Map(facts.measurements
        .filter(item => item.capability === (fuer === 'main' ? '' : fuer))
        .map(item => [item.nodeId, item]))
    const scored: Array<{ nodeId: string; score: number; reasons: string[] }> = []
    const excluded: NodeRanking['excluded'] = []
    const nodes = [...facts.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    const seen = new Set<string>()
    for (const node of nodes) {
        if (!node.nodeId || seen.has(node.nodeId)) continue
        seen.add(node.nodeId)
        if (!node.local && !(typeof node.lastSeen === 'number' && facts.now - node.lastSeen <= STRENGTH_STALE_MS)) {
            excluded.push({ nodeId: node.nodeId, reason: node.lastSeen ? `veraltet (zuletzt vor ${round((facts.now - node.lastSeen) / 60_000)} min gemeldet)` : 'veraltet (nie signiert gemeldet)' })
            continue
        }
        if (node.selfCheck === 'crit') { excluded.push({ nodeId: node.nodeId, reason: 'Selbstprüfung kritisch' }); continue }
        const result = assess(fuer, node, options)
        if (result.excluded) { excluded.push({ nodeId: node.nodeId, reason: result.excluded }); continue }
        let score = result.score
        const measurement = measured.get(node.nodeId)
        if (measurement && measurement.samples >= MIN_MEASURED_SAMPLES) {
            const rate = measurement.successes / measurement.samples
            score += (rate - 0.5) * 160
            result.reasons.push(`gemessen: ${measurement.successes} von ${measurement.samples} validierten Owner-Läufen erfolgreich`)
        }
        if (node.local) result.reasons.push('dieser Knoten')
        scored.push({ nodeId: node.nodeId, score: Math.round(score * 10) / 10, reasons: result.reasons })
    }
    scored.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
    return {
        fuer, label: STRENGTH_LABELS[fuer],
        ranked: scored.map((item, index) => ({ nodeId: item.nodeId, place: index + 1, score: item.score, reasons: item.reasons })),
        excluded,
    }
}

/** One-line reason for the ledger/prompt: "Bilder erzeugen → knoten-a: GPU …; läuft: comfyui". */
export function rankingReason(ranking: NodeRanking): string {
    const best = ranking.ranked[0]
    if (!best) return `${ranking.label}: kein geeigneter Knoten (${ranking.excluded.map(item => `${item.nodeId}: ${item.reason}`).join('; ') || 'keine Knoten bekannt'})`
    const second = ranking.ranked[1]
    return `${ranking.label} → ${best.nodeId}: ${best.reasons.join('; ')}${second ? ` (danach ${second.nodeId})` : ''}`
}

// ---------------------------------------------------------------------------
// Measurements: validated owner runs only (the one rule, ownerKernelRun)
// ---------------------------------------------------------------------------

interface RunLike {
    status?: string; userId?: string; channel?: string; runId?: string; node?: string; invalidated?: boolean
    contract?: { id?: string }; validation?: { validator?: string; success?: boolean; awaitingApproval?: boolean }
    events?: Array<{ type?: string; payload?: Record<string, unknown> }>
}

/** Mirror of `ownerKernelRun` (core/validator-failure-escalation.ts) kept import-free for the pure module. */
function ownerRun(run: RunLike): boolean {
    return !run.invalidated && Boolean(run.userId) && run.userId !== 'Nova-Autonomy'
        && Boolean(run.channel) && run.channel !== 'internal' && run.channel !== 'benchmark'
        && run.contract?.id === run.runId
        && run.validation?.validator === 'nova-execution-kernel' && !run.validation.awaitingApproval
        && (run.status === 'completed' || run.status === 'failed')
}

export function measurementsFromOwnerRuns(runs: readonly RunLike[]): StrengthMeasurement[] {
    const cells = new Map<string, StrengthMeasurement>()
    const count = (nodeId: string, capability: StrengthCapability, success: boolean) => {
        const key = `${nodeId}\u0000${capability}`
        const cell = cells.get(key) || { nodeId, capability, samples: 0, successes: 0 }
        cell.samples++
        if (success) cell.successes++
        cells.set(key, cell)
    }
    for (const run of runs) {
        if (!run || !ownerRun(run)) continue
        const success = run.status === 'completed' && run.validation?.success === true
        const routes = (run.events || []).filter(event => event?.type === 'route.selected').map(event => event.payload || {})
        const delegated = new Set<string>()
        for (const route of routes) {
            const capability = String(route.meshCapability || '') as StrengthCapability
            const nodeId = String(route.meshNode || '')
            if (nodeId && (STRENGTH_CAPABILITIES as readonly string[]).includes(capability) && !delegated.has(`${nodeId}|${capability}`)) {
                delegated.add(`${nodeId}|${capability}`)
                count(nodeId, capability, success)
            }
        }
        if (run.node) {
            const modelClass = String(routes.find(route => route.modelClass)?.modelClass || '')
            if (modelClass) count(run.node, modelClass === 'vision' ? 'vision' : 'llm', success)
        }
    }
    return [...cells.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.capability.localeCompare(b.capability))
}

// ---------------------------------------------------------------------------
// Change detection (new hardware/software), shown on the Main's map
// ---------------------------------------------------------------------------

type ProfileFacts = Pick<NodeProfile, 'ramGB' | 'gpu' | 'tools'> & Partial<Pick<NodeProfile, 'services' | 'disk' | 'cpus'>>

export function describeStrengthChanges(previous: ProfileFacts | undefined, next: ProfileFacts): string[] {
    if (!previous) return []
    const out: string[] = []
    if ((next.gpu?.name || null) !== (previous.gpu?.name || null)) out.push(next.gpu?.name ? `neue GPU: ${next.gpu.name} (${next.gpu.backend})` : `GPU ${previous.gpu?.name} nicht mehr gemeldet`)
    else if (next.gpu?.backend !== previous.gpu?.backend) out.push(`GPU-Nutzung ${previous.gpu?.backend} → ${next.gpu?.backend}`)
    if (next.ramGB !== previous.ramGB) out.push(`RAM ${previous.ramGB} → ${next.ramGB} GB`)
    if (next.cpus !== undefined && previous.cpus !== undefined && next.cpus !== previous.cpus) out.push(`Kerne ${previous.cpus} → ${next.cpus}`)
    const serviceKey = (service: { name: string; type: string; status: string }) => `${service.name}|${service.type}|${service.status}`
    const before = new Set((previous.services || []).map(serviceKey))
    const after = new Set((next.services || []).map(serviceKey))
    for (const service of next.services || []) if (!before.has(serviceKey(service))) out.push(`neuer Dienst: ${service.name} (${service.type}, ${service.status})`)
    for (const service of previous.services || []) if (!after.has(serviceKey(service))) out.push(`Dienst weg: ${service.name} (${service.type}, ${service.status})`)
    const tools = new Set(previous.tools || [])
    for (const tool of next.tools || []) if (!tools.has(tool)) out.push(`neues Werkzeug: ${tool}`)
    const nextTools = new Set(next.tools || [])
    for (const tool of previous.tools || []) if (!nextTools.has(tool)) out.push(`Werkzeug weg: ${tool}`)
    if (next.disk?.totalGB !== undefined && previous.disk?.totalGB !== undefined && next.disk.totalGB !== previous.disk.totalGB) out.push(`Platte ${previous.disk.totalGB} → ${next.disk.totalGB} GB`)
    return out
}

export interface StrengthChange { at: string; nodeId: string; changes: string[] }
const MAX_CHANGES = 50

/** Bounded change list next to the peer state (written where the signed profile arrives). */
export async function recordStrengthChanges(nodeId: string, previous: ProfileFacts | undefined, next: ProfileFacts, now = new Date()): Promise<StrengthChange | null> {
    const changes = describeStrengthChanges(previous, next)
    if (!changes.length) return null
    const entry: StrengthChange = { at: now.toISOString(), nodeId: String(nodeId).slice(0, 80), changes: changes.slice(0, 12).map(item => item.slice(0, 160)) }
    try {
        const { join } = await import('node:path')
        const { getNovaDataDir } = await import('../core/data-root.js')
        const { atomicWriteJsonSync } = await import('../core/atomic-storage.js')
        const file = join(getNovaDataDir(), 'mesh-strength-changes.json')
        const list = [entry, ...listStrengthChangesFrom(file)].slice(0, MAX_CHANGES)
        atomicWriteJsonSync(file, { version: 1, changes: list } as unknown as Record<string, unknown>)
    } catch { /* the map still works without the history */ }
    return entry
}

function listStrengthChangesFrom(file: string): StrengthChange[] {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { changes?: StrengthChange[] }
        return Array.isArray(parsed.changes) ? parsed.changes.slice(0, MAX_CHANGES) : []
    } catch { return [] }
}

export async function listStrengthChanges(): Promise<StrengthChange[]> {
    const { join } = await import('node:path')
    const { getNovaDataDir } = await import('../core/data-root.js')
    return listStrengthChangesFrom(join(getNovaDataDir(), 'mesh-strength-changes.json'))
}

// ---------------------------------------------------------------------------
// Production facts: signed profiles + Capability-Graph + Outcome-Ledger
// ---------------------------------------------------------------------------

interface GraphNodeLike {
    id: string
    hostname?: string
    hardware?: { ram_gb?: number; cores?: number; gpu?: string; gpu_vram_mb?: number; disk_gb?: number; disk_free_gb?: number }
    runtimes?: Array<{ name: string; type: string; models: string[]; available?: boolean; status?: string }>
}
interface ScoutNodeLike { nodeId: string; profile: NodeProfile; local: boolean; lastSeen?: number; modelOnly?: boolean }

/** Pure merge of the three sources; exported for tests. */
export function strengthFactsFrom(input: {
    scoutNodes: readonly ScoutNodeLike[]
    graphNodes: readonly GraphNodeLike[]
    uptimeMs?: Record<string, number | undefined>
    measurements: StrengthMeasurement[]
    now: number
}): StrengthFacts {
    const graph = new Map(input.graphNodes.map(node => [node.id, node]))
    const nodes: StrengthNodeFacts[] = input.scoutNodes.map(scout => {
        const profile = scout.profile
        const graphNode = graph.get(scout.nodeId)
        const graphRuntimes = (graphNode?.runtimes || []).map(runtime => ({
            name: String(runtime.name || runtime.type), type: String(runtime.type || ''), models: (runtime.models || []).map(String),
            running: runtime.available === true,
        }))
        // Profile services name a running service without models; keep them when the graph has no entry.
        const profileRuntimes = (profile.services || [])
            .filter(service => !graphRuntimes.some(runtime => lower(runtime.name) === lower(service.name)))
            .map(service => ({ name: service.name, type: service.type, models: [], running: service.status === 'running' }))
        const vramMb = Number(graphNode?.hardware?.gpu_vram_mb || 0)
        const diskTotal = profile.disk?.totalGB ?? (Number.isFinite(Number(graphNode?.hardware?.disk_gb)) ? Number(graphNode?.hardware?.disk_gb) : undefined)
        const diskFree = profile.disk?.freeGB ?? (Number.isFinite(Number(graphNode?.hardware?.disk_free_gb)) ? Number(graphNode?.hardware?.disk_free_gb) : undefined)
        return {
            nodeId: scout.nodeId,
            local: scout.local,
            lastSeen: scout.local ? input.now : scout.lastSeen,
            uptimeMs: input.uptimeMs?.[scout.nodeId],
            role: profile.role,
            hardware: {
                cpus: profile.cpus, ramGB: profile.ramGB, gpuName: profile.gpu?.name ?? null, gpuBackend: profile.gpu?.backend || 'cpu',
                viaVllm: profile.gpu?.viaVllm === true,
                ...(vramMb > 0 ? { gpuVramGB: Math.round(vramMb / 1024) } : {}),
                ...(profile.gpu?.backend === 'metal' || (profile.gpu?.viaVllm && !vramMb) ? { unifiedMemory: true } : {}),
                ...(diskTotal !== undefined ? { diskTotalGB: Math.round(diskTotal) } : {}),
                ...(diskFree !== undefined ? { diskFreeGB: Math.round(diskFree) } : {}),
            },
            runtimes: [...graphRuntimes, ...profileRuntimes],
            tools: [...(profile.tools || [])],
            selfCheck: profile.selfCheck?.status,
            ...(scout.modelOnly ? { modelOnly: true } : {}),
        }
    })
    return { nodes, measurements: input.measurements, now: input.now }
}

/** Live facts on this node (the Main holds every peer's signed profile). Read-only, no network. */
export async function collectStrengthFacts(now = Date.now()): Promise<StrengthFacts> {
    const { collectScoutNodes } = await import('../install/software-scout.js')
    const scoutNodes = await collectScoutNodes().catch(() => [])
    let graphNodes: GraphNodeLike[] = []
    try {
        const { getCapabilityGraph, capabilityRuntimeAvailable } = await import('./capability-graph.js')
        const snapshot = getCapabilityGraph().getSnapshot()
        graphNodes = snapshot.nodes.map(node => ({
            id: node.id, hostname: node.hostname, hardware: node.hardware as GraphNodeLike['hardware'],
            runtimes: node.runtimes.map(runtime => ({ ...runtime, available: capabilityRuntimeAvailable(node, runtime, now) })),
        }))
    } catch { /* graph optional */ }
    const uptimeMs: Record<string, number | undefined> = {}
    try {
        const { getMeshPeerStates } = await import('./mesh-transport-runtime.js')
        for (const [nodeId, state] of Object.entries(getMeshPeerStates())) uptimeMs[nodeId] = state.uptimeMs
        const { getLocalNodeId } = await import('./mesh-registry.js')
        uptimeMs[getLocalNodeId()] = Math.round(process.uptime() * 1000)
    } catch { /* uptime optional */ }
    let measurements: StrengthMeasurement[] = []
    try {
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        measurements = measurementsFromOwnerRuns(getOutcomeLedger().listRuns(500) as unknown as RunLike[])
    } catch { /* ledger optional */ }
    return strengthFactsFrom({ scoutNodes, graphNodes, uptimeMs, measurements, now })
}

/** Convenience for callers without own facts: live facts, then the ranking. */
export async function rankNodesLive(fuer: RankTarget, options: RankOptions = {}): Promise<NodeRanking> {
    return rankNodes(fuer, await collectStrengthFacts(), options)
}

/** "Wer kann was am besten" as text (prompt block, /mesh route, tool). */
export function formatStrengthMap(facts: StrengthFacts, targets: readonly RankTarget[] = [...STRENGTH_CAPABILITIES, 'main']): string {
    const lines = ['## Wer kann was am besten (gemessene Fakten, signierte Knotenprofile)']
    for (const target of targets) {
        const ranking = rankNodes(target, facts)
        const top = ranking.ranked.slice(0, 3).map(item => `${item.place}. ${item.nodeId} (${item.reasons.slice(0, 2).join('; ')})`).join(' · ')
        lines.push(`- ${ranking.label}: ${top || 'kein geeigneter Knoten'}`)
    }
    lines.push('Delegation nur über den signierten Mesh-Weg: spawn_subagent mit mesh_node="auto" (oder Knoten-ID) und faehigkeit.')
    return lines.join('\n')
}
