/**
 * 2.89 (Paket C): THE one answer to "what can Xaventra do right now?".
 *
 * "Kann ich?" was answered in about eight places, each from its own source:
 * the learning gate (tool register + connected list), the capability orchestrator
 * (graph + cloud list), self-setup (config + mesh scan, with embedding always "there"),
 * mesh_capabilities, the tool-health prompt, the negative memory ...
 * They could disagree ("kann ich nicht" while Whisper ran on another node).
 *
 * capabilityInventory() joins the real sources, each read once:
 *  - the tool register (what is callable),
 *  - the connection status (Paket B: connectionState(), read via readConnections),
 *  - mesh skills (mesh/node-strengths.ts: what online nodes can do now, one online window),
 *  - the one tool-health store (a registered tool that keeps failing does not count),
 *  - cloud providers with a key and the active runtime (llm/active-runtime.ts),
 *  - what was learned (learning jobs).
 * missingCapabilities() is the one "Fehlend" list that self-setup, mesh_capabilities and
 * the orchestrator show. No capability is "there" without evidence - embedding included.
 */
import type { NodeStrength, Skill } from '../mesh/node-strengths.js'
import type { ToolHealthEntry } from '../core/tool-health-store.js'
import type { CloudProviderView } from '../llm/active-runtime.js'

export interface LearnedCapability { signature: string; topic: string; domainId?: string; tools: string[] }

export type EmbeddingSource = 'echt' | 'notbehelf'

export interface CapabilityInventory {
    /** Names in the tool register (incl. active forge tools). */
    tools: readonly string[]
    /** Connectors whose status is "verbunden". */
    connected: ReadonlySet<string>
    /** Learned capabilities that still hold. */
    learned: readonly LearnedCapability[]
    /** All known connections with their status (tells "not connected" from "unknown"). */
    connections?: ReadonlyMap<string, string>
    /** Registered tools that do not work here right now (one tool-health store). */
    brokenTools?: ReadonlySet<string>
    /** Mesh skill -> online nodes that can do it now (node-strengths). */
    mesh?: ReadonlyMap<Skill, readonly string[]>
    /** Cloud providers with a configured key (presence only). */
    cloud?: readonly CloudProviderView[]
    /** Active runtime facts for the "llm" line. */
    runtime?: { provider: string; kind: 'local' | 'cloud' | 'none'; reachable: boolean | null; keyPresent?: boolean }
    /** A real embedding source exists (own model in the process, or a node runs an embedding model). */
    embedding?: EmbeddingSource
    /** Voice (stt/tts) works in this process (local voice pipeline ready). */
    voiceReady?: boolean
}

export const CORE_CAPABILITIES = ['llm', 'vision', 'tts', 'stt', 'embedding'] as const
export type CoreCapability = typeof CORE_CAPABILITIES[number]

export interface CapabilityLine {
    name: CoreCapability
    status: 'ja' | 'notbehelf' | 'fehlt'
    /** Short evidence, e.g. "knoten:gpu-box", "cloud:openai", "lokal:ollama". */
    via: string[]
}

/** The node skills that make a core capability true. */
const MESH_FOR: Record<CoreCapability, Skill[]> = { llm: ['llm'], vision: ['vision'], tts: ['tts'], stt: ['stt'], embedding: ['embedding'] }

