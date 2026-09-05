import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import { sideEffectsDisabled } from './side-effects.js'
import { validateConfig, type ValidationResult } from './config-validator.js'
import { scanEnvironment, type EnvironmentMap } from '../startup/environment-scanner.js'
import { ensureVoiceDeps, type SetupResult } from '../voice/voice-setup.js'
import { probeGpuRuntime, type GpuRuntimeBackend, type GpuRuntimeStatus } from '../doctor/gpu-runtime.js'
import type { CapabilityGraphSnapshot } from '../mesh/capability-graph.js'

type RiskLevel = 'low' | 'medium' | 'high'
type ActionType = 'config_patch' | 'local_shell' | 'remote_shell'

export interface SetupActionResearch {
    /** Empfohlene Software/Modell */
    name: string
    version?: string
    /** Warum passt es zu dieser Hardware? */
    hardwareMatch: string
    /** Installationsweg (human-readable) */
    installMethod: string
    /** Offizielle Quelle / Docs-URL */
    sourceUrl?: string
    /** Datum der Recherche */
    researchedAt: string
    /** Wie sicher ist die Empfehlung? high = aktuelle offizielle Quelle, medium = Fallback, low = statisch */
    confidence: 'high' | 'medium' | 'low'
    /** Alternative Optionen (Namen) */
    alternatives?: string[]
}

export interface SetupAction {
    id: string
    type: ActionType
    title: string
    reason: string
    risk: RiskLevel
    command?: string
    target?: string
    configPath?: string
    patch?: Record<string, unknown>
    applied?: boolean
    verification?: {
        kind: 'gpu_backend'
        backend: GpuRuntimeBackend
    }
    /** Research-Metadaten wenn durch Capability-Researcher angereichert */
    research?: SetupActionResearch
}

export interface MeshSetupNode {
    name: string
    host?: string
    address?: string
    role?: string
    runtime?: string
    online: boolean
    latencyMs?: number
    hardware?: Record<string, unknown>
    services: Record<string, string>
    ollamaModels: string[]
    capabilities: string[]
    canInstall: string[]
    recommendedFor: string[]
}

export interface SelfSetupState {
    version: 1
    generatedAt: string
    mode: 'proposal' | 'yolo'
    host: {
        name: string
        platform: string
        environment: EnvironmentMap
    }
    config: {
        valid: boolean
        warnings: string[]
        errors: string[]
    }
    voice: {
        ok: boolean
        missingRequired: string[]
        missingOptional: string[]
        warnings: string[]
    }
    mesh: {
        nodes: MeshSetupNode[]
        missingCapabilities: string[]
    }
    memory: {
        supabaseConfigured: boolean
        sharedMemoryLikelyConfigured: boolean
        embeddingProvider?: string
        embeddingModel?: string
    }
    llm: {
        provider?: string
        model?: string
        localCandidates: Array<{ node: string; model: string; endpoint?: string }>
    }
    gpu: GpuRuntimeStatus
    actions: SetupAction[]
    summary: string
}

export interface SelfSetupOptions {
    force?: boolean
    skipNetwork?: boolean
    environment?: EnvironmentMap
    voice?: SetupResult
    config?: any
    validation?: ValidationResult
    now?: Date
    gpu?: GpuRuntimeStatus
    capabilitySnapshot?: CapabilityGraphSnapshot
}

export function isExplicitSelfSetupRequest(input: string): boolean {
    const text = input.toLowerCase().replace(/\s+/g, ' ').trim()
    return /\b(?:self[- ]?setup|setup(?:-| )?plan|installier\w*|deinstallier\w*|konfigurier\w*|einricht\w*|was fehlt|welche\w* (?:capabilit|fähigkeit)\w* fehl\w*|prüf\w* (?:die )?(?:capabilit|hardware|runtime)|scan\w* (?:die )?(?:hardware|runtime)|ollama|ffmpeg|embedding|vision|whisper|\bstt\b|\btts\b|codex)\b/i.test(text)
}

