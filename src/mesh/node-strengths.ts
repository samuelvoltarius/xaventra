/**
 * Mesh-Gehirn (2.88): DAS eine Modul für „was kann welcher Knoten, und wer
 * macht diese Aufgabe am besten?“.
 *
 * Das Stärkenprofil eines Knotens entsteht automatisch, ohne Config-Eintrag,
 * nur aus dem, was ohnehin gemeldet wird:
 *  - signiertes Knotenprofil (node.capabilities): Kerne, RAM, GPU/VRAM, Dienste, Werkzeuge,
 *  - Capability-Graph: laufende Laufzeiten mit ihren geladenen Modellen, VRAM/Platte,
 *  - signierter Herzschlag: Live-Last (CPU, RAM frei, GPU-Auslastung, Platte frei),
 *  - gemessene Umlaufzeit des Herzschlags (Latenz) und Alter der letzten Meldung.
 *
 * `rankNodes` ist rein und deterministisch (Gleichstand → Knoten-ID). Jede
 * Entscheidung trägt einen kurzen, menschlichen Grund („gpu-box: GPU frei,
 * Modell geladen“). Hier wird nichts installiert, gestartet, angepingt oder
 * per SSH abgefragt; keine neue Verbindung.
 */
import type { NodeLiveLoad, NodeProfile } from '../core/node-profile.js'

export const SKILLS = [
    'grosse-modelle', 'llm', 'code', 'embedding', 'bilder', 'vision', 'stt', 'tts', 'medien', 'speicher', 'rechnen',
] as const
export type Skill = typeof SKILLS[number]

export const SKILL_LABELS: Record<Skill, string> = {
    'grosse-modelle': 'große Modelle',
    llm: 'Sprachmodell',
    code: 'Programmieren',
    embedding: 'Gedächtnis-Suche',
    bilder: 'Bilder erzeugen',
    vision: 'Bilder verstehen',
    stt: 'Sprache → Text',
    tts: 'Text → Sprache',
    medien: 'Video/Audio umwandeln',
    speicher: 'Speicher',
    rechnen: 'Rechenarbeit',
}

/** Without a signed heartbeat for this long a peer counts as offline (heartbeat every 30 s). */
export const ONLINE_WINDOW_MS = 3 * 60_000

export interface StrengthService { name: string; type: string; models: string[]; running: boolean }

/** The per-node strength profile ("Stärkenprofil"). */
export interface NodeStrength {
    nodeId: string
    local: boolean
    online: boolean
    lastSeen?: number
    rttMs?: number
    role?: 'main' | 'worker'
    cpus: number
    ramGB: number
    gpu: { name: string | null; backend: string; vramGB?: number; unified: boolean; viaVllm: boolean; utilPercent?: number }
    /** Memory a model can actually use (VRAM, unified RAM, or 80 % RAM on CPU). */
    modelMemoryGB: number
    modelMemoryHow: 'VRAM' | 'gemeinsamer Speicher' | 'RAM'
    diskFreeGB?: number
    cpuPerCore?: number
    memFreePercent?: number
    services: StrengthService[]
    tools: string[]
    selfCheck?: 'ok' | 'warn' | 'crit'
    /** NAS-like node: data volume only. */
    modelOnly?: boolean
    /** Skills this node can do right now (derived). */
    skills: Skill[]
}

// ---------------------------------------------------------------------------
// Deriving the profile (pure)
// ---------------------------------------------------------------------------

const lower = (value: unknown) => String(value ?? '').toLowerCase()
const EMBED = /embed|nomic|bge|mxbai|e5-|gte-|minilm/i
const VISION_MODEL = /llava|moondream|-vl\b|vl:|vl-|vision/i
const CODE_MODEL = /coder|devstral|starcoder|codestral|codellama/i
const UNIFIED_GPU = /\b(GB10|GB200|GH200|Grace|Thor|Orin|Jetson|Apple)\b/i
const LLM_TYPES = new Set(['llm', 'vllm', 'ollama', 'lmstudio', 'llamacpp', 'llama-cpp', 'vlm'])

export interface GraphRuntimeLike { name: string; type: string; models?: string[]; available?: boolean }
export interface GraphHardwareLike { gpu_vram_mb?: number; disk_free_gb?: number }