export function capabilityLines(inventory: CapabilityInventory): CapabilityLine[] {
    return CORE_CAPABILITIES.map((name): CapabilityLine => {
        const via: string[] = []
        for (const skill of MESH_FOR[name]) for (const node of inventory.mesh?.get(skill) || []) via.push(`knoten:${node}`)
        for (const provider of inventory.cloud || []) if (provider.keyPresent && provider.capabilities.includes(name) && name !== 'embedding') via.push(`cloud:${provider.name}`)
        if (name === 'llm' && inventory.runtime) {
            const runtime = inventory.runtime
            if (runtime.kind === 'local' && runtime.reachable === true) via.push(`lokal:${runtime.provider}`)
            else if (runtime.kind === 'cloud' && runtime.keyPresent) via.push(`cloud:${runtime.provider}`)
        }
        if ((name === 'stt' || name === 'tts') && inventory.voiceReady) via.push('lokal:sprachpipeline')
        if (name === 'embedding') {
            // Never "there" by default: a real source, or only the hash makeshift.
            if (inventory.embedding === 'echt') via.push('lokal:einbetter')
            return { name, status: via.length ? 'ja' : 'notbehelf', via }
        }
        return { name, status: via.length ? 'ja' : 'fehlt', via: [...new Set(via)] }
    })
}

/** The one "Fehlend" list. Embedding with only the hash makeshift counts as missing. */
export function missingCapabilities(inventory: CapabilityInventory): CoreCapability[] {
    return capabilityLines(inventory).filter(line => line.status !== 'ja').map(line => line.name)
}

export const CAPABILITY_LABELS: Record<CoreCapability, string> = {
    llm: 'Sprachmodell', vision: 'Bilder verstehen', tts: 'Sprachausgabe', stt: 'Spracherkennung', embedding: 'Gedächtnis-Suche',
}

/** Human words for the missing list ("Gedächtnis-Suche (nur Notbehelf)"). */
export function describeMissing(inventory: CapabilityInventory): string[] {
    return capabilityLines(inventory).filter(line => line.status !== 'ja')
        .map(line => `${CAPABILITY_LABELS[line.name]}${line.status === 'notbehelf' ? ' (nur Notbehelf, kein echtes Modell)' : ''}`)
}
// ---------------------------------------------------------------------------
// Live collection (each source read once; every part can be injected)
// ---------------------------------------------------------------------------

export interface InventoryDeps {
    dataDir?: string
    tools?: () => Promise<string[]> | string[]
    /** Paket B: the one connection state. Default: connectionState() per connector (readConnections). */
    connections?: () => Promise<Map<string, string>> | Map<string, string>
    strengths?: () => Promise<readonly NodeStrength[]>
    toolHealth?: () => readonly ToolHealthEntry[]
    learned?: () => Promise<LearnedCapability[]> | LearnedCapability[]
    cloud?: () => CloudProviderView[]
    runtime?: () => Promise<CapabilityInventory['runtime']>
    embedding?: () => Promise<EmbeddingSource> | EmbeddingSource
    voiceReady?: boolean
    /** Probe the configured local endpoint (network). Default off: reachability evidence comes from the graph and heartbeats. */
    probeRuntime?: boolean
    /** Only mesh / cloud / runtime / embedding (for the "Fehlend" list): no register, connection or learning reads. */
    light?: boolean
    now?: number
}

/**
 * Connection statuses by connector id, from the one connection truth (Paket B:
 * connections/connection-state.ts). "verbunden" only when connectionState() says so
 * (configured Home Assistant included, an HA_URL alone is not enough); otherwise the
 * stored record status, so "not connected" stays apart from "unknown".
 */
async function readConnections(dataDir?: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    try {
        const { standKontext, connectionState } = await import('../connections/connection-state.js')
        const ctx = dataDir ? standKontext(dataDir) : standKontext()
        const ids = new Set<string>(['home-assistant', ...ctx.connections.map(record => record.connectorId)])
        for (const id of ids) {
            if (connectionState(ctx.dataDir, { connectorId: id }, ctx).zustand === 'verbunden') { out.set(id, 'verbunden'); continue }
            const stored = ctx.connections.filter(record => record.connectorId === id)
            const record = stored.find(item => item.status !== 'getrennt' && item.status !== 'verbunden') || stored[0]
            if (record) out.set(id, record.status === 'verbunden' ? 'getrennt' : record.status)
        }
    } catch { /* no connections */ }
    return out
}