const DATA_DIR = join(process.cwd(), '.nova-data')
const STATE_FILE = join(DATA_DIR, 'setup-state.json')
const CONFIG_FILE = join(process.cwd(), 'nova.config.json')

function isYoloEnabled(config: any): boolean {
    return process.env.NOVA_SELF_SETUP_YOLO === '1'
        || process.env.NOVA_YOLO === '1'
        || config.selfSetup?.mode === 'yolo'
        || config.selfSetup?.yolo === true
}

function readConfig(): any {
    if (!existsSync(CONFIG_FILE)) return {}
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) } catch { return {} }
}

function writeState(state: SelfSetupState): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function loadSelfSetupState(): SelfSetupState | null {
    if (!existsSync(STATE_FILE)) return null
    try {
        const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SelfSetupState
        // setup-state.json from v2.61 and older has no GPU section.
        if (!state.gpu) {
            state.gpu = {
                checkedAt: state.generatedAt,
                detected: false,
                vendor: 'unknown',
                name: null,
                driverDetected: false,
                cudaToolkitDetected: false,
                vulkanLoaderDetected: false,
                supportedBackends: [],
                activeBackend: 'cpu',
                deviceNames: [],
                bindings: [],
                errors: {},
                probeSkipped: true,
            }
        }
        return state
    } catch { return null }
}

function actionId(type: string, target: string): string {
    return `${type}:${target}`.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 96)
}

async function probeOllama(endpoint: string): Promise<{ online: boolean; latencyMs?: number; models: string[] }> {
    const start = Date.now()
    try {
        const resp = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) })
        if (!resp.ok) return { online: false, models: [] }
        const data = await resp.json() as any
        const models = Array.isArray(data.models) ? data.models.map((m: any) => String(m.name || m.model)).filter(Boolean) : []
        return { online: true, latencyMs: Date.now() - start, models }
    } catch {
        return { online: false, models: [] }
    }
}

function capabilitiesFromNode(node: any, ollamaModels: string[]): string[] {
    const caps = new Set<string>()
    if (ollamaModels.length > 0 || node.services?.ollama) caps.add('ollama')
    if (ollamaModels.some((m: string) => /embed|nomic|mxbai/i.test(m))) caps.add('embedding')
    if (ollamaModels.some((m: string) => /llama|mistral|gemma|qwen|phi|deepseek|gpt-oss/i.test(m))) caps.add('llm')
    if (ollamaModels.some((m: string) => /llava|moondream|bakllava|vision/i.test(m))) caps.add('vision')
    const hw = JSON.stringify(node.hardware || node).toLowerCase()
    if (/nvidia|cuda|jetson|rtx|gpu/.test(hw)) caps.add('gpu')
    if (/apple|m3|m4|metal/.test(hw)) caps.add('metal')
    if (node.runtime) caps.add(String(node.runtime))
    return [...caps].sort()
}

function inferCanInstall(node: any, caps: string[]): string[] {
    const can = new Set<string>()
    const os = String(node.os || '').toLowerCase()
    if (/mac/.test(os)) {
        can.add('brew:ollama')
        can.add('brew:ffmpeg')
        can.add('pip:faster-whisper')
        can.add('pip:edge-tts')
    } else if (/windows/.test(os)) {
        can.add('winget:ffmpeg')
        can.add('pip:faster-whisper')
        can.add('pip:edge-tts')
    } else if (/linux|ubuntu|debian/.test(os) || /pi|jetson/i.test(node.name || '')) {
        can.add('apt:ffmpeg')
        can.add('pip:faster-whisper')
        can.add('ollama:model')
    }
    if (!caps.includes('embedding')) can.add('ollama:nomic-embed-text')
    if (!caps.includes('llm')) can.add('ollama:small-llm')
    return [...can].sort()
}