export interface StrengthInput {
    nodeId: string
    profile: NodeProfile
    local: boolean
    lastSeen?: number
    load?: NodeLiveLoad
    rttMs?: number
    graphRuntimes?: GraphRuntimeLike[]
    graphHardware?: GraphHardwareLike
    modelOnly?: boolean
}

export function deriveStrength(input: StrengthInput, now = Date.now()): NodeStrength {
    const profile = input.profile
    const gpuName = profile.gpu?.name ?? null
    const backend = lower(profile.gpu?.backend || 'cpu')
    const viaVllm = profile.gpu?.viaVllm === true
    const graphVram = Number(input.graphHardware?.gpu_vram_mb || 0)
    const vramGB = profile.gpu?.vramGB || (graphVram > 0 ? Math.round(graphVram / 1024) : undefined)
    const unified = backend === 'metal' || (Boolean(gpuName) && UNIFIED_GPU.test(String(gpuName)) && !vramGB) || (viaVllm && !vramGB)
    const ramGB = Math.max(0, Number(profile.ramGB) || 0)
    const memory: Pick<NodeStrength, 'modelMemoryGB' | 'modelMemoryHow'> = unified
        ? { modelMemoryGB: ramGB, modelMemoryHow: 'gemeinsamer Speicher' }
        : vramGB && (backend === 'cuda' || /nvidia/i.test(String(gpuName)))
            ? { modelMemoryGB: vramGB, modelMemoryHow: 'VRAM' }
            : { modelMemoryGB: Math.floor(ramGB * 0.8), modelMemoryHow: 'RAM' }

    const graphServices: StrengthService[] = (input.graphRuntimes || []).map(runtime => ({
        name: String(runtime.name || runtime.type || '').slice(0, 40), type: lower(runtime.type), models: (runtime.models || []).map(String).slice(0, 20),
        running: runtime.available === true,
    }))
    // Profile services name a service without models; keep those the graph does not already list.
    const profileServices: StrengthService[] = (profile.services || [])
        .filter(service => !graphServices.some(item => lower(item.name) === lower(service.name)))
        .map(service => ({ name: service.name, type: lower(service.type), models: [], running: service.status === 'running' }))
    const services = [...graphServices, ...profileServices].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))

    const graphDisk = input.graphHardware?.disk_free_gb
    const diskFree = input.load?.diskFreeGB ?? (graphDisk !== undefined && Number.isFinite(Number(graphDisk)) ? Number(graphDisk) : undefined)
    const online = input.local || (typeof input.lastSeen === 'number' && now - input.lastSeen <= ONLINE_WINDOW_MS)
    const node: NodeStrength = {
        nodeId: input.nodeId,
        local: input.local,
        online,
        ...(input.local ? {} : { lastSeen: input.lastSeen }),
        ...(input.rttMs !== undefined && !input.local ? { rttMs: Math.round(input.rttMs) } : {}),
        role: profile.role,
        cpus: Math.max(0, Number(profile.cpus) || 0),
        ramGB,
        gpu: {
            name: gpuName, backend, unified, viaVllm,
            ...(vramGB ? { vramGB } : {}),
            ...(input.load?.gpuUtilPercent !== undefined ? { utilPercent: input.load.gpuUtilPercent } : {}),
        },
        ...memory,
        ...(diskFree !== undefined ? { diskFreeGB: Math.round(diskFree) } : {}),
        ...(input.load?.cpuPerCore !== undefined ? { cpuPerCore: input.load.cpuPerCore } : {}),
        ...(input.load?.memFreePercent !== undefined ? { memFreePercent: input.load.memFreePercent } : {}),
        services,
        tools: [...(profile.tools || [])].map(String).sort(),
        selfCheck: profile.selfCheck?.status,
        ...(input.modelOnly ? { modelOnly: true } : {}),
        skills: [],
    }
    node.skills = SKILLS.filter(skill => !assess(skill, node, {}).excluded)
    return node
}

// ---------------------------------------------------------------------------
// Assessment per skill (pure)
// ---------------------------------------------------------------------------

const running = (node: NodeStrength, match: (service: StrengthService) => boolean) => node.services.filter(service => service.running && match(service))
const isLlm = (service: StrengthService) => (LLM_TYPES.has(service.type) || /ollama|vllm|llama|lm.?studio/.test(lower(service.name)))
    && !(service.models.length && service.models.every(model => EMBED.test(model)))