/** The one "Fehlend" list, read live (self-setup, mesh_capabilities, orchestrator, prompt). */
export async function currentMissingCapabilities(deps: InventoryDeps = {}): Promise<CoreCapability[]> {
    return missingCapabilities(await capabilityInventory({ light: true, ...deps }))
}

export async function capabilityInventory(deps: InventoryDeps = {}): Promise<CapabilityInventory> {
    const now = deps.now ?? Date.now()
    let tools: string[] = []
    try {
        if (deps.light) tools = []
        else if (deps.tools) tools = [...await deps.tools()]
        else {
            const { getToolRegistry } = await import('../tools/complete-registry.js')
            for (const tool of getToolRegistry().getAll()) if (tool?.name) tools.push(tool.name)
        }
    } catch { /* empty register: only what is proven counts */ }

    const connections = deps.light ? new Map<string, string>()
        : await Promise.resolve(deps.connections ? deps.connections() : readConnections(deps.dataDir)).catch(() => new Map<string, string>())
    const connected = new Set([...connections].filter(([, status]) => status === 'verbunden').map(([id]) => id))

    const store = await import('../core/tool-health-store.js')
    let health: readonly ToolHealthEntry[] = []
    try { health = deps.light ? [] : deps.toolHealth ? deps.toolHealth() : store.loadToolHealth() } catch { /* no health data */ }
    const brokenTools = new Set(health.filter(store.isToolUnavailable).map(entry => entry.name))

    const mesh = new Map<Skill, string[]>()
    try {
        const strengths = deps.strengths ? await deps.strengths() : await (await import('../mesh/node-strengths.js')).collectNodeStrengths(now, { registryRemote: false })
        for (const node of strengths) {
            if (!node.online) continue
            for (const skill of node.skills) mesh.set(skill, [...(mesh.get(skill) || []), node.nodeId])
        }
    } catch { /* no mesh view */ }

    let learned: LearnedCapability[] = []
    try {
        if (deps.light) learned = []
        else if (deps.learned) learned = [...await deps.learned()]
        else {
            const { learnedCapabilities } = await import('./capability-learning.js')
            const toolSet = new Set(tools)
            // A learned tool only counts while it is in the register.
            learned = learnedCapabilities({ dataDir: deps.dataDir }).filter(item => !item.tools.length || item.tools.some(name => toolSet.has(name)))
        }
    } catch { /* no learned list */ }

    let cloud: CloudProviderView[] = []
    try { cloud = deps.cloud ? deps.cloud() : (await import('../llm/active-runtime.js')).configuredCloudProviders((globalThis as any).__novaState?.config) } catch { /* no cloud view */ }

    let runtime: CapabilityInventory['runtime']
    try {
        if (deps.runtime) runtime = await deps.runtime()
        else {
            const { describeActiveRuntime } = await import('../llm/active-runtime.js')
            const active = await describeActiveRuntime({ registry: null, meshRuntimes: [], timeoutMs: 1500, probe: deps.probeRuntime === true })
            runtime = { provider: active.provider, kind: active.kind, reachable: active.reachable, keyPresent: active.keyPresent }
        }
    } catch { /* no runtime view */ }

    let embedding: EmbeddingSource = 'notbehelf'
    try {
        if (deps.embedding) embedding = await deps.embedding()
        else if ((mesh.get('embedding') || []).length) embedding = 'echt'
        else {
            const { findInstalledEmbeddingArtifact } = await import('../memory/embedding-artifacts.js')
            if (process.env.XAVENTRA_EMBEDDING_INPROCESS !== '0' && findInstalledEmbeddingArtifact()) embedding = 'echt'
        }
    } catch { /* the hash makeshift stays */ }

    return { tools, connected, learned, connections, brokenTools, mesh, cloud, ...(runtime ? { runtime } : {}), embedding, ...(deps.voiceReady ? { voiceReady: true } : {}) }
}