function recommendedFor(node: any, caps: string[], models: string[]): string[] {
    const rec = new Set<string>()
    const ram = Number(node.hardware?.ram_gb || String(node.ram || '').match(/\d+/)?.[0] || 0)
    if (caps.includes('gpu') || caps.includes('metal')) rec.add('local-llm')
    if (caps.includes('embedding')) rec.add('embedding')
    if (models.some(m => /voice/i.test(m))) rec.add('voice-llm')
    if (ram >= 32) rec.add('large-local-models')
    if (/pi/i.test(node.name || '')) rec.add('edge-services')
    if (/server|infra/i.test(`${node.name} ${node.role}`)) rec.add('supabase-infra')
    return [...rec].sort()
}

async function scanMesh(config: any, skipNetwork: boolean): Promise<MeshSetupNode[]> {
    const nodes = Array.isArray(config.nodes) ? config.nodes.filter((n: any) => n.enabled !== false) : []
    const result: MeshSetupNode[] = []
    for (const node of nodes) {
        const services = node.services || {}
        const endpoint = services.ollama as string | undefined
        const probe = endpoint && !skipNetwork ? await probeOllama(endpoint) : { online: false, models: [] as string[] }
        const ollamaModels = probe.models.length > 0 ? probe.models : (Array.isArray(node.ollamaModels) ? node.ollamaModels : [])
        const capabilities = capabilitiesFromNode(node, ollamaModels)
        result.push({
            name: node.name || node.host || 'unknown',
            host: node.host,
            address: node.tailscaleIp || node.ip,
            role: node.role,
            runtime: node.runtime,
            online: probe.online || node.host === 'localhost',
            latencyMs: probe.latencyMs,
            hardware: node.hardware || {},
            services,
            ollamaModels,
            capabilities,
            canInstall: inferCanInstall(node, capabilities),
            recommendedFor: recommendedFor(node, capabilities, ollamaModels),
        })
    }
    return result
}

function setupNodesFromCapabilityGraph(snapshot?: CapabilityGraphSnapshot): MeshSetupNode[] {
    if (!snapshot) return []
    return snapshot.nodes
        .filter(node => node.status === 'online' || node.status === 'busy')
        .map(node => {
            const running = (node.runtimes || []).filter(runtime => runtime.status === 'running')
            const capabilities = new Set<string>(node.capabilities || [])
            const services: Record<string, string> = {}
            const models = new Set<string>()
            for (const runtime of running) {
                if (runtime.endpoint) services[runtime.type || runtime.name.toLowerCase()] = runtime.endpoint
                for (const model of runtime.models || []) models.add(model)
                for (const capability of runtime.capabilities || []) capabilities.add(capability)
                if (runtime.type === 'llm') capabilities.add('llm')
                if (runtime.type === 'embeddings') capabilities.add('embedding')
                if (runtime.type === 'image' || runtime.type === 'vlm') capabilities.add('vision')
                if (runtime.type === 'stt' || runtime.type === 'tts') capabilities.add(runtime.type)
            }
            const normalized = [...capabilities].map(value => String(value).toLowerCase())
            const setupNode: MeshSetupNode = {
                name: node.id || node.hostname,
                host: node.host,
                address: node.host || node.hostname,
                role: 'capability-graph',
                online: true,
                hardware: (node.hardware || {}) as Record<string, unknown>,
                services,
                ollamaModels: [...models],
                capabilities: [...new Set(normalized)].sort(),
                canInstall: [],
                recommendedFor: [],
            }
            setupNode.canInstall = inferCanInstall(setupNode, setupNode.capabilities)
            setupNode.recommendedFor = recommendedFor(setupNode, setupNode.capabilities, setupNode.ollamaModels)
            return setupNode
        })
}

function mergeSetupNodes(configured: MeshSetupNode[], canonical: MeshSetupNode[]): MeshSetupNode[] {
    const merged = new Map<string, MeshSetupNode>()
    for (const node of [...configured, ...canonical]) {
        const key = String(node.host || node.address || node.name).toLowerCase()
        const existing = merged.get(key)
        if (!existing) {
            merged.set(key, node)
            continue
        }
        merged.set(key, {
            ...existing,
            ...node,
            online: existing.online || node.online,
            services: { ...existing.services, ...node.services },
            ollamaModels: [...new Set([...existing.ollamaModels, ...node.ollamaModels])],
            capabilities: [...new Set([...existing.capabilities, ...node.capabilities])].sort(),
            canInstall: [...new Set([...existing.canInstall, ...node.canInstall])].sort(),
            recommendedFor: [...new Set([...existing.recommendedFor, ...node.recommendedFor])].sort(),
        })
    }
    return [...merged.values()]
}