const isEmbedding = (service: StrengthService) => ['embeddings', 'embedding'].includes(service.type) || service.models.some(model => EMBED.test(model))
const isImage = (service: StrengthService) => service.type === 'image' || /comfy|stable.?diffusion|automatic1111|fooocus|invoke/.test(lower(service.name))
const isVision = (service: StrengthService) => ['vlm', 'vision'].includes(service.type) || service.models.some(model => VISION_MODEL.test(model))
const gpuUsable = (node: NodeStrength) => Boolean(node.gpu.name) && (['cuda', 'metal', 'rocm', 'vulkan'].includes(node.gpu.backend) || node.gpu.viaVllm)

/** "GPU frei" / "GPU halb belegt" / "GPU ausgelastet" / "GPU <name>". */
export function gpuPhrase(node: NodeStrength): string {
    const util = node.gpu.utilPercent
    if (util === undefined) return node.gpu.name ? `GPU ${node.gpu.name}` : 'keine GPU'
    return util < 30 ? 'GPU frei' : util < 75 ? 'GPU halb belegt' : 'GPU ausgelastet'
}

function modelPhrase(found: StrengthService[]): string {
    const models = [...new Set(found.flatMap(service => service.models.filter(model => !EMBED.test(model))))]
    if (models.length === 1) return `Modell ${models[0]} geladen`
    if (models.length > 1) return `${models.length} Modelle geladen`
    return `${found[0]?.name || 'Dienst'} läuft`
}

interface Assessment { score: number; reasons: string[]; excluded?: string }
export interface RankOptions {
    /** Suitability by hardware only, without a running service (where something could go). */
    hardwareOnly?: boolean
}

function loadPenalty(node: NodeStrength, usesGpu: boolean): { penalty: number; reason?: string } {
    let penalty = 0
    let reason: string | undefined
    if (node.cpuPerCore !== undefined && node.cpuPerCore > 1.5) { penalty += Math.min(40, (node.cpuPerCore - 1.5) * 20); reason = 'stark beschäftigt' }
    if (usesGpu && node.gpu.utilPercent !== undefined && node.gpu.utilPercent >= 75) { penalty += 30; reason = 'GPU ausgelastet' }
    if (node.memFreePercent !== undefined && node.memFreePercent < 10) { penalty += 20; reason = reason || 'wenig RAM frei' }
    return { penalty, reason }
}

