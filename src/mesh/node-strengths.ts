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
import { NODE_OFFLINE_AFTER_MS } from './mesh-node-lifecycle.js'

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

/**
 * 2.89: THE one online window of the mesh (mesh-node-lifecycle.ts). Registry, Capability
 * Graph, mesh_status and this module used 75 s / 3 min / 5 min side by side and could say
 * "online" and "offline" about the same node in one answer.
 */
export const ONLINE_WINDOW_MS = NODE_OFFLINE_AFTER_MS

export interface StrengthService { name: string; type: string; models: string[]; running: boolean }

/** The per-node strength profile ("Stärkenprofil"). */
export interface NodeStrength {
    nodeId: string
    hostname?: string
    version?: string
    /** Where this node came from: signed profile, registry (Supabase / direct mesh) or capability graph. */
    source?: 'profile' | 'registry' | 'graph'
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
/** Model tag names a size ("llama-70b-q4", "qwen3:32b"); 30 B and up counts as big. */
const isBigModel = (model: string) => [...String(model).matchAll(/(?:^|[^a-z0-9.])(\d{2,3})b(?![a-z])/gi)].some(match => Number(match[1]) >= 30)
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

export interface GpuFactsInput { name?: string | null; backend?: string; vramGB?: number; viaVllm?: boolean }
export interface GpuFacts { name: string | null; backend: string; vramGB?: number; unified: boolean; viaVllm: boolean; has: boolean }

/**
 * 2.89: THE one "does this node have a GPU?" decision (before: node-profile, scan, capability
 * orchestrator, self-setup and hardware-role each had their own, and several took a plain
 * display adapter for a GPU). Only own compute evidence counts: VRAM, a CUDA/ROCm backend with
 * a name, vLLM on this node, or unified-memory silicon. A name alone proves nothing.
 */
export function gpuFacts(input: GpuFactsInput): GpuFacts {
    const reportedName = input.name ?? null
    const backend = lower(input.backend || 'cpu')
    const viaVllm = input.viaVllm === true
    const reportedVram = input.vramGB && input.vramGB > 0 ? input.vramGB : undefined
    const has = Boolean(reportedVram) || viaVllm || backend === 'metal'
        || (Boolean(reportedName) && (['cuda', 'rocm'].includes(backend) || UNIFIED_GPU.test(String(reportedName))))
    const name = has ? reportedName : null
    const vramGB = has ? reportedVram : undefined
    const unified = backend === 'metal' || (Boolean(name) && UNIFIED_GPU.test(String(name)) && !vramGB) || (viaVllm && !vramGB)
    return { name, backend, ...(vramGB ? { vramGB } : {}), unified, viaVllm, has }
}

/** What a model name says it is (one place; before: self-setup, orchestrator probe and strengths each guessed). */
export function modelKinds(model: string): { embedding: boolean; vision: boolean; code: boolean; llm: boolean } {
    const embedding = EMBED.test(model)
    return { embedding, vision: VISION_MODEL.test(model), code: CODE_MODEL.test(model), llm: !embedding }
}

export function deriveStrength(input: StrengthInput, now = Date.now()): NodeStrength {
    const profile = input.profile
    const graphVram = Number(input.graphHardware?.gpu_vram_mb || 0)
    const gpu = gpuFacts({
        name: profile.gpu?.name ?? null, backend: profile.gpu?.backend, viaVllm: profile.gpu?.viaVllm === true,
        vramGB: profile.gpu?.vramGB || (graphVram > 0 ? Math.round(graphVram / 1024) : undefined),
    })
    const backend = gpu.backend, viaVllm = gpu.viaVllm, gpuName = gpu.name, vramGB = gpu.vramGB, unified = gpu.unified
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
        ...(profile.hostname ? { hostname: profile.hostname } : {}),
        ...(profile.version ? { version: profile.version } : {}),
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
            // Without GPU memory only a really running big model counts; plain RAM size alone claims nothing.
            if (node.modelMemoryHow === 'RAM' && !running(node, isLlm).some(service => service.models.some(isBigModel))) {
                return { score: 0, reasons, excluded: 'keine GPU und kein großes Modell geladen' }
            }
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
    ['vision', /was ist auf (dem|diesem) (bild|foto)|beschreib\w* (das|dieses) (bild|foto)|\bbild\w*\b.*\b(analys|erkenn)|image.*(analy|describe)|\bocr\b|texterkennung|gesichtserkennung|face.*detect|object.*detect|opencv/i],
    ['stt', /transkri|diktat|sprachnachricht|speech.?to.?text|whisper|untertitel/i],
    ['tts', /\b(vorlesen|sprachausgabe|text.?to.?speech|tts|vertonen)\b/i],
    ['medien', /konvertier|\bconvert|umwandeln|transcod|ffmpeg|video\w*\b.*\b(schneid|komprimier|umwandeln)|audio\w*\b.*\b(extrahier|extract)|\b(mp4|mkv|wav)\b|\bcompress/i],
    ['embedding', /embedding|einbetten|vektorisier|rag.?index|indexier/i],
    ['code', /programmier|\bcode\b|refactor|kompilier|\bbuild\b|\btests?\b.*\b(laufen|ausführ|fix)|\brepo(sitory)?\b|\bgit\b|bugfix|implementier|führ\w*\b.*\baus\b|\bexecute\b|(python|node|bash)\b.*\brun\b|run.*script/i],
    ['grosse-modelle', /gro(ß|ss)es? modell|\b(70b|72b)\b|large model|lange[rn]? kontext|long.?context/i],
    ['speicher', /\b(sichern|sicherung|backup|archivier|ablegen)\b|speicherplatz/i],
    ['llm', /lokal(es|en)? (modell|llm)|modell\w*\b.*\blokal|\bollama\b|\bllama\b|\bvllm\b|local (model|llm)|\binferen(ce|z)\b/i],
    ['rechnen', /berechn|rechenintensiv|simulation|\bbatch\b|massenhaft|viele dateien/i],
]

/** Old task names of the mesh_route tool → skill (before: LEGACY_TASKS / taskToSkill in mesh-brain.ts). */
const LEGACY_TASKS: Record<string, Skill> = {
    'large-llm': 'grosse-modelle',
    'fast-llm': 'llm',
    'embedding': 'embedding',
    'image-generation': 'bilder',
    'stt-voice': 'stt',
    'media-convert': 'medien',
    'cuda-inference': 'llm',
}

/**
 * 2.89: THE one "which skill does this task need?" (before: mesh-brain taskToSkill for the
 * tool's task names, mesh-router detectMeshTaskType for free text, and this table).
 * A skill name or an old task name is taken as is; free text goes through the patterns.
 */
export function skillForTask(text: string): Skill | null {
    const value = String(text || '').slice(0, 2000)
    const key = value.trim().toLowerCase()
    if ((SKILLS as readonly string[]).includes(key)) return key as Skill
    if (LEGACY_TASKS[key]) return LEGACY_TASKS[key]
    for (const [skill, pattern] of TASK_PATTERNS) if (pattern.test(value)) return skill
    return null
}

// ---------------------------------------------------------------------------
// Hardware words (one phrase for prompt, tools and answers)
// ---------------------------------------------------------------------------

export interface HardwareFactsInput {
    cpuLabel?: string
    cpus: number
    ramGB: number
    gpu?: GpuFactsInput
    /** A plain display adapter (VM display, server board graphics): named, never called a GPU. */
    displayAdapter?: string | null
    os?: string
}

/** "AMD Ryzen 9, 16 Kerne, 64 GB RAM, GPU RTX 4090 (24 GB VRAM), Windows". No GPU without compute evidence. */
export function hardwarePhrase(input: HardwareFactsInput): string {
    const parts: string[] = []
    if (input.cpuLabel) parts.push(input.cpuLabel)
    parts.push(`${input.cpus} Kerne`, `${input.ramGB} GB RAM`)
    const gpu = gpuFacts(input.gpu || {})
    if (gpu.has && gpu.name) parts.push(`GPU ${gpu.name}${gpu.vramGB ? ` (${gpu.vramGB} GB VRAM)` : gpu.unified ? ' (gemeinsamer Speicher)' : ''}`)
    else if (gpu.has) parts.push('GPU (über vLLM genutzt)')
    else if (input.displayAdapter) parts.push(`Grafik: ${input.displayAdapter} (Anzeigeadapter, keine GPU für Modelle)`)
    else parts.push('keine GPU')
    if (input.os) parts.push(input.os)
    return parts.join(', ')
}

export function hardwarePhraseOf(node: NodeStrength): string {
    return hardwarePhrase({ cpus: node.cpus, ramGB: node.ramGB, gpu: { name: node.gpu.name, backend: node.gpu.backend, vramGB: node.gpu.vramGB, viaVllm: node.gpu.viaVllm } })
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

/** mesh_nodes: who is reachable for a hand-over (online, not this node), same facts as every other list. */
export function formatAvailableNodes(nodes: readonly NodeStrength[], now = Date.now()): string {
    const others = nodes.filter(node => node.online && !node.local)
    if (!others.length) return 'Keine verfügbaren Nodes im Mesh. Nur ich bin aktiv.'
    return formatStrengthList(others, now)
}

/** The mesh answer to "Mesh / Nodes / Knoten": one line per node, from the same strengths. */
export function formatMeshRuntimeLines(nodes: readonly NodeStrength[], now = Date.now()): string[] {
    if (!nodes.length) return ['Mesh: keine Knoten gefunden.']
    const lines = [`Mesh: ${nodes.length} Knoten:`]
    const sorted = [...nodes].sort((a, b) => Number(b.local) - Number(a.local) || Number(b.online) - Number(a.online) || a.nodeId.localeCompare(b.nodeId))
    for (const node of sorted) {
        const name = node.hostname && node.hostname !== node.nodeId ? `${node.hostname} (${node.nodeId})` : node.nodeId
        const version = node.version ? `, v${node.version}` : ''
        if (!node.online) {
            const ago = node.lastSeen ? Math.max(1, Math.round((now - node.lastSeen) / 60_000)) : null
            lines.push(`- ${name}: offline${ago === null ? '' : ago < 120 ? ` seit ${ago} min` : ` seit ${Math.round(ago / 60)} Std.`}${version}`)
            continue
        }
        const seen = !node.local && node.lastSeen ? `, Meldung vor ${Math.max(0, Math.round((now - node.lastSeen) / 1000))} s` : ''
        const skills = node.skills.filter(skill => skill !== 'rechnen' || node.skills.length === 1)
        lines.push(`- ${name}${node.local ? ' (hier)' : ''}: online${version}${seen} — ${skills.length ? skills.map(skill => SKILL_LABELS[skill]).join(', ') : 'nur Grundaufgaben'} · ${nodeFacts(node)}`)
    }
    return lines
}

// ---------------------------------------------------------------------------
// Nodes that report no signed profile: Supabase registry, direct mesh, capability graph
// ---------------------------------------------------------------------------

export interface ReportedHardware { cores?: number; ram_gb?: number; arch?: string; disk_free_gb?: number; gpu?: string; gpu_vram_mb?: number }
export interface ReportedService { name: string; type: string; status: string; models?: string[] }
/** One report about a node that is not a signed profile (registry row or capability-graph node). */
export interface ReportedNode {
    id: string
    hostname?: string
    platform?: string
    version?: string
    capabilities?: string[]
    hardware?: ReportedHardware
    software?: { ffmpeg?: boolean; git?: boolean; ai_services?: ReportedService[]; ollama_models?: string[] }
    /** Heartbeat or last report time (ms). */
    lastSeen?: number
    source: 'registry' | 'graph'
}

type ServiceType = 'llm' | 'vlm' | 'tts' | 'stt' | 'embeddings' | 'image'
const SERVICE_TYPE_BY_NAME: Array<[RegExp, ServiceType]> = [
    [/whisper|stt|parakeet|vosk/i, 'stt'], [/piper|tts|kokoro|xtts/i, 'tts'], [/comfy|stable.?diffusion|automatic1111|fooocus|invoke/i, 'image'],
    [/embed/i, 'embeddings'], [/ollama|vllm|llama|lm.?studio|llm/i, 'llm'],
]
const NODE_SERVICE_TYPE_SET = new Set(['llm', 'vlm', 'tts', 'stt', 'embeddings', 'image'])

/**
 * A strength profile for a node that reports hardware and services but no signed profile.
 * Same decisions as for signed profiles (gpuFacts, window, skills) - never a second table.
 */
export function strengthFromReportedNode(node: ReportedNode, now = Date.now()): NodeStrength {
    const caps = (node.capabilities || []).map(lower)
    const hardware = node.hardware || {}
    const backend = caps.includes('cuda') || caps.includes('nvidia') ? 'cuda' : caps.includes('macos') && /arm|aarch/i.test(String(hardware.arch)) ? 'metal' : 'cpu'
    const services = (node.software?.ai_services || []).flatMap(service => {
        const type = lower(service.type)
        const mapped = NODE_SERVICE_TYPE_SET.has(type) ? type : SERVICE_TYPE_BY_NAME.find(([pattern]) => pattern.test(`${service.name} ${service.type}`))?.[1]
        return mapped ? [{ name: String(service.name), type: mapped, status: service.status === 'running' || service.status === 'stopped' ? service.status : 'installed' }] : []
    }) as NonNullable<NodeProfile['services']>
    const tools = [...new Set([...(node.software?.git ? ['git'] : []), ...(node.software?.ffmpeg ? ['ffmpeg'] : []), ...['git', 'ffmpeg', 'docker', 'python', 'adb', 'ssh'].filter(tool => caps.includes(tool))])]
    const profile = {
        schema: 1, nodeId: node.id, hostname: node.hostname || node.id, platform: node.platform || 'unknown', arch: hardware.arch || 'unknown',
        version: node.version || '', role: caps.includes('main-eligible') ? 'main' : 'worker', runtime: 'unknown', rootReadOnly: null, noNewPrivileges: null,
        cpus: Number(hardware.cores) || 0, ramGB: Number(hardware.ram_gb) || 0,
        gpu: { name: hardware.gpu ?? null, backend, viaVllm: services.some(service => service.status === 'running' && /vllm/i.test(service.name)) },
        services, installPath: 'none', tools,
        selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '',
    } as unknown as NodeProfile
    // Services with their models become runtimes (same shape as capability-graph runtimes).
    const graphRuntimes: GraphRuntimeLike[] = (node.software?.ai_services || []).map(service => ({
        name: service.name, type: service.type, models: service.models || [], available: service.status === 'running',
    }))
    const strength = deriveStrength({
        nodeId: node.id, profile, local: false, lastSeen: node.lastSeen, graphRuntimes,
        graphHardware: { gpu_vram_mb: hardware.gpu_vram_mb, disk_free_gb: hardware.disk_free_gb },
    }, now)
    return { ...strength, source: node.source }
}

/** "main-eligible" is a fact each node reports about itself (succession config), not a list in code. */
export function nodeMainEligible(capabilities: readonly string[] | undefined): boolean {
    const caps = (capabilities || []).map(lower)
    return caps.includes('main-eligible') && !caps.includes('main-ineligible') && !caps.includes('worker-only')
}

// ---------------------------------------------------------------------------
// Live facts (read-only; signed profiles + registry + graph + heartbeat)
// ---------------------------------------------------------------------------

/** Sources collectNodeStrengths reads besides the signed profiles. Tests pass fixtures. */
export interface StrengthSources {
    /** Registry rows (Supabase + local file + direct mesh), already read. Default: discoverNodes() (memoised 30 s). */
    registry?: ReportedNode[]
    /** false = registry from the local file and the signed direct mesh only, no Supabase request. Default true. */
    registryRemote?: boolean
    /** No local profile and no peers (cheap view for scans with side effects off): only the reports below. */
    skipScout?: boolean
    /** More reports (e.g. nodes named in the config), joined like registry rows. */
    extra?: ReportedNode[]
    /** Capability-graph snapshot. Default: the live graph. */
    snapshot?: import('./capability-graph.js').CapabilityGraphSnapshot
}

/** One reading of a graph snapshot: runtimes per node (for signed profiles) and reports for graph-only nodes. */
async function graphViews(snapshot: import('./capability-graph.js').CapabilityGraphSnapshot, now: number): Promise<{ graph: Map<string, { runtimes: GraphRuntimeLike[]; hardware?: GraphHardwareLike }>; reported: ReportedNode[] }> {
    const { capabilityRuntimeAvailable, capabilityRuntimeTombstoned } = await import('./capability-graph.js')
    const graph = new Map<string, { runtimes: GraphRuntimeLike[]; hardware?: GraphHardwareLike }>()
    const reported: ReportedNode[] = []
    const tombstones = new Map((snapshot.tombstones || []).map(item => [item.id, item]))
    for (const rawNode of snapshot.nodes) {
        // A removed runtime (tombstone) is gone, not just "stopped".
        const node = { ...rawNode, runtimes: rawNode.runtimes.filter(runtime => !capabilityRuntimeTombstoned(runtime, tombstones.get(runtime.id))) }
        graph.set(node.id, {
            hardware: node.hardware as GraphHardwareLike | undefined,
            runtimes: node.runtimes.map(runtime => ({ name: runtime.name, type: runtime.type, models: runtime.models, available: capabilityRuntimeAvailable(node, runtime, now) })),
        })
        // A runtime counts as running only while the graph's own freshness rule says so (stale = stopped).
        reported.push({
            id: node.id, hostname: node.hostname, capabilities: node.capabilities, hardware: node.hardware,
            software: {
                ...(node.software ? { ffmpeg: node.software.ffmpeg, git: node.software.git } : {}),
                ai_services: node.runtimes.map(runtime => ({
                    name: runtime.name, type: runtime.type, models: runtime.models,
                    status: capabilityRuntimeAvailable(node, runtime, now) ? 'running' : runtime.status === 'running' ? 'stopped' : runtime.status,
                })),
            },
            lastSeen: Date.parse(node.lastHeartbeat || node.updatedAt) || undefined, source: 'graph',
        })
    }
    return { graph, reported }
}

/** One registry row (Supabase, local file, direct mesh) as a report. */
export function reportedFromRegistryNode(node: { node_id: string; hostname?: string; platform?: string; version?: string; capabilities?: string[]; hardware?: ReportedHardware; software?: ReportedNode['software']; last_heartbeat?: string }): ReportedNode {
    return {
        id: node.node_id, hostname: node.hostname, platform: node.platform, version: node.version, capabilities: node.capabilities,
        hardware: node.hardware, software: node.software, lastSeen: Date.parse(String(node.last_heartbeat || '')) || undefined, source: 'registry',
    }
}

let registryMemo: { at: number; nodes: ReportedNode[] } | null = null
const REGISTRY_MEMO_MS = 30_000

async function readRegistryNodes(now: number, remote: boolean): Promise<ReportedNode[]> {
    if (remote && registryMemo && now - registryMemo.at < REGISTRY_MEMO_MS) return registryMemo.nodes
    let nodes: ReportedNode[] = []
    try {
        const { discoverNodes } = await import('./mesh-registry.js')
        nodes = (await discoverNodes({ remote })).map(reportedFromRegistryNode)
    } catch { /* registry optional (offline, no Supabase) */ }
    if (remote) registryMemo = { at: now, nodes }
    return nodes
}

export function resetNodeStrengthMemo(): void { registryMemo = null }

export async function collectNodeStrengths(now = Date.now(), sources: StrengthSources = {}): Promise<NodeStrength[]> {
    const scoutNodes = sources.skipScout ? [] : await (await import('../install/software-scout.js')).collectScoutNodes().catch(() => [])
    let graph = new Map<string, { runtimes: GraphRuntimeLike[]; hardware?: GraphHardwareLike }>()
    let graphReported: ReportedNode[] = []
    try {
        const snapshot = sources.snapshot ?? (await import('./capability-graph.js')).getCapabilityGraph().getSnapshot()
        const views = await graphViews(snapshot, now)
        graph = views.graph
        graphReported = views.reported
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
    const strengths: NodeStrength[] = scoutNodes.map(scout => {
        const entry = graph.get(scout.nodeId)
        const trip = trips[scout.nodeId]
        return { ...deriveStrength({
            nodeId: scout.nodeId, profile: scout.profile, local: scout.local, lastSeen: scout.lastSeen,
            load: scout.local ? localLoad : peers[scout.nodeId]?.load,
            rttMs: trip && now - trip.at < 10 * 60_000 ? trip.ms : undefined,
            graphRuntimes: entry?.runtimes, graphHardware: entry?.hardware, modelOnly: scout.modelOnly,
        }, now), source: 'profile' as const }
    })
    // Nodes without a signed profile (Supabase registry, direct mesh, graph only) join as input:
    // before, mesh_nodes / mesh_status listed them while "what can which node do" never saw them.
    const known = new Set(strengths.map(node => node.nodeId))
    const registry = [...(sources.registry ?? await readRegistryNodes(now, sources.registryRemote !== false)), ...(sources.extra || [])]
    const registryIds = new Set(registry.map(node => node.id))
    for (const reported of [...registry, ...graphReported.filter(node => !registryIds.has(node.id))]) {
        if (!reported.id || known.has(reported.id)) continue
        known.add(reported.id)
        strengths.push(strengthFromReportedNode(reported, now))
    }
    return strengths
}

/** Live ranking for a skill. */
export async function rankNodesLive(skill: Skill, options: RankOptions = {}): Promise<NodeRanking> {
    return rankNodes(skill, await collectNodeStrengths(), options)
}