function computeActions(
    config: any,
    voice: SetupResult,
    meshNodes: MeshSetupNode[],
    validation: ValidationResult,
    gpu: GpuRuntimeStatus,
): SetupAction[] {
    const actions: SetupAction[] = []
    if (config.voice?.enabled && config.voice.autoInstallDeps === undefined) {
        actions.push({
            id: actionId('config', 'voice.autoInstallDeps'),
            type: 'config_patch',
            title: 'Voice Auto-Install bewusst auf false setzen',
            reason: 'Nova arbeitet im Plan+Freigabe-Modus; fehlende Voice-Pakete sollen geplant, nicht beim Boot still installiert werden.',
            risk: 'low',
            configPath: 'voice.autoInstallDeps',
            patch: { voice: { ...(config.voice || {}), autoInstallDeps: false } },
        })
    }

    for (const warn of voice.warnings || []) {
        if (/ffmpeg|ffplay/i.test(warn)) {
            actions.push({
                id: actionId('local', 'ffmpeg'),
                type: 'local_shell',
                title: 'Optional ffmpeg/ffplay installieren',
                reason: 'ffplay verbessert Windows-Audio-Playback; Nova kann ohne ffplay per PowerShell-Fallback sprechen.',
                risk: 'medium',
                command: platform() === 'win32'
                    ? 'winget install --id Gyan.FFmpeg --source winget --accept-package-agreements --accept-source-agreements'
                    : platform() === 'darwin'
                        ? 'brew install ffmpeg'
                        : 'sudo apt-get install -y ffmpeg',
            })
        }
    }

    const bestEmbedding = meshNodes
        .filter(n => n.online && n.capabilities.includes('embedding') && n.services.ollama)
        .sort((a, b) => (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999))[0]
    if (bestEmbedding && config.memory?.embedding?.ollamaHost !== bestEmbedding.services.ollama) {
        actions.push({
            id: actionId('config', 'memory.embedding.ollamaHost'),
            type: 'config_patch',
            title: `Embedding auf ${bestEmbedding.name} routen`,
            reason: `${bestEmbedding.name} bietet ein Embedding-Modell und ist erreichbar.`,
            risk: 'low',
            configPath: 'memory.embedding.ollamaHost',
            patch: {
                memory: {
                    ...(config.memory || {}),
                    embedding: {
                        ...(config.memory?.embedding || {}),
                        provider: 'ollama',
                        ollamaHost: bestEmbedding.services.ollama,
                        model: bestEmbedding.ollamaModels.find(m => /embed|nomic|mxbai/i.test(m)) || config.memory?.embedding?.model || 'nomic-embed-text',
                    },
                },
            },
        })
    }

    for (const node of meshNodes.filter(n => n.online && !n.capabilities.includes('embedding') && n.canInstall.includes('ollama:nomic-embed-text'))) {
        actions.push({
            id: actionId('remote', `${node.name}:nomic-embed-text`),
            type: 'remote_shell',
            target: node.name,
            title: `Embedding-Modell auf ${node.name} vorbereiten`,
            reason: `${node.name} kann Embeddings lokal bereitstellen, hat aber kein erkanntes Embedding-Modell.`,
            risk: 'medium',
            command: node.host ? `ssh ${node.host} "ollama pull nomic-embed-text"` : undefined,
        })
    }

    if (!validation.valid) {
        actions.push({
            id: actionId('config', 'validation-errors'),
            type: 'config_patch',
            title: 'Config-Fehler manuell prüfen',
            reason: validation.errors.join('; '),
            risk: 'high',
        })
    }

    if (!gpu.probeSkipped && gpu.detected && gpu.activeBackend === 'cpu') {
        const targetBackend: GpuRuntimeBackend = gpu.vendor === 'nvidia'
            ? (gpu.cudaToolkitDetected ? 'cuda' : 'vulkan')
            : gpu.vendor === 'apple' ? 'metal' : 'vulkan'
        const binding = gpu.bindings.find(candidate => candidate.backend === targetBackend)
        const command = binding?.installed
            ? 'npm rebuild node-llama-cpp'
            : 'npm install --include=optional'
        actions.push({
            id: actionId('local', `gpu-binding-${targetBackend}`),
            type: 'local_shell',
            title: `${targetBackend.toUpperCase()} Native-Binding reparieren`,
            reason: `${gpu.name || gpu.vendor} wurde erkannt, aber ${targetBackend} bestand den isolierten Binding-Smoke-Test nicht. CPU-Fallback bleibt aktiv, bis die Reparatur ebenfalls verifiziert wurde.`,
            risk: 'medium',
            command,
            verification: { kind: 'gpu_backend', backend: targetBackend },
        })
    }

    const unique = new Map<string, SetupAction>()
    for (const action of actions) unique.set(action.id, action)
    return [...unique.values()]
}