function assess(skill: Skill, node: NodeStrength, options: RankOptions): Assessment {
    const reasons: string[] = []
    let score = 0
    const gpu = gpuUsable(node)
    const needService = (found: StrengthService[], what: string): Assessment | null => {
        if (found.length) { score += 100 + Math.min(20, found.length * 5); reasons.push(modelPhrase(found)); return null }
        if (options.hardwareOnly) return null
        return { score: 0, reasons, excluded: `kein ${what} läuft` }
    }
    switch (skill) {
        case 'grosse-modelle': {
            if (node.modelMemoryGB < 24) return { score: 0, reasons, excluded: `zu wenig Speicher für große Modelle (${node.modelMemoryGB} GB ${node.modelMemoryHow})` }
            score += Math.min(200, node.modelMemoryGB)
            if (gpu) { score += 30; reasons.push(gpuPhrase(node)) }
            reasons.push(`${node.modelMemoryGB} GB ${node.modelMemoryHow}`)
            const llm = running(node, isLlm)
            if (llm.length) { score += 40; reasons.splice(gpu ? 1 : 0, 0, modelPhrase(llm)) }
            break
        }
        case 'llm': {
            const excluded = needService(running(node, isLlm), 'Sprachmodell')
            if (excluded) return excluded
            if (gpu) { score += 30; reasons.unshift(gpuPhrase(node)) }
            score += Math.min(60, node.modelMemoryGB / 2)
            break
        }
        case 'code': {
            if (!node.tools.includes('git') && !options.hardwareOnly) return { score: 0, reasons, excluded: 'git fehlt' }
            const llm = running(node, isLlm)
            const coder = llm.filter(service => service.models.some(model => CODE_MODEL.test(model)))
            if (coder.length) { score += 80; reasons.push(modelPhrase(coder)) } else if (llm.length) { score += 40; reasons.push(modelPhrase(llm)) }
            score += Math.min(64, node.cpus) + Math.min(64, node.ramGB / 4)
            reasons.push(`${node.cpus} Kerne`)
            if (node.modelOnly) { score -= 60; reasons.push('nur Datenspeicher') }
            break
        }
        case 'embedding': {
            const excluded = needService(running(node, isEmbedding), 'Embedding-Modell')
            if (excluded) return excluded
            if (gpu) { score += 10; reasons.push(gpuPhrase(node)) }
            break
        }
        case 'bilder': {
            const image = running(node, isImage)
            if (!image.length && !gpu) return { score: 0, reasons, excluded: 'keine GPU und kein Bild-Dienst' }
            if (!image.length && !options.hardwareOnly) return { score: 0, reasons, excluded: 'kein Bild-Dienst läuft' }
            if (gpu) { score += 40 + Math.min(80, node.modelMemoryGB * 2); reasons.push(gpuPhrase(node)) }
            if (image.length) { score += 100; reasons.push(`${image[0].name} läuft`) }
            break
        }
        case 'vision': {
            const excluded = needService(running(node, isVision), 'Bildverständnis-Modell')
            if (excluded) return excluded
            if (gpu) { score += 20; reasons.unshift(gpuPhrase(node)) }
            score += Math.min(40, node.modelMemoryGB / 2)
            break
        }
        case 'stt': case 'tts': {
            const word = skill === 'stt' ? /whisper|stt|parakeet/ : /piper|tts|kokoro|xtts/
            const excluded = needService(running(node, service => service.type === skill || word.test(lower(service.name))), skill === 'stt' ? 'Spracherkennungs-Dienst' : 'Sprachausgabe-Dienst')
            if (excluded) return excluded
            if (gpu) { score += 20; reasons.push(gpuPhrase(node)) }
            score += Math.min(16, node.cpus)
            break
        }
        case 'medien': {
            if (!node.tools.includes('ffmpeg') && !options.hardwareOnly) return { score: 0, reasons, excluded: 'ffmpeg fehlt' }
            score += 60 + Math.min(64, node.cpus * 2)
            reasons.push(`ffmpeg, ${node.cpus} Kerne`)
            if (gpu) { score += 20; reasons.push(gpuPhrase(node)) }
            break
        }
        case 'speicher': {
            if (node.diskFreeGB === undefined) return { score: 0, reasons, excluded: 'freie Platte nicht gemeldet' }
            if (node.diskFreeGB < 20) return { score: 0, reasons, excluded: `nur ${node.diskFreeGB} GB frei` }
            score += Math.min(1000, node.diskFreeGB / 10)
            reasons.push(`${formatGB(node.diskFreeGB)} frei`)
            if (node.modelOnly) { score += 20; reasons.push('Datenspeicher') }
            break
        }
        case 'rechnen': {
            score += Math.min(64, node.cpus) * 2 + Math.min(256, node.ramGB) / 4
            reasons.push(`${node.cpus} Kerne, ${node.ramGB} GB RAM`)
            if (node.modelOnly) { score -= 40; reasons.push('nur Datenspeicher') }
            break
        }
        default:
            throw new Error(`Unbekannte Fähigkeit: ${String(skill)}`)
    }
    const usesGpu = ['grosse-modelle', 'llm', 'bilder', 'vision', 'embedding'].includes(skill)
    const load = loadPenalty(node, usesGpu)
    if (load.penalty) { score -= load.penalty; if (load.reason && !reasons.includes(load.reason)) reasons.push(load.reason) }
    return { score, reasons }
}

export const formatGB = (gb: number) => gb >= 1000 ? `${Math.round(gb / 100) / 10} TB` : `${Math.round(gb)} GB`

// ---------------------------------------------------------------------------
// Ranking (pure, deterministic)
// ---------------------------------------------------------------------------

export interface RankedNode { nodeId: string; place: number; score: number; reasons: string[]; local: boolean }
export interface NodeRanking {
    skill: Skill
    label: string
    ranked: RankedNode[]
    /** Listed with the reason instead of silently dropped. */
    excluded: Array<{ nodeId: string; reason: string }>
}

function reachability(node: NodeStrength): { score: number; reason?: string } {
    if (node.local) return { score: 15, reason: 'läuft hier' }
    if (node.rttMs === undefined) return { score: 0 }
    if (node.rttMs < 20) return { score: 10, reason: 'schnell erreichbar' }
    if (node.rttMs < 100) return { score: 5 }
    return { score: -10, reason: `langsam erreichbar (${node.rttMs} ms)` }
}