function formatSummary(state: SelfSetupState): string {
    const online = state.mesh.nodes.filter(n => n.online).length
    const llmNodes = state.mesh.nodes.filter(n => n.capabilities.includes('llm')).map(n => n.name)
    const parts = [
        `Host ${state.host.name} (${state.host.platform})`,
        `Voice ${state.voice.ok ? 'ok' : 'unvollstaendig'}`,
        `Mesh ${online}/${state.mesh.nodes.length} online`,
        `LLM: ${llmNodes.length ? llmNodes.join(', ') : 'keine lokalen Kandidaten'}`,
        `GPU: ${state.gpu.probeSkipped ? 'nicht geprueft' : `${state.gpu.name || state.gpu.vendor}/${state.gpu.activeBackend}`}`,
        `Actions: ${state.actions.length}`,
    ]
    return parts.join(' | ')
}

export async function runSelfSetupScan(options: SelfSetupOptions = {}): Promise<SelfSetupState> {
    const config = options.config ?? readConfig()
    const validation = options.validation ?? validateConfig()
    const environment = options.environment ?? await scanEnvironment()
    const voice = options.voice ?? (config.voice?.enabled
        ? await ensureVoiceDeps({ installMissing: false })
        : { ok: true, installed: [], failed: [], skipped: [], warnings: [] })
    const gpu = options.gpu ?? await probeGpuRuntime()
    const configuredNodes = await scanMesh(config, Boolean(options.skipNetwork || sideEffectsDisabled()))
    let snapshot = options.capabilitySnapshot
    if (!snapshot && !sideEffectsDisabled()) {
        try {
            const { getCapabilityGraph } = await import('../mesh/capability-graph.js')
            snapshot = getCapabilityGraph().pruneStale()
        } catch { /* setup remains available with configured-node evidence */ }
    }
    const meshNodes = mergeSetupNodes(configuredNodes, setupNodesFromCapabilityGraph(snapshot))
    const availableCapabilities = new Set(meshNodes.filter(node => node.online).flatMap(node => node.capabilities))
    // Nova always has the deterministic local hash embedding fallback. Voice
    // capabilities are requirements only when voice is enabled; vision is a
    // requirement only when explicitly configured. Optional features are not
    // reported as broken merely because they are not installed.
    availableCapabilities.add('embedding')
    if (config.voice?.enabled && voice.ok) {
        availableCapabilities.add('stt')
        availableCapabilities.add('tts')
    }
    const requiredCapabilities = new Set<string>(['llm', 'embedding'])
    if (config.voice?.enabled) { requiredCapabilities.add('stt'); requiredCapabilities.add('tts') }
    if (config.vision?.enabled || config.imageGeneration?.enabled) requiredCapabilities.add('vision')
    const missingCapabilities = [...requiredCapabilities].filter(cap => !availableCapabilities.has(cap))
    const localCandidates = meshNodes
        .filter(n => n.online && n.capabilities.includes('llm'))
        .flatMap(n => n.ollamaModels
            .filter(model => /llama|mistral|gemma|qwen|phi|deepseek|gpt-oss/i.test(model))
            .map(model => ({ node: n.name, model, endpoint: n.services.ollama || n.services.vllm || Object.values(n.services)[0] })))

    const state: SelfSetupState = {
        version: 1,
        generatedAt: (options.now || new Date()).toISOString(),
        mode: isYoloEnabled(config) ? 'yolo' : 'proposal',
        host: { name: hostname(), platform: platform(), environment },
        config: { valid: validation.valid, warnings: validation.warnings, errors: validation.errors },
        voice: {
            ok: voice.ok,
            missingRequired: voice.failed,
            missingOptional: voice.skipped,
            warnings: voice.warnings,
        },
        mesh: { nodes: meshNodes, missingCapabilities },
        memory: {
            supabaseConfigured: Boolean(config.supabase?.url && (config.supabase?.key || config.supabase?.anonKey || config.supabase?.serviceKey)),
            sharedMemoryLikelyConfigured: Boolean(config.supabase?.learningUrl || config.supabase?.meshUrl || config.supabase?.url),
            embeddingProvider: config.memory?.embedding?.provider,
            embeddingModel: config.memory?.embedding?.model,
        },
        llm: {
            provider: config.provider,
            model: config.model,
            localCandidates,
        },
        gpu,
        actions: [],
        summary: '',
    }
    state.actions = computeActions(config, voice, meshNodes, validation, gpu)
    state.summary = formatSummary(state)
    writeState(state)
    return state
}