export function rankNodes(skill: Skill, nodes: readonly NodeStrength[], options: RankOptions = {}): NodeRanking {
    if (!(SKILLS as readonly string[]).includes(skill)) throw new Error(`Unbekannte Fähigkeit: ${String(skill)}`)
    const scored: RankedNode[] = []
    const excluded: NodeRanking['excluded'] = []
    const seen = new Set<string>()
    for (const node of [...nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
        if (!node.nodeId || seen.has(node.nodeId)) continue
        seen.add(node.nodeId)
        if (!node.online) { excluded.push({ nodeId: node.nodeId, reason: 'offline' }); continue }
        if (node.selfCheck === 'crit') { excluded.push({ nodeId: node.nodeId, reason: 'Selbstprüfung kritisch' }); continue }
        const result = assess(skill, node, options)
        if (result.excluded) { excluded.push({ nodeId: node.nodeId, reason: result.excluded }); continue }
        const reach = reachability(node)
        const reasons = [...result.reasons]
        if (reach.reason) reasons.push(reach.reason)
        scored.push({ nodeId: node.nodeId, place: 0, score: Math.round((result.score + reach.score) * 10) / 10, reasons, local: node.local })
    }
    scored.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
    scored.forEach((item, index) => { item.place = index + 1 })
    return { skill, label: SKILL_LABELS[skill], ranked: scored, excluded }
}

/** Short human reason for a routing decision: "gpu-box: GPU frei, Modell qwen3 geladen". */
export function shortReason(ranking: NodeRanking): string {
    const best = ranking.ranked[0]
    if (!best) return `Für ${ranking.label} passt gerade kein Knoten${ranking.excluded.length ? ` (${ranking.excluded.slice(0, 3).map(item => `${item.nodeId}: ${item.reason}`).join('; ')})` : ''}.`
    return `${best.nodeId}: ${best.reasons.slice(0, 3).join(', ') || SKILL_LABELS[ranking.skill]}`
}

// ---------------------------------------------------------------------------
// Which skill does a task need? (cheap, no LLM)
// ---------------------------------------------------------------------------

const TASK_PATTERNS: Array<[Skill, RegExp]> = [
    ['bilder', /\b(erzeug|generier|mal|zeichne|create|generate|draw)\w*\b.*\b(bild|bilder|foto|grafik|logo|poster|image|picture)|\b(bild|bilder|grafik|logo|poster|image)\b.*\b(erzeug|generier|mal|zeichne|create|generate|draw)|comfyui|stable.?diffusion/i],
    ['vision', /was ist auf (dem|diesem) (bild|foto)|beschreib\w* (das|dieses) (bild|foto)|\bbild\w*\b.*\b(analys|erkenn)|image.*(analy|describe)|\bocr\b|texterkennung/i],
    ['stt', /transkri|diktat|sprachnachricht|speech.?to.?text|whisper|untertitel/i],
    ['tts', /\b(vorlesen|sprachausgabe|text.?to.?speech|tts|vertonen)\b/i],
    ['medien', /konvertier|umwandeln|transcod|ffmpeg|video\w*\b.*\b(schneid|komprimier)|audio\w*\b.*\b(extrahier|extract)|\b(mp4|mkv|wav)\b/i],
    ['embedding', /embedding|einbetten|vektorisier|rag.?index|indexier/i],
    ['code', /programmier|\bcode\b|refactor|kompilier|\bbuild\b|\btests?\b.*\b(laufen|ausführ|fix)|\brepo(sitory)?\b|\bgit\b|bugfix|implementier/i],
    ['grosse-modelle', /gro(ß|ss)es? modell|\b(70b|72b)\b|large model|lange[rn]? kontext|long.?context/i],
    ['speicher', /\b(sichern|sicherung|backup|archivier|ablegen)\b|speicherplatz/i],
    ['llm', /lokal(es|en)? (modell|llm)|\bollama\b|\bvllm\b|local (model|llm)|\binferen(ce|z)\b/i],
    ['rechnen', /berechn|rechenintensiv|simulation|\bbatch\b|massenhaft|viele dateien/i],
]

export function skillForTask(text: string): Skill | null {
    const value = String(text || '').slice(0, 2000)
    for (const [skill, pattern] of TASK_PATTERNS) if (pattern.test(value)) return skill
    return null
}

// ---------------------------------------------------------------------------
// Owner answer: "Was kann welcher Knoten?" — one short list
// ---------------------------------------------------------------------------

function nodeFacts(node: NodeStrength): string {
    const parts: string[] = []
    if (node.gpu.name) parts.push(node.gpu.utilPercent !== undefined ? `${gpuPhrase(node)} (${node.modelMemoryGB} GB)` : `GPU, ${node.modelMemoryGB} GB`)
    else parts.push(`${node.cpus} Kerne, ${node.ramGB} GB RAM`)
    const models = [...new Set(node.services.filter(service => service.running).flatMap(service => service.models.filter(model => !EMBED.test(model))))]
    if (models.length) parts.push(models.length === 1 ? `Modell ${models[0]} geladen` : `${models.length} Modelle geladen`)
    if (node.diskFreeGB !== undefined) parts.push(`${formatGB(node.diskFreeGB)} frei`)
    return parts.join(', ')
}

export function formatStrengthList(nodes: readonly NodeStrength[], now = Date.now()): string {
    if (!nodes.length) return 'Ich kenne noch keinen Knoten.'
    const lines = ['*Was kann welcher Knoten?*']
    const sorted = [...nodes].sort((a, b) => Number(b.local) - Number(a.local) || Number(b.online) - Number(a.online) || a.nodeId.localeCompare(b.nodeId))
    for (const node of sorted) {
        if (!node.online) {
            const ago = node.lastSeen ? Math.max(1, Math.round((now - node.lastSeen) / 60_000)) : null
            lines.push(`• ${node.nodeId} — offline${ago === null ? '' : ago < 120 ? ` seit ${ago} min` : ` seit ${Math.round(ago / 60)} Std.`}`)
            continue
        }
        const skills = node.skills.filter(skill => skill !== 'rechnen' || node.skills.length === 1)
        const what = skills.length ? skills.map(skill => SKILL_LABELS[skill]).join(', ') : 'nur Grundaufgaben'
        lines.push(`• ${node.nodeId}${node.local ? ' (hier)' : ''} — ${what} · ${nodeFacts(node)}`)
    }
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Live facts (read-only; signed profiles + graph + heartbeat)
// ---------------------------------------------------------------------------

export async function collectNodeStrengths(now = Date.now()): Promise<NodeStrength[]> {
    const { collectScoutNodes } = await import('../install/software-scout.js')
    const scoutNodes = await collectScoutNodes().catch(() => [])
    const graph = new Map<string, { runtimes: GraphRuntimeLike[]; hardware?: GraphHardwareLike }>()
    try {
        const { getCapabilityGraph, capabilityRuntimeAvailable } = await import('./capability-graph.js')
        for (const node of getCapabilityGraph().getSnapshot().nodes) {
            graph.set(node.id, {
                hardware: node.hardware as GraphHardwareLike | undefined,
                runtimes: node.runtimes.map(runtime => ({ name: runtime.name, type: runtime.type, models: runtime.models, available: capabilityRuntimeAvailable(node, runtime, now) })),
            })
        }
    } catch { /* graph optional */ }
    let peers: Record<string, { load?: NodeLiveLoad }> = {}
    let trips: Record<string, { ms: number; at: number }> = {}
    let localLoad: NodeLiveLoad | undefined
    try {
        const runtime = await import('./mesh-transport-runtime.js')
        peers = runtime.getMeshPeerStates() as Record<string, { load?: NodeLiveLoad }>
        trips = runtime.getMeshPeerRoundTrips()
    } catch { /* runtime optional */ }
    try {
        const { collectLiveLoad } = await import('../core/node-profile.js')
        const { getNovaDataDir } = await import('../core/data-root.js')
        localLoad = collectLiveLoad(getNovaDataDir())
    } catch { /* optional */ }
    return scoutNodes.map(scout => {
        const entry = graph.get(scout.nodeId)
        const trip = trips[scout.nodeId]
        return deriveStrength({
            nodeId: scout.nodeId, profile: scout.profile, local: scout.local, lastSeen: scout.lastSeen,
            load: scout.local ? localLoad : peers[scout.nodeId]?.load,
            rttMs: trip && now - trip.at < 10 * 60_000 ? trip.ms : undefined,
            graphRuntimes: entry?.runtimes, graphHardware: entry?.hardware, modelOnly: scout.modelOnly,
        }, now)
    })
}

/** Live ranking for a skill. */
export async function rankNodesLive(skill: Skill, options: RankOptions = {}): Promise<NodeRanking> {
    return rankNodes(skill, await collectNodeStrengths(), options)
}