function mergePatch(base: any, patch: any): any {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
    const out = { ...(base || {}) }
    for (const [key, value] of Object.entries(patch)) {
        out[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergePatch(out[key], value)
            : value
    }
    return out
}

export function formatSelfSetupStatus(state = loadSelfSetupState()): string {
    if (!state) return 'Kein Self-Setup-State vorhanden. Nutze self_setup_plan oder starte Nova neu.'
    const lines = [
        `Nova Self-Setup (${state.generatedAt})`,
        `Modus: ${state.mode === 'yolo' ? 'YOLO (Auto-Apply aktiviert)' : 'Plan + Freigabe'}`,
        state.summary,
        '',
        `Voice: ${state.voice.ok ? 'ok' : 'unvollstaendig'}${state.voice.warnings.length ? ` (${state.voice.warnings.join('; ')})` : ''}`,
        `Memory: Supabase ${state.memory.supabaseConfigured ? 'konfiguriert' : 'fehlt'}, Embedding ${state.memory.embeddingProvider || 'unbekannt'}:${state.memory.embeddingModel || 'unbekannt'}`,
        `LLM lokal: ${state.llm.localCandidates.map(c => `${c.node}/${c.model}`).join(', ') || 'keine Kandidaten'}`,
        `GPU lokal: ${state.gpu.probeSkipped ? 'nicht geprueft' : `${state.gpu.name || state.gpu.vendor} via ${state.gpu.activeBackend.toUpperCase()}`}`,
        '',
        'Mesh:',
        ...state.mesh.nodes.map(n => `- ${n.online ? 'online' : 'offline'} ${n.name}: ${n.capabilities.join(', ') || 'keine'}${n.recommendedFor.length ? ` | sinnvoll: ${n.recommendedFor.join(', ')}` : ''}`),
        '',
        `Empfohlene Aktionen: ${state.actions.length}`,
        ...state.actions.map(a => `- [${a.risk}] ${a.id}: ${a.title}`),
    ]
    return lines.join('\n')
}

export function formatSelfSetupPlan(state: SelfSetupState): string {
    const researchedCount = state.actions.filter(a => a.research).length
    const researchNote = researchedCount > 0
        ? ` (${researchedCount} durch aktuelle Web-Recherche angereichert)`
        : ' (statische Analyse; /setup research für aktuelle Empfehlungen)'

    const lines = [
        `Self-Setup-Plan ${state.generatedAt}`,
        state.summary,
        '',
        state.mode === 'yolo'
            ? 'YOLO aktiv: self_setup_apply kann ohne Einzel-Confirm ausfuehren.'
            : 'Aktionen werden NICHT automatisch ausgefuehrt. self_setup_apply braucht confirm="APPLY:<actionId>".',
        '',
    ]
    if (state.actions.length === 0) {
        lines.push('Keine Aktionen empfohlen.')
    } else {
        lines.push(`Empfohlene Aktionen: ${state.actions.length}${researchNote}`)
        lines.push('')
        for (const action of state.actions) {
            const applied = action.applied ? ' [✓ angewendet]' : ''
            lines.push(`- ${action.id}${applied}`)
            lines.push(`  Risiko: ${action.risk}  Typ: ${action.type}${action.target ? ` (${action.target})` : ''}`)
            lines.push(`  Warum: ${action.reason}`)
            if (action.command) lines.push(`  Command: ${action.command}`)
            if (action.configPath) lines.push(`  Config: ${action.configPath}`)
            if (action.research) {
                const r = action.research
                const confidenceIcon = r.confidence === 'high' ? '🟢' : r.confidence === 'medium' ? '🟡' : '🔴'
                lines.push(`  Research ${confidenceIcon} ${r.confidence}: ${r.name}${r.version ? ' v' + r.version : ''} — ${r.hardwareMatch}`)
                if (r.sourceUrl) lines.push(`  Quelle: ${r.sourceUrl} (Stand ${r.researchedAt.slice(0, 10)})`)
                if (r.alternatives?.length) lines.push(`  Alternativen: ${r.alternatives.join(', ')}`)
            }
        }
    }
    return lines.join('\n')
}

export async function applySelfSetupAction(actionIdToApply: string, confirm: string): Promise<{ success: boolean; message: string }> {
    const state = loadSelfSetupState()
    if (!state) return { success: false, message: 'Kein Setup-Plan vorhanden. Erst self_setup_plan ausfuehren.' }
    const action = state.actions.find(a => a.id === actionIdToApply)
    if (!action) return { success: false, message: `Aktion nicht gefunden: ${actionIdToApply}` }
    // Native runtime changes remain approval-gated even when general YOLO mode is enabled.
    const alwaysConfirm = action.verification?.kind === 'gpu_backend'
    if ((state.mode !== 'yolo' || alwaysConfirm) && confirm !== `APPLY:${actionIdToApply}`) {
        return { success: false, message: `Freigabe fehlt. Erwartet confirm="APPLY:${actionIdToApply}".` }
    }

    if (action.type === 'config_patch') {
        if (!action.patch) return { success: false, message: 'Diese Config-Aktion ist nur ein manueller Hinweis.' }
        const config = readConfig()
        const next = mergePatch(config, action.patch)
        writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n')
        action.applied = true
        writeState(state)
        return { success: true, message: `Config angewendet: ${action.configPath || action.id}` }
    }

    if (!action.command) return { success: false, message: 'Keine ausfuehrbare Command-Aktion vorhanden.' }
    try {
        // stdio: 'pipe' — daemon has no TTY; 'inherit' throws "handle invalid" in pm2/background
        const out = execSync(action.command, {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 300_000,
            windowsHide: true,
        })
        if (action.verification?.kind === 'gpu_backend') {
            const verified = await probeGpuRuntime({ fresh: true })
            if (!verified.supportedBackends.includes(action.verification.backend)) {
                const detail = verified.errors[action.verification.backend]
                return {
                    success: false,
                    message: `Aktion lief, aber ${action.verification.backend.toUpperCase()} bestand den Kontroll-Smoke-Test nicht${detail ? `: ${detail}` : '.'} CPU-Fallback bleibt aktiv.`,
                }
            }
        }
        action.applied = true
        writeState(state)
        const snippet = typeof out === 'string' ? out.trim().slice(0, 200) : ''
        return { success: true, message: `Aktion ausgefuehrt: ${action.id}${snippet ? '\n' + snippet : ''}` }
    } catch (err: any) {
        const detail = err?.stderr?.toString?.()?.trim?.() || err?.message || String(err)
        return { success: false, message: `Fehler bei ${action.id}: ${detail.slice(0, 300)}` }
    }
}

export async function applySelfSetupPlan(confirm = ''): Promise<{ success: boolean; applied: string[]; failed: string[]; message: string }> {
    const state = loadSelfSetupState()
    if (!state) return { success: false, applied: [], failed: [], message: 'Kein Setup-Plan vorhanden. Erst self_setup_plan ausfuehren.' }
    if (state.mode !== 'yolo' && confirm !== `APPLY_ALL:${state.generatedAt}`) {
        return {
            success: false,
            applied: [],
            failed: [],
            message: `Freigabe fehlt. Erwartet confirm="APPLY_ALL:${state.generatedAt}" oder YOLO-Modus.`,
        }
    }

    const applied: string[] = []
    const failed: string[] = []
    for (const action of state.actions) {
        if (action.applied) continue
        try {
            const result = await applySelfSetupAction(action.id, state.mode === 'yolo' ? '' : `APPLY:${action.id}`)
            if (result.success) applied.push(action.id)
            else failed.push(`${action.id}: ${result.message}`)
        } catch (err) {
            failed.push(`${action.id}: ${err}`)
        }
    }
    return {
        success: failed.length === 0,
        applied,
        failed,
        message: `Applied ${applied.length}, failed ${failed.length}`,
    }
}

// ============================================
// Research-Enrichment Loop (no gate — read-only enrichment)
// ============================================

export interface SelfSetupResearchOptions {
    force?: boolean
    skipNetwork?: boolean
    skipWeb?: boolean
    timeoutMs?: number
    capabilities?: string[]
}

/**
 * Enriches the current setup plan with live web research for every missing capability.
 * Research is always automatic (no gate). Results are written back to setup-state.json.
 * Install/apply still requires explicit approval.
 */
export async function runSelfSetupResearch(options: SelfSetupResearchOptions = {}): Promise<SelfSetupState> {
    // Load or run a fresh scan
    let state = loadSelfSetupState()
    if (!state || options.force) {
        console.log('[SelfSetupResearch] Running fresh scan...')
        state = await runSelfSetupScan({ skipNetwork: options.skipNetwork })
    }

    const requested = options.capabilities?.map(c => c.toLowerCase().trim()).filter(Boolean)
    const missing = requested?.length ? requested : state.mesh.missingCapabilities
    if (!missing.length) {
        console.log('[SelfSetupResearch] No missing capabilities — nothing to research.')
        return state
    }

    console.log(`[SelfSetupResearch] 🔬 Researching ${missing.length} missing capabilities: ${missing.join(', ')}`)

    // Lazy import to avoid circular deps at module load time
    const { researchAllMissingCapabilities, researchResultToSetupAction } = await import('./capability-researcher.js')

    const results = await researchAllMissingCapabilities(
        missing,
        state.mesh.nodes,
        { force: options.force, timeoutMs: options.timeoutMs, skipWeb: options.skipWeb },
    )

    console.log(`[SelfSetupResearch] ✅ Received ${results.length} research results`)

    // Merge/replace actions: research-backed actions replace static ones for the same capability
    const byId = new Map<string, SetupAction>(state.actions.map(a => [a.id, a]))

    for (const res of results) {
        const action = researchResultToSetupAction(res)
        // Research-backed actions always win over static equivalents for the same capability
        byId.set(action.id, action)
    }

    state.actions = [...byId.values()]
    state.summary = formatSummary(state)
    writeState(state)

    console.log(`[SelfSetupResearch] 💾 Enriched setup-state.json (${state.actions.length} actions, ${results.length} with research)`)
    return state
}

export default {
    runSelfSetupScan,
    runSelfSetupResearch,
    loadSelfSetupState,
    formatSelfSetupStatus,
    formatSelfSetupPlan,
    applySelfSetupAction,
    applySelfSetupPlan,
}
