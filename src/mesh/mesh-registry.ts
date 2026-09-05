/**
 * Nova Mesh Registry — Node Discovery & Coordination
 * 
 * LOCAL-FIRST: Stores mesh data in .nova-data/mesh.json
 * Optional Supabase sync when available.
 * 
 * Features:
 * - Auto-registration on startup
 * - Heartbeat every 60s (marks node as alive)
 * - Node discovery (list all active nodes)
 * - Task delegation to remote nodes via SSH
 * - Dead node cleanup (no heartbeat > 5 min = offline)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { hostname, networkInterfaces, uptime } from 'os'
import { execSync } from 'child_process'
import {
    isActiveNode,
    isNodeVisibleByDefault,
    resolveNodeLifecycle,
    type MeshNodeLifecycle,
} from './mesh-node-lifecycle.js'

// ============================================
// Config
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const MESH_FILE = join(DATA_DIR, 'mesh.json')
const NODE_ID_FILE = join(DATA_DIR, 'instance-id.txt')
// Load Supabase config from nova.config.json (REQUIRED — no hardcoded fallbacks)
function loadSupabaseConfig(): { url: string, key: string } {
    const configPath = join(process.cwd(), 'nova.config.json')
    try {
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.supabase?.meshUrl && config.supabase?.meshKey) {
                return { url: config.supabase.meshUrl, key: config.supabase.meshKey }
            }
        }
    } catch { /* config read error */ }
    // Check env vars as last resort (no hardcoded secrets!)
    if (process.env.NOVA_MESH_SUPABASE_URL && process.env.NOVA_MESH_SUPABASE_KEY) {
        return { url: process.env.NOVA_MESH_SUPABASE_URL, key: process.env.NOVA_MESH_SUPABASE_KEY }
    }
    console.warn('[Mesh] ⚠️ No Supabase config found in nova.config.json (supabase.meshUrl/meshKey) — mesh sync disabled')
    return { url: '', key: '' }
}
const { url: SUPABASE_URL, key: SUPABASE_KEY } = loadSupabaseConfig()
const TABLE = 'nova_mesh_nodes'

// ============================================
// Types
// ============================================

export interface NodeHardware {
    cpu: string
    cores: number
    arch: string
    ram_gb: number
    ram_free_gb?: number
    disk_gb: number
    disk_free_gb: number
    temp?: number
    cpu_load?: number
    ram_used_percent?: number
    gpu?: string
    gpu_vram_mb?: number
    gpu_vram_free_mb?: number
    os_name: string
    os_version: string
}

export interface NodeSoftware {
    node_version: string
    python?: string
    ollama?: string
    ollama_models?: string[]       // Installed Ollama models (e.g. 'gemma3:4b', 'nomic-embed-text')
    embedding_model?: string       // Best available embedding model on this node
    docker?: string
    cuda?: string
    ffmpeg?: boolean
    git?: boolean
    pip_packages?: string[]
    package_managers: string[]   // apt, dnf, pacman, brew, choco, pip, npm
    can_install: string[]        // things this node COULD install if needed
    ai_services?: Array<{
        name: string
        type: string
        endpoint: string
        status: 'running' | 'installed' | 'stopped'
        models: string[]
    }>
}

export interface MeshNode {
    node_id: string
    hostname: string
    ip?: string
    ssh_port?: number
    ssh_user?: string
    platform: string
    version: string
    tools_count: number
    status: 'online' | 'offline' | 'busy'
    capabilities: string[]
    hardware?: NodeHardware
    software?: NodeSoftware
    last_heartbeat: string
    registered_at?: string
    active_mission?: string
    lifecycle_state?: MeshNodeLifecycle
    lifecycle_changed_at?: string
    retired_at?: string
    tombstoned_at?: string
    tombstone_reason?: string
    superseded_by?: string
}

export interface DiscoverNodesOptions {
    includeHistorical?: boolean
    activeOnly?: boolean
}

export interface TaskDelegation {
    id: string
    from_node: string
    to_node: string
    task: string
    status: 'pending' | 'accepted' | 'running' | 'done' | 'failed'
    result?: string
    created_at: number
    run_id?: string
    idempotency_key?: string
    owner_node?: string
    claimed_at?: number
    lease_epoch?: number
    fencing_token?: string
    attempt?: number
    transport?: 'direct' | 'supabase' | 'relay' | 'local' | 'outbox' | 'legacy-supabase'
}

interface MeshData {
    nodes: MeshNode[]
    tasks: TaskDelegation[]
    last_sync?: string
}

// ============================================
// Node Identity
// ============================================

function getNodeId(): string {
    try {
        if (existsSync(NODE_ID_FILE)) {
            return readFileSync(NODE_ID_FILE, 'utf-8').trim()
        }
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        const id = `nova-${randomUUID().slice(0, 8)}`
        writeFileSync(NODE_ID_FILE, id)
        return id
    } catch {
        return `nova-${Date.now()}`
    }
}

const NODE_ID = process.env.NOVA_NODE_ID?.trim() || getNodeId()

export function getLocalNodeId(): string {
    return NODE_ID
}

export function getLocalNodeSnapshot(): MeshNode | undefined {
    const node = loadMeshData().nodes.find(item => item.node_id === NODE_ID)
    return node ? JSON.parse(JSON.stringify(node)) as MeshNode : undefined
}

// ============================================
// Local JSON Storage
// ============================================

function pruneDeadNodes(data: MeshData): MeshData {
    const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
    const now = Date.now()
    const updatedNodes = data.nodes.map(node => {
        if (node.status === 'online' || node.status === 'busy') {
            const lastBeat = node.last_heartbeat ? new Date(node.last_heartbeat).getTime() : 0
            if (now - lastBeat > OFFLINE_THRESHOLD_MS) {
                return { ...node, status: 'offline' as const }
            }
        }
        return node
    })
    return { ...data, nodes: updatedNodes }
}

export function loadMeshData(): MeshData {
    try {
        if (existsSync(MESH_FILE)) {
            const data = JSON.parse(readFileSync(MESH_FILE, 'utf-8'))
            return pruneDeadNodes(data)
        }
    } catch { /* corrupted file */ }
    return { nodes: [], tasks: [] }
}

export function saveMeshData(data: MeshData): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(MESH_FILE, JSON.stringify(data, null, 2))
    } catch (err) {
        console.log(`[Mesh] ⚠ Save failed: ${err}`)
    }
}

// ============================================
// Conflict Resolution
// ============================================

function mergeNodeData(local: Partial<MeshNode>, remote: Partial<MeshNode>): Partial<MeshNode> {
    // Last-write-wins based on heartbeat timestamp
    const localTime = local.last_heartbeat ? new Date(local.last_heartbeat).getTime() : 0
    const remoteTime = remote.last_heartbeat ? new Date(remote.last_heartbeat).getTime() : 0
    if (remoteTime > localTime) {
        // Remote is newer — merge remote fields into local (local overrides for current node data)
        return { ...remote, ...local }
    }
    return local
}

// ============================================
// Supabase Sync (Optional — best-effort)
// ============================================

async function supabaseSync(nodeData: Partial<MeshNode>): Promise<boolean> {
    try {
        const res = await fetch(`${SUPABASE_URL}/${TABLE}?node_id=eq.${encodeURIComponent(NODE_ID)}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
        })
        if (!res.ok) return false

        const existing = await res.json() as any[]
        const method = existing?.length > 0 ? 'PATCH' : 'POST'
        const path = existing?.length > 0 ? `${TABLE}?node_id=eq.${encodeURIComponent(NODE_ID)}` : TABLE

        // Conflict resolution: last-write-wins based on heartbeat timestamp
        let payload = nodeData
        if (method === 'PATCH' && existing.length > 0) {
            payload = mergeNodeData(nodeData, existing[0] as Partial<MeshNode>)
        }

        await fetch(`${SUPABASE_URL}/${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
            },
            body: JSON.stringify(payload),
        })
        return true
    } catch {
        return false
    }
}

// ============================================
// Tailscale IP Detection
// ============================================

function getTailscaleIP(): string | undefined {
    try {
        const ifaces = networkInterfaces()
        for (const [name, addrs] of Object.entries(ifaces)) {
            if (!addrs) continue
            for (const addr of addrs) {
                // Tailscale IPs are in 100.x.x.x range (CGNAT)
                if (addr.family === 'IPv4' && addr.address.startsWith('100.')) {
                    return addr.address
                }
            }
        }
        // Fallback: try `tailscale ip` command
        const result = execSync('tailscale ip -4 2>/dev/null || true', { timeout: 3000, encoding: 'utf-8' }).trim()
        if (result && result.startsWith('100.')) return result
    } catch { /* no tailscale */ }
    return undefined
}

// ============================================
// Node Registration & Heartbeat
// ============================================

let heartbeatInterval: ReturnType<typeof setInterval> | null = null

export async function registerNode(toolsCount: number = 97): Promise<void> {
    const { caps, hardware, software } = scanNodeCapabilities()
    const tailscaleIp = getTailscaleIP()

    const nodeData: MeshNode = {
        node_id: NODE_ID,
        hostname: hostname(),
        ip: tailscaleIp,
        platform: getPlatformLabel(),
        version: (() => { try { return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')).version } catch { return '0.0.0' } })(),
        tools_count: toolsCount,
        status: 'online',
        capabilities: caps,
        hardware,
        software,
        last_heartbeat: new Date().toISOString(),
        registered_at: new Date().toISOString(),
    }

    // Save locally (always works)
    const data = loadMeshData()
    const idx = data.nodes.findIndex(n => n.node_id === NODE_ID)
    if (idx >= 0) {
        data.nodes[idx] = { ...data.nodes[idx], ...nodeData }
    } else {
        data.nodes.push(nodeData)
    }
    saveMeshData(data)

    // Save manifest file for easy inspection
    try {
        writeFileSync(
            join(DATA_DIR, 'node-manifest.json'),
            JSON.stringify({ nodeData, scannedAt: new Date().toISOString() }, null, 2)
        )
    } catch { /* non-critical */ }

    console.log(`[Mesh] ✅ Node registered: ${NODE_ID} (${hostname()}) — ${caps.length} capabilities`)
    console.log(`[Mesh] 💻 HW: ${hardware.cpu} | ${hardware.cores} cores | ${hardware.ram_gb}GB RAM${hardware.gpu ? ` | GPU: ${hardware.gpu}` : ''}`)
    console.log(`[Mesh] 📦 SW: Node ${software.node_version}${software.python ? ` | Python ${software.python}` : ''}${software.ollama ? ` | Ollama ${software.ollama}` : ''}${software.cuda ? ` | CUDA ${software.cuda}` : ''}`)

    // Try Supabase sync (non-blocking)
    supabaseSync(nodeData).then(ok => {
        if (ok) console.log(`[Mesh] 🌐 Synced to Supabase`)
    })

    // Start heartbeat
    if (!heartbeatInterval) {
        heartbeatInterval = setInterval(() => {
            sendHeartbeat()
        }, 60_000)
        console.log(`[Mesh] 💓 Heartbeat started (every 60s)`)
    }
}

function sendHeartbeat(): void {
    const data = loadMeshData()
    const idx = data.nodes.findIndex(n => n.node_id === NODE_ID)

    // Quick sensor read (Linux/Mac/Win fallback)
    let temp: number | undefined
    let cpu_load: number | undefined
    let ram_used_percent: number | undefined
    let ram_free_gb: number | undefined
    let gpu_vram_free_mb: number | undefined
    try {
        if (process.platform === 'linux') {
            const { readFileSync, existsSync } = require('fs')
            if (existsSync('/sys/class/thermal/thermal_zone0/temp')) {
                const tempVal = parseInt(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf-8'))
                if (!isNaN(tempVal)) temp = Math.round(tempVal / 1000)
            }
            if (existsSync('/proc/loadavg')) {
                const load = parseFloat(readFileSync('/proc/loadavg', 'utf-8').split(' ')[0])
                if (!isNaN(load)) cpu_load = load
            }
            if (existsSync('/proc/meminfo')) {
                const meminfo = readFileSync('/proc/meminfo', 'utf-8')
                const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/i)
                const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/i) || meminfo.match(/MemFree:\s+(\d+)\s+kB/i)
                if (totalMatch && availMatch) {
                    const total = parseInt(totalMatch[1])
                    const avail = parseInt(availMatch[1])
                    ram_used_percent = Math.round(((total - avail) / total) * 100)
                    ram_free_gb = Math.round((avail / (1024 * 1024)) * 10) / 10
                }
            }
        } else {
            const os = require('os')
            cpu_load = os.loadavg()[0]
            ram_used_percent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
            ram_free_gb = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10
        }
        try {
            const free = execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1500,
            }).trim().split(/\r?\n/)[0]
            gpu_vram_free_mb = Number.parseInt(free, 10) || undefined
        } catch { /* unified-memory GPUs may not expose a dedicated VRAM counter */ }
    } catch { /* ignore sensor read errors */ }

    let updatedHardware: NodeHardware | undefined

    if (idx >= 0) {
        data.nodes[idx].last_heartbeat = new Date().toISOString()
        data.nodes[idx].status = 'online'

        if (data.nodes[idx].hardware) {
            data.nodes[idx].hardware!.temp = temp
            data.nodes[idx].hardware!.cpu_load = cpu_load
            data.nodes[idx].hardware!.ram_used_percent = ram_used_percent
            data.nodes[idx].hardware!.ram_free_gb = ram_free_gb
            data.nodes[idx].hardware!.gpu_vram_free_mb = gpu_vram_free_mb
            updatedHardware = data.nodes[idx].hardware
        }

        saveMeshData(data)
    }

    // Non-blocking Supabase sync — uptime goes into hardware JSONB (no schema change needed)
    const heartbeatHardware = {
        ...(updatedHardware || {}),
        daemon_uptime_s: Math.round(process.uptime()),
        system_uptime_s: Math.round(uptime()),
    }
    const payload: any = {
        last_heartbeat: new Date().toISOString(),
        status: 'online',
        hardware: heartbeatHardware,
    }

    supabaseSync(payload).catch(() => { })
}

export async function setNodeBusy(missionGoal?: string): Promise<void> {
    const data = loadMeshData()
    const idx = data.nodes.findIndex(n => n.node_id === NODE_ID)
    if (idx >= 0) {
        data.nodes[idx].status = 'busy'
        data.nodes[idx].active_mission = missionGoal || 'running mission'
        data.nodes[idx].last_heartbeat = new Date().toISOString()
        saveMeshData(data)
    }
}

export async function setNodeOnline(): Promise<void> {
    const data = loadMeshData()
    const idx = data.nodes.findIndex(n => n.node_id === NODE_ID)
    if (idx >= 0) {
        data.nodes[idx].status = 'online'
        data.nodes[idx].active_mission = undefined
        data.nodes[idx].last_heartbeat = new Date().toISOString()
        saveMeshData(data)
    }
}

/** Publish locally detected AI runtimes/models so the main node can route to them. */
export async function updateLocalAIServices(services: NonNullable<NodeSoftware['ai_services']>): Promise<void> {
    const data = loadMeshData()
    const idx = data.nodes.findIndex(n => n.node_id === NODE_ID)
    if (idx < 0) return

    const node = data.nodes[idx]
    const advertisedServices = services.map(service => ({
        ...service,
        endpoint: node.ip
            ? service.endpoint.replace(/(?:localhost|127\.0\.0\.1)/, node.ip)
            : service.endpoint,
    }))
    node.software = {
        ...(node.software || { node_version: process.version, package_managers: [], can_install: [] }),
        ai_services: advertisedServices,
    }
    const dynamicCaps = advertisedServices.flatMap(service => [
        `ai:${service.name}`,
        `ai-type:${service.type}`,
        ...service.models.map(model => `model:${model}`),
    ])
    const staticCaps = (node.capabilities || []).filter(capability =>
        !capability.startsWith('ai:') && !capability.startsWith('ai-type:') && !capability.startsWith('model:')
    )
    node.capabilities = [...new Set([...staticCaps, ...dynamicCaps])]
    node.last_heartbeat = new Date().toISOString()
    saveMeshData(data)
    await supabaseSync({ software: node.software, capabilities: node.capabilities, last_heartbeat: node.last_heartbeat, status: node.status })
}

// ============================================
// Node Discovery
// ============================================

export async function discoverNodes(options: DiscoverNodesOptions = {}): Promise<MeshNode[]> {
    const data = loadMeshData()
    const now = Date.now()

    // Merge local nodes into a map
    const nodeMap = new Map<string, MeshNode>()
    for (const n of data.nodes) {
        nodeMap.set(n.node_id, n)
    }

    // Nodes are discovered dynamically via Supabase sync
    // Each node registers itself on startup via registerNode() → supabaseSync()

    // Fetch remote nodes from Supabase
    try {
        const res = await fetch(`${SUPABASE_URL}/${TABLE}?select=*`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
            const remoteNodes = await res.json() as any[]
            for (const rn of remoteNodes) {
                if (!nodeMap.has(rn.node_id)) {
                    // Add remote node not known locally
                    nodeMap.set(rn.node_id, {
                        node_id: rn.node_id,
                        hostname: rn.hostname || 'unknown',
                        ip: rn.ip,
                        platform: rn.platform || 'unknown',
                        version: rn.version || '?',
                        tools_count: rn.tools_count || 0,
                        status: rn.status || 'online',
                        capabilities: rn.capabilities || [],
                        hardware: rn.hardware || undefined,
                        software: rn.software || undefined,
                        last_heartbeat: rn.last_heartbeat || rn.updated_at || new Date().toISOString(),
                        registered_at: rn.registered_at || rn.created_at || new Date().toISOString(),
                        lifecycle_state: rn.lifecycle_state,
                        lifecycle_changed_at: rn.lifecycle_changed_at,
                        retired_at: rn.retired_at,
                        tombstoned_at: rn.tombstoned_at,
                        tombstone_reason: rn.tombstone_reason,
                        superseded_by: rn.superseded_by,
                    })
                } else {
                    // Update local with fresher remote data if available
                    const local = nodeMap.get(rn.node_id)!
                    const remoteTime = new Date(rn.last_heartbeat || rn.updated_at || 0).getTime()
                    const localTime = new Date(local.last_heartbeat).getTime()
                    if (remoteTime > localTime) {
                        local.last_heartbeat = rn.last_heartbeat || rn.updated_at
                        local.status = rn.status || local.status
                        local.tools_count = rn.tools_count || local.tools_count
                    }
                    // Always merge software/hardware if local is missing
                    if (!local.software && rn.software) local.software = rn.software
                    if (!local.hardware && rn.hardware) local.hardware = rn.hardware
                    local.lifecycle_state = rn.lifecycle_state || local.lifecycle_state
                    local.lifecycle_changed_at = rn.lifecycle_changed_at || local.lifecycle_changed_at
                    local.retired_at = rn.retired_at || local.retired_at
                    local.tombstoned_at = rn.tombstoned_at || local.tombstoned_at
                    local.tombstone_reason = rn.tombstone_reason || local.tombstone_reason
                    local.superseded_by = rn.superseded_by || local.superseded_by
                }
            }
        }
    } catch {
        // Supabase unreachable — use local data only
    }

    // Signed Direct Mesh is a first-class discovery source. This keeps direct
    // and HA workers visible even when they deliberately have no Supabase
    // credentials. The peer-state file is written only after envelope policy,
    // signature, and replay validation in mesh-transport-runtime.
    try {
        const peerStates = JSON.parse(readFileSync(join(DATA_DIR, 'mesh-peer-state.json'), 'utf8')) as Record<string, any>
        const config = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf8')) as any
        const directPeers = new Map((config.mesh?.direct?.peers || []).map((peer: any) => [String(peer.nodeId), peer]))
        const updateNames = new Map((config.mesh?.update?.nodes || []).map((node: any) => [String(node.nodeId), String(node.name || node.nodeId)]))
        for (const [nodeId, peerState] of Object.entries(peerStates)) {
            if (!nodeId || nodeId === NODE_ID || !Number.isFinite(Number(peerState?.lastSeen))) continue
            const heartbeat = new Date(Number(peerState.lastSeen)).toISOString()
            const directPeer: any = directPeers.get(nodeId)
            const modern = peerState.capabilities && !peerState.capabilities.snapshot ? peerState.capabilities : undefined
            const legacy = peerState.capabilities?.snapshot?.nodes?.find((node: any) => node.id === nodeId)
            const runtimes = modern?.runtimes || legacy?.runtimes || []
            const software: NodeSoftware = {
                node_version: '?', package_managers: [], can_install: [],
                ai_services: runtimes.map((runtime: any) => ({
                    name: String(runtime.name || runtime.type || 'unknown'),
                    type: String(runtime.type || 'unknown'),
                    endpoint: String(runtime.endpoint || ''),
                    status: ['running', 'installed', 'stopped'].includes(runtime.status) ? runtime.status : 'stopped',
                    models: Array.isArray(runtime.models) ? runtime.models.map(String) : [],
                })),
            }
            let ip: string | undefined
            try { ip = directPeer?.url ? new URL(String(directPeer.url)).hostname : undefined } catch { /* invalid configured URL */ }
            const directNode: MeshNode = {
                node_id: nodeId,
                hostname: String(modern?.hostname || legacy?.hostname || updateNames.get(nodeId) || nodeId),
                ip,
                platform: String(modern?.platform || legacy?.platform || 'unknown'),
                version: '?',
                tools_count: Array.isArray(peerState.tools?.tools) ? peerState.tools.tools.length : 0,
                status: peerState.status === 'busy' ? 'busy' : peerState.status === 'online' ? 'online' : 'offline',
                capabilities: Array.isArray(modern?.capabilities) ? modern.capabilities.map(String) : Array.isArray(legacy?.capabilities) ? legacy.capabilities.map(String) : [],
                hardware: modern?.hardware || legacy?.hardware,
                software,
                last_heartbeat: heartbeat,
                registered_at: heartbeat,
                lifecycle_state: 'active',
            }
            const existing = nodeMap.get(nodeId)
            if (!existing || Date.parse(existing.last_heartbeat) < Number(peerState.lastSeen)) nodeMap.set(nodeId, directNode)
        }
    } catch { /* Direct Mesh has not produced peer evidence yet. */ }

    const classified = Array.from(nodeMap.values()).map(n => {
        const lifecycle = resolveNodeLifecycle({ lastHeartbeat: n.last_heartbeat, lifecycleState: n.lifecycle_state }, now)
        n.lifecycle_state = lifecycle
        if (!isActiveNode(lifecycle)) n.status = 'offline'
        else if (n.status === 'offline') n.status = 'online'
        return n
    })
    if (options.includeHistorical) return classified
    if (options.activeOnly) return classified.filter(node => isActiveNode(node.lifecycle_state!))
    return classified.filter(node => isNodeVisibleByDefault(node.lifecycle_state!))
}

export async function getOnlineNodes(): Promise<MeshNode[]> {
    const all = await discoverNodes({ activeOnly: true })
    return all.filter(n => n.status !== 'offline')
}

export async function getAvailableNodes(): Promise<MeshNode[]> {
    const online = await getOnlineNodes()
    return online.filter(n => n.status === 'online' && n.node_id !== NODE_ID)
}

export function getNodeId_(): string {
    return NODE_ID
}

// ============================================
// Remote Node Management
// ============================================

export function addRemoteNode(nodeId: string, ip: string, sshUser: string = 'root', sshPort: number = 22): void {
    const data = loadMeshData()
    const existing = data.nodes.findIndex(n => n.node_id === nodeId)
    const node: MeshNode = {
        node_id: nodeId,
        hostname: nodeId,
        ip,
        ssh_user: sshUser,
        ssh_port: sshPort,
        platform: 'linux',
        version: '2.20.0',
        tools_count: 0,
        status: 'offline',
        capabilities: [],
        last_heartbeat: new Date().toISOString(),
    }
    if (existing >= 0) {
        data.nodes[existing] = { ...data.nodes[existing], ...node }
    } else {
        data.nodes.push(node)
    }
    saveMeshData(data)
}

const TASKS_TABLE = 'nova_mesh_tasks'
let taskCoordinationSchemaChecked = false

async function ensureTaskCoordinationSchema(): Promise<void> {
    if (taskCoordinationSchemaChecked || !SUPABASE_URL || !SUPABASE_KEY) return
    taskCoordinationSchemaChecked = true
    try {
        const probe = await fetch(`${SUPABASE_URL}/${TASKS_TABLE}?select=id,owner_node,claimed_at,lease_epoch,fencing_token,attempt,run_id,idempotency_key&limit=0`, {
            headers: { apikey: SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }, signal: AbortSignal.timeout(5000),
        })
        if (!probe.ok) console.warn('[Mesh] Coordination schema missing; apply sql/mesh-coordination-v2.sql')
    } catch { console.warn('[Mesh] Could not verify coordination schema; takeover remains fail-closed') }
}

export async function setNodeLifecycle(
    target: string,
    lifecycle: Extract<MeshNodeLifecycle, 'retired' | 'tombstoned'>,
    options: { reason?: string; supersededBy?: string } = {},
): Promise<MeshNode | null> {
    const nodes = await discoverNodes({ includeHistorical: true })
    const node = nodes.find(item =>
        item.node_id === target || item.hostname.toLowerCase() === target.toLowerCase() || item.ip === target,
    )
    if (!node) return null
    if (node.node_id === NODE_ID) throw new Error('the running local node cannot retire or tombstone itself')

    const now = new Date().toISOString()
    const update: Partial<MeshNode> = {
        lifecycle_state: lifecycle,
        lifecycle_changed_at: now,
        status: 'offline',
        ...(lifecycle === 'retired' ? { retired_at: now } : { tombstoned_at: now }),
        ...(options.reason ? { tombstone_reason: options.reason } : {}),
        ...(options.supersededBy ? { superseded_by: options.supersededBy } : {}),
    }

    const data = loadMeshData()
    const localIndex = data.nodes.findIndex(item => item.node_id === node.node_id)
    if (localIndex >= 0) {
        data.nodes[localIndex] = { ...data.nodes[localIndex], ...update }
        saveMeshData(data)
    }

    if (SUPABASE_URL && SUPABASE_KEY) {
        const response = await fetch(`${SUPABASE_URL}/${TABLE}?node_id=eq.${encodeURIComponent(node.node_id)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation',
            },
            body: JSON.stringify(update), signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error(`node lifecycle update failed (${response.status})`)
    }
    return { ...node, ...update }
}

export interface MeshMainAuthority {
    nodeId: string
    hostname?: string
    services: string[]
    epoch: number
    expiresAt: string
}

export async function getMeshMainAuthority(): Promise<MeshMainAuthority | null> {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null
    try {
        const response = await fetch(`${SUPABASE_URL}/nova_mesh_leases?service=in.(nova-main,telegram)&select=service,holder_node_id,holder_hostname,epoch,expires_at&limit=10`, {
            headers: { apikey: SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) return null
        const rows = (await response.json() as Array<any>).filter(row => Date.parse(row.expires_at) > Date.now())
        if (!rows.length) return null
        const canonical = rows.find(row => row.service === 'nova-main')
        if (canonical) {
            const sameHolder = rows.filter(row => row.holder_node_id === canonical.holder_node_id)
            return {
                nodeId: canonical.holder_node_id,
                hostname: canonical.holder_hostname,
                services: sameHolder.map(row => String(row.service)).sort(),
                epoch: Number(canonical.epoch) || 0,
                expiresAt: canonical.expires_at,
            }
        }
        // Compatibility during a rolling upgrade: an active Telegram lease is
        // a better authority signal than counting unrelated task leases.
        const grouped = new Map<string, Array<any>>()
        for (const row of rows) grouped.set(row.holder_node_id, [...(grouped.get(row.holder_node_id) || []), row])
        const [nodeId, leases] = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)[0]
        return {
            nodeId, hostname: leases[0].holder_hostname,
            services: leases.map(row => String(row.service)).sort(),
            epoch: Math.max(...leases.map(row => Number(row.epoch) || 0)),
            expiresAt: leases.map(row => String(row.expires_at)).sort()[0],
        }
    } catch { return null }
}

async function meshRpc<T>(name: string, body: Record<string, unknown>): Promise<{ available: boolean; ok: boolean; value?: T }> {
    try {
        const response = await fetch(`${SUPABASE_URL}/rpc/${name}`, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', apikey: SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        })
        if (response.status === 404 || response.status === 400) return { available: false, ok: false }
        if (!response.ok) return { available: true, ok: false }
        return { available: true, ok: true, value: await response.json() as T }
    } catch { return { available: true, ok: false } }
}

export async function acquireMissionOwnership(missionId: string): Promise<{ ownerNode: string; leaseEpoch: number; fencingToken: string } | null> {
    const { shouldStartExclusiveService, getServiceFencingToken } = await import('./leader-election.js')
    const service = `mission:${missionId}`
    if (!(await shouldStartExclusiveService(service))) return null
    const fence = getServiceFencingToken(service)
    if (!fence) return null
    return { ownerNode: NODE_ID, leaseEpoch: fence.epoch, fencingToken: fence.token }
}

export async function listRecoverableMissionCheckpoints(): Promise<Array<{ missionId: string; checkpoint: string; updatedAt: string }>> {
    if (!SUPABASE_URL || !SUPABASE_KEY) return []
    try {
        const response = await fetch(
            `${SUPABASE_URL}/${TASKS_TABLE}?id=like.mission-*&status=in.(running,accepted)&select=id,task,updated_at&order=updated_at.desc&limit=50`,
            { headers: { apikey: SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }, signal: AbortSignal.timeout(5000) },
        )
        if (!response.ok) return []
        const rows = await response.json() as Array<{ id?: string; task?: string; updated_at?: string }>
        return rows.flatMap(row => {
            if (!row.id?.startsWith('mission-') || !row.task?.startsWith('mission:')) return []
            const checkpoint = row.task.slice('mission:'.length)
            try {
                const parsed = JSON.parse(checkpoint) as { id?: string }
                if (!parsed.id || `mission-${parsed.id}` !== row.id) return []
                return [{ missionId: parsed.id, checkpoint, updatedAt: row.updated_at || '' }]
            } catch { return [] }
        })
    } catch { return [] }
}

export async function publishMissionCheckpoint(mission: Record<string, any>): Promise<boolean> {
    if (!SUPABASE_URL || !SUPABASE_KEY || !mission?.id || !mission?.fencingToken) return false
    const id = `mission-${mission.id}`
    const terminal = mission.status === 'done' || mission.status === 'failed' || mission.status === 'cancelled'
    const status = terminal ? (mission.status === 'done' ? 'done' : 'failed') : mission.status === 'paused' ? 'accepted' : 'running'
    const payload = {
        task: `mission:${JSON.stringify({ ...mission, checkpointAt: Date.now() })}`,
        status, owner_node: mission.ownerNode || NODE_ID, claimed_at: Date.now(),
        lease_epoch: mission.leaseEpoch, fencing_token: mission.fencingToken,
        run_id: mission.id, idempotency_key: `mission:${mission.id}`,
        updated_at: new Date().toISOString(),
    }
    try {
        const patched = await fetch(
            `${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${encodeURIComponent(id)}&fencing_token=eq.${encodeURIComponent(mission.fencingToken)}`,
            {
                method: 'PATCH', headers: {
                    'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation',
                }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
            },
        )
        if (patched.ok && ((await patched.json() as TaskDelegation[]).length === 1)) return true
        const created = await fetch(`${SUPABASE_URL}/${TASKS_TABLE}`, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation',
            }, body: JSON.stringify({
                id, from_node: NODE_ID, to_node: NODE_ID, created_at: Date.now(), ...payload,
            }), signal: AbortSignal.timeout(5000),
        })
        return created.ok
    } catch { return false }
}

export function missionIdFromCheckpoint(serialized: string): string | null {
    try {
        const missionId = String((JSON.parse(serialized) as { id?: string }).id || '')
        return /^[A-Za-z0-9._:-]{1,160}$/.test(missionId) ? missionId : null
    } catch {
        return null
    }
}

export async function delegateTask(
    targetNodeId: string,
    task: string
): Promise<TaskDelegation | null> {
    const delegation: TaskDelegation = {
        id: randomUUID().slice(0, 8),
        from_node: NODE_ID,
        to_node: targetNodeId,
        task,
        status: 'pending',
        created_at: Date.now(),
    }

    // Preferred typed data plane: Direct -> durable Supabase -> Relay -> outbox.
    // This transports an agent contract and never a free shell string.
    try {
        const { sendAgentRequest } = await import('./mesh-transport-runtime.js')
        const sent = await sendAgentRequest(targetNodeId, task, { idempotencyKey: `mesh-task:${delegation.id}` })
        delegation.id = sent.requestId
        delegation.transport = sent.ack.transport
        const local = loadMeshData()
        local.tasks.push(delegation)
        saveMeshData(local)
        if (sent.ack.transport !== 'outbox' && ['delivered', 'queued', 'duplicate'].includes(sent.ack.status)) {
            console.log(`[Mesh] Task ${delegation.id} delegated to ${targetNodeId} via ${sent.ack.transport}`)
            return delegation
        }
    } catch (error) {
        console.warn(`[Mesh] Typed transport unavailable, trying legacy queue: ${String(error).slice(0, 160)}`)
    }

    // Compatibility fallback for nodes that have not received transport-v1.
    if (!SUPABASE_URL || !SUPABASE_KEY) return delegation.transport === 'outbox' ? delegation : null
    try {
        const res = await fetch(`${SUPABASE_URL}/${TASKS_TABLE}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'return=representation',
            },
            body: JSON.stringify({
                id: delegation.id,
                from_node: delegation.from_node,
                to_node: delegation.to_node,
                task: `chat:${delegation.task}`,
                status: 'pending',
                created_at: Date.now(),
            }),
        })
        if (!res.ok) {
            console.error(`[Mesh] ❌ Supabase task insert failed: ${res.status}`)
            return null
        }
        console.log(`[Mesh] 📤 Task ${delegation.id} delegated to ${targetNodeId} via Supabase`)
        delegation.transport = 'legacy-supabase'
    } catch (err) {
        console.error(`[Mesh] ❌ Task delegation failed:`, err)
        return null
    }

    // Also save locally for tracking
    const data = loadMeshData()
    const existing = data.tasks.findIndex(item => item.id === delegation.id)
    if (existing >= 0) data.tasks[existing] = delegation
    else data.tasks.push(delegation)
    saveMeshData(data)

    return delegation
}

export async function checkIncomingTasks(): Promise<TaskDelegation[]> {
    try {
        const res = await fetch(
            `${SUPABASE_URL}/${TASKS_TABLE}?to_node=eq.${encodeURIComponent(NODE_ID)}&status=eq.pending&order=created_at.asc`,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                },
            }
        )
        if (!res.ok) return []
        return await res.json() as TaskDelegation[]
    } catch {
        return []
    }
}

/** Atomically move a pending task to running. PostgREST returns no row when
 * another worker won the compare-and-set, preventing duplicate execution. */
export async function claimTask(task: TaskDelegation): Promise<TaskDelegation | null> {
    await ensureTaskCoordinationSchema()
    const { acquireServiceLease } = await import('./leader-election.js')
    const lease = await acquireServiceLease(`mesh-task:${task.id}`)
    if (!lease.leader || !lease.fencingToken) return null
    const enhanced = {
        status: 'running' as const, owner_node: NODE_ID, claimed_at: Date.now(),
        lease_epoch: lease.epoch, fencing_token: lease.fencingToken,
        attempt: Number(task.attempt || 0) + 1,
    }
    const transactional = await meshRpc<TaskDelegation | null>('nova_claim_mesh_task', {
        p_task_id: task.id, p_node_id: NODE_ID,
        p_fencing_token: lease.fencingToken, p_lease_epoch: lease.epoch,
    })
    if (transactional.available) return transactional.ok && transactional.value ? transactional.value : null
    const perform = async (body: Record<string, unknown>) => fetch(
        `${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${encodeURIComponent(task.id)}&status=eq.pending`,
        {
            method: 'PATCH', headers: {
                'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation',
            }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        },
    )
    try {
        let response = await perform(enhanced)
        // Older installations remain safe: status=eq.pending still gives an
        // atomic claim even before optional evidence columns are migrated.
        if (!response.ok && (response.status === 400 || response.status === 404)) response = await perform({ status: 'running' })
        if (!response.ok) return null
        const rows = await response.json() as TaskDelegation[]
        return rows[0] ? { ...task, ...rows[0], ...enhanced } : null
    } catch { return null }
}

/** Strongest standby recovers abandoned tasks through running -> accepted CAS.
 * The intermediate state is the takeover lock; only one node can win it. */
export async function recoverStaleTasks(staleAfterMs = 15 * 60_000): Promise<TaskDelegation[]> {
    await ensureTaskCoordinationSchema()
    const { acquireServiceLease } = await import('./leader-election.js')
    const takeover = await acquireServiceLease('mesh-task-takeover')
    if (!takeover.leader || !SUPABASE_URL || !SUPABASE_KEY) return []
    try {
        const serverClockRecovery = await meshRpc<TaskDelegation[]>('nova_recover_stale_mesh_tasks_v2', {
            p_node_id: NODE_ID, p_fencing_token: takeover.fencingToken,
            p_lease_epoch: takeover.epoch, p_stale_after_ms: staleAfterMs,
        })
        if (serverClockRecovery.available) return serverClockRecovery.ok ? serverClockRecovery.value || [] : []

        // Compatibility for installations that have not applied v3 yet.
        const cutoff = Date.now() - staleAfterMs
        const transactional = await meshRpc<TaskDelegation[]>('nova_recover_stale_mesh_tasks', {
            p_node_id: NODE_ID, p_fencing_token: takeover.fencingToken,
            p_lease_epoch: takeover.epoch, p_stale_before: cutoff,
        })
        if (transactional.available) return transactional.ok ? transactional.value || [] : []
        const response = await fetch(`${SUPABASE_URL}/${TASKS_TABLE}?status=eq.running&claimed_at=lt.${cutoff}&order=claimed_at.asc`, {
            headers: { apikey: SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }, signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) return []
        const stale = await response.json() as TaskDelegation[]
        const recovered: TaskDelegation[] = []
        for (const task of stale) {
            const locked = await fetch(`${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${encodeURIComponent(task.id)}&status=eq.running`, {
                method: 'PATCH', headers: {
                    'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation',
                }, body: JSON.stringify({ status: 'accepted' }), signal: AbortSignal.timeout(5000),
            })
            const rows = locked.ok ? await locked.json() as TaskDelegation[] : []
            if (!rows[0]) continue
            await fetch(`${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${encodeURIComponent(task.id)}&status=eq.accepted`, {
                method: 'PATCH', headers: {
                    'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal',
                }, body: JSON.stringify({ status: 'pending', to_node: NODE_ID }), signal: AbortSignal.timeout(5000),
            })
            recovered.push({ ...task, status: 'pending', to_node: NODE_ID, fencing_token: takeover.fencingToken, lease_epoch: takeover.epoch })
        }
        return recovered
    } catch { return [] }
}

async function renewTaskClaim(task: TaskDelegation): Promise<boolean> {
    if (!task.fencing_token) return false
    const transactional = await meshRpc<boolean>('nova_renew_mesh_task', {
        p_task_id: task.id, p_node_id: NODE_ID, p_fencing_token: task.fencing_token,
    })
    if (transactional.available) return transactional.ok && transactional.value === true
    try {
        const response = await fetch(
            `${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${encodeURIComponent(task.id)}&status=eq.running&fencing_token=eq.${encodeURIComponent(task.fencing_token)}`,
            {
                method: 'PATCH', headers: {
                    'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation',
                }, body: JSON.stringify({ claimed_at: Date.now() }), signal: AbortSignal.timeout(5000),
            },
        )
        const rows = response.ok ? await response.json() as TaskDelegation[] : []
        return rows.length === 1
    } catch { return false }
}

export async function updateTaskStatus(
    taskId: string,
    status: 'running' | 'done' | 'failed',
    result?: string,
    fencingToken?: string,
): Promise<void> {
    try {
        if (fencingToken && (status === 'done' || status === 'failed')) {
            const transactional = await meshRpc<boolean>('nova_finish_mesh_task', {
                p_task_id: taskId, p_node_id: NODE_ID, p_fencing_token: fencingToken,
                p_status: status, p_result: result || '',
            })
            if (transactional.available) {
                if (!transactional.ok || transactional.value !== true) console.warn(`[Mesh] Fenced task finish rejected: ${taskId}`)
                return
            }
        }
        const body: Record<string, unknown> = { status }
        if (result !== undefined) body.result = result.slice(0, 10000) // cap result size

        const fenceFilter = fencingToken ? `&fencing_token=eq.${encodeURIComponent(fencingToken)}` : ''
        await fetch(`${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${taskId}${fenceFilter}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'return=minimal',
            },
            body: JSON.stringify(body),
        })
        console.log(`[Mesh] 📋 Task ${taskId} → ${status}${result ? ` (${result.length} chars)` : ''}`)
    } catch (err) {
        console.error(`[Mesh] ❌ Task status update failed:`, err)
    }
}

export async function getTaskResult(taskId: string): Promise<TaskDelegation | null> {
    try {
        const { getMeshRunResult } = await import('./mesh-transport-runtime.js')
        const direct = getMeshRunResult(taskId)
        if (direct) return {
            id: taskId, from_node: '', to_node: NODE_ID, task: '', created_at: Date.now(),
            status: direct.success ? 'done' : 'failed', result: direct.success ? JSON.stringify(direct.result) : direct.error,
        }
    } catch { /* direct runtime optional */ }
    try {
        const res = await fetch(
            `${SUPABASE_URL}/${TASKS_TABLE}?id=eq.${taskId}`,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                },
            }
        )
        if (!res.ok) return null
        const tasks = await res.json() as TaskDelegation[]
        return tasks[0] || null
    } catch {
        return null
    }
}

// ============================================
// Task Poller — picks up and executes incoming tasks
// ============================================

let taskPollerRunning = false

export function startTaskPoller(): void {
    if (taskPollerRunning) return
    taskPollerRunning = true

    const POLL_INTERVAL = 30_000  // 30 seconds

    const poll = async (): Promise<void> => {
        try {
            await recoverStaleTasks()
            const tasks = await checkIncomingTasks()
            if (tasks.length === 0) return

            console.log(`[Mesh] 📥 ${tasks.length} incoming task(s) found`)

            for (const task of tasks) {
                console.log(`[Mesh] 🔧 Executing task ${task.id}: ${task.task.slice(0, 80)}`)

                const claimed = await claimTask(task)
                if (!claimed) continue
                const claimHeartbeat = setInterval(() => { void renewTaskClaim(claimed) }, 60_000)
                if (claimHeartbeat.unref) claimHeartbeat.unref()

                try {
                    let output: string
                    let handedOffMission = false

                    // Check if this is a chat task (LLM query) or shell command
                    if (claimed.task.startsWith('mission:')) {
                        const { acceptMissionHandoff } = await import('../core/autonomous-executor.js')
                        const serializedMission = claimed.task.slice('mission:'.length)
                        const missionId = missionIdFromCheckpoint(serializedMission)
                        if (!missionId) throw new Error('Mission handoff rejected because the checkpoint has no valid mission id')
                        // The mesh-task fence protects delivery/claiming. The
                        // native executor additionally needs its own mission
                        // fence so the previous node cannot continue the same
                        // checkpoint after a partition or delayed restart.
                        const missionOwnership = await acquireMissionOwnership(missionId)
                        if (!missionOwnership) throw new Error('Mission handoff rejected because the mission-specific lease is unavailable')
                        const accepted = acceptMissionHandoff(serializedMission, missionOwnership)
                        if (!accepted) throw new Error('Mission handoff rejected because this node already owns another mission or the checkpoint is invalid')
                        handedOffMission = true
                        output = `Mission ${claimed.run_id || claimed.id} resumed from fenced checkpoint at epoch ${missionOwnership.leaseEpoch}`
                    } else if (task.task.startsWith('chat:')) {
                        const prompt = task.task.slice(5).trim()
                        console.log(`[Mesh] 💬 Chat task detected, routing to LLM: "${prompt.slice(0, 60)}"`)

                        try {
                            // 1) Try Nova's unified handler (OpenAI via OAuth)
                            const { handleMessage } = await import('../daemon.js')
                            let response = ''
                            const replyFn = async (msg: string) => { response = msg }
                            await handleMessage('mobile-mesh', `mesh-${task.from_node}`, prompt, replyFn)
                            output = response || ''
                            if (output) {
                                console.log(`[Mesh] 💬 LLM response: ${output.slice(0, 80)}...`)
                            }
                        } catch (apiErr: any) {
                            console.log(`[Mesh] ⚠ API not available: ${apiErr?.message?.slice(0, 60)}`)
                            output = ''
                        }

                        // 2) Fallback: local Ollama
                        if (!output) {
                            try {
                                const ollamaPing = await fetch('http://localhost:11434/api/tags', {
                                    signal: AbortSignal.timeout(2000),
                                }).catch(() => null)

                                if (ollamaPing?.ok) {
                                    console.log(`[Mesh] 💬 Fallback: Using Ollama`)
                                    const ollamaRes = await fetch('http://localhost:11434/api/generate', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            model: 'gemma3:4b',
                                            prompt: `Du bist Nova, eine KI-Assistentin auf Node "${hostname()}". Antworte präzise.\n\nUser: ${prompt}`,
                                            stream: false,
                                        }),
                                        signal: AbortSignal.timeout(120_000),
                                    })
                                    const data = await ollamaRes.json() as { response?: string }
                                    output = data.response || ''
                                }
                            } catch { /* Ollama not available */ }
                        }

                        // 3) Fallback: llama.cpp
                        if (!output) {
                            try {
                                const llamaPing = await fetch('http://localhost:8080/health', {
                                    signal: AbortSignal.timeout(2000),
                                }).catch(() => null)

                                if (llamaPing?.ok) {
                                    console.log(`[Mesh] 💬 Fallback: Using llama.cpp`)
                                    const llamaRes = await fetch('http://localhost:8080/v1/chat/completions', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            messages: [
                                                { role: 'system', content: `Du bist Nova auf Node "${hostname()}". Antworte präzise.` },
                                                { role: 'user', content: prompt },
                                            ],
                                            temperature: 0.7, max_tokens: 512,
                                        }),
                                        signal: AbortSignal.timeout(120_000),
                                    })
                                    const data = await llamaRes.json() as { choices?: { message?: { content?: string } }[] }
                                    output = data.choices?.[0]?.message?.content || ''
                                }
                            } catch { /* llama.cpp not available */ }
                        }

                        if (!output) {
                            output = `⚠️ Kein LLM auf Node "${hostname()}" verfügbar (weder API, Ollama noch llama.cpp)`
                        }
                    } else {
                        throw new Error('Untyped mesh task rejected: raw shell/task strings are not executable')
                    }

                    if (handedOffMission) {
                        console.log(`[Mesh] Mission checkpoint ${task.id} handed to native executor`)
                        continue
                    }
                    await updateTaskStatus(task.id, 'done', output || 'OK (no output)', claimed.fencing_token)
                    console.log(`[Mesh] ✅ Task ${task.id} completed`)
                } catch (err: any) {
                    const errMsg = err?.stderr?.toString() || err?.message || 'Unknown error'
                    await updateTaskStatus(task.id, 'failed', errMsg.slice(0, 5000), claimed.fencing_token)
                    console.error(`[Mesh] Task ${task.id} failed: ${errMsg.slice(0, 200)}`)
                } finally {
                    clearInterval(claimHeartbeat)
                }
            }
        } catch (err) {
            console.error(`[Mesh] Task poller error:`, err)
        }
    }

    // Initial poll after 10s, then every 30s
    setTimeout(poll, 10_000)
    setInterval(poll, POLL_INTERVAL)
    console.log(`[Mesh] 🔄 Task poller started (every ${POLL_INTERVAL / 1000}s)`)
}

export async function completeTask(taskId: string, result: string): Promise<void> {
    const data = loadMeshData()
    const task = data.tasks.find(t => t.id === taskId)
    if (task) {
        task.status = 'done'
        task.result = result
        saveMeshData(data)
    }
}

export async function failTask(taskId: string, error: string): Promise<void> {
    const data = loadMeshData()
    const task = data.tasks.find(t => t.id === taskId)
    if (task) {
        task.status = 'failed'
        task.result = error
        saveMeshData(data)
    }
}

// ============================================
// Full Node Self-Scan (Hardware + Software)
// ============================================

function scanNodeCapabilities(): { caps: string[], hardware: NodeHardware, software: NodeSoftware } {
    const caps: string[] = ['chat', 'tools', 'memory']
    if (String(process.env.NOVA_MAIN_ELIGIBLE || 'true').toLowerCase() === 'false') {
        caps.push('worker-only', 'main-ineligible')
    } else {
        caps.push('main-eligible')
    }

    // --- Platform ---
    if (process.platform === 'win32') caps.push('windows')
    if (process.platform === 'linux') caps.push('linux', 'server')
    if (process.platform === 'darwin') caps.push('macos')

    // --- CPU ---
    let cpuName = 'unknown'
    let cpuCores = 0
    try {
        const os = require('node:os')
        const cpus = os.cpus()
        cpuCores = cpus.length
        cpuName = cpus[0]?.model?.trim() || 'unknown'
    } catch { }
    // ARM fallback: /proc/cpuinfo
    if ((cpuCores === 0 || cpuName === 'unknown') && process.platform === 'linux') {
        try {
            const cpuinfo = readFileSync('/proc/cpuinfo', 'utf-8')
            const processors = cpuinfo.match(/^processor\s/gm)
            if (processors) cpuCores = processors.length
            const modelMatch = cpuinfo.match(/model name\s*:\s*(.+)/i) || cpuinfo.match(/Hardware\s*:\s*(.+)/i)
            if (modelMatch) cpuName = modelMatch[1].trim()
            // Jetson detection
            if (cpuName === 'unknown') {
                const impl = cpuinfo.match(/CPU implementer\s*:\s*0x4e/i)  // NVIDIA
                if (impl) cpuName = 'NVIDIA ARM (Jetson)'
                else {
                    const hw = cpuinfo.match(/Hardware\s*:\s*(.+)/i)
                    if (hw) cpuName = hw[1].trim()
                }
            }
        } catch { }
        // Last resort: nproc
        if (cpuCores === 0) {
            try { cpuCores = parseInt(execSync('nproc', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()) || 0 } catch { }
        }
    }
    if (cpuCores >= 8) caps.push('high-cpu')

    // --- RAM ---
    let ramGb = 0
    try {
        const os = require('node:os')
        ramGb = Math.round(os.totalmem() / (1024 ** 3))
    } catch { }
    // ARM fallback: /proc/meminfo
    if (ramGb === 0 && process.platform === 'linux') {
        try {
            const meminfo = readFileSync('/proc/meminfo', 'utf-8')
            const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/i)
            if (match) ramGb = Math.round(parseInt(match[1]) / (1024 * 1024))
        } catch { }
    }
    if (ramGb >= 16) caps.push('high-ram')

    // --- Disk ---
    let diskGb = 0
    let diskFreeGb = 0
    try {
        if (process.platform === 'win32') {
            const out = execSync('wmic logicaldisk get size,freespace /format:csv', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
            for (const line of out.split('\n')) {
                const parts = line.trim().split(',')
                if (parts.length >= 3 && parts[1]) {
                    diskFreeGb += parseInt(parts[1]) / (1024 ** 3) || 0
                    diskGb += parseInt(parts[2]) / (1024 ** 3) || 0
                }
            }
        } else {
            const out = execSync('df -BG / | tail -1', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
            const parts = out.trim().split(/\s+/)
            diskGb = parseInt(parts[1]) || 0
            diskFreeGb = parseInt(parts[3]) || 0
        }
        diskGb = Math.round(diskGb)
        diskFreeGb = Math.round(diskFreeGb)
    } catch { }

    // --- OS ---
    let osName = process.platform
    let osVersion = ''
    try {
        const os = require('node:os')
        osVersion = os.release()
        if (process.platform === 'linux') {
            try {
                const { readFileSync: rfs, existsSync: efs } = require('node:fs')
                if (efs('/etc/os-release')) {
                    const rel = rfs('/etc/os-release', 'utf-8')
                    const name = rel.match(/PRETTY_NAME="(.+)"/)?.[1]
                    if (name) osName = name
                }
                // Detect Jetson
                if (efs('/etc/nv_tegra_release') || hostname().toLowerCase().includes('jetson')) {
                    caps.push('jetson', 'nvidia-tegra')
                    osName += ' (Jetson)'
                }
                // Detect Raspberry Pi
                try {
                    const model = rfs('/proc/device-tree/model', 'utf-8')
                    if (model.includes('Raspberry Pi')) {
                        caps.push('raspberry-pi')
                        osName += ` (${model.trim().replace(/\0/g, '')})`
                    }
                } catch { }
            } catch { }
        }
    } catch { }

    // --- GPU ---
    let gpuName: string | undefined
    let gpuVramMb: number | undefined
    try {
        const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        }).trim()
        const parts = out.split(',')
        gpuName = parts[0]?.trim()
        gpuVramMb = parseInt(parts[1]?.trim()) || undefined
        caps.push('gpu', 'cuda', 'nvidia')
        if (gpuVramMb && gpuVramMb >= 8000) caps.push('gpu-inference')
    } catch {
        // Check for Jetson GPU (integrated)
        try {
            if (existsSync('/etc/nv_tegra_release')) {
                gpuName = 'NVIDIA Tegra (integrated)'
                caps.push('gpu', 'cuda', 'nvidia', 'jetson-gpu')
                // Get Jetson GPU memory from tegrastats or /proc
                try {
                    const memInfo = execSync('cat /proc/meminfo | grep MemTotal', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
                    // Jetson shares RAM with GPU
                    gpuVramMb = parseInt(memInfo.match(/(\d+)/)?.[1] || '0') / 1024
                } catch { }
            }
        } catch { }
    }

    // --- Software Detection ---
    let pythonVersion: string | undefined
    try {
        pythonVersion = execSync('python3 --version 2>&1 || python --version 2>&1', {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        }).trim().replace('Python ', '')
        caps.push('python')
    } catch { }

    let ollamaVersion: string | undefined
    let ollamaModels: string[] = []
    let embeddingModel: string | undefined
    try {
        ollamaVersion = execSync('ollama --version', {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        }).trim().replace(/ollama version /i, '')
        caps.push('ollama', 'local-llm')

        // List installed Ollama models
        try {
            const listOutput = execSync('ollama list', {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
            })
            // Parse "NAME SIZE MODIFIED" table format
            const lines = listOutput.split('\n').slice(1) // skip header
            for (const line of lines) {
                const modelName = line.trim().split(/\s+/)[0]
                if (modelName && modelName.length > 1) {
                    ollamaModels.push(modelName)
                    caps.push(`model:${modelName}`)

                    // Detect embedding models
                    const lower = modelName.toLowerCase()
                    if (lower.includes('embed') || lower.includes('nomic') || lower.includes('bge') || lower.includes('minilm')) {
                        embeddingModel = modelName
                        caps.push('embeddings', 'vector-search')
                    }
                }
            }
            if (ollamaModels.length > 0) {
                console.log(`[Mesh] 🤖 Ollama models (${ollamaModels.length}): ${ollamaModels.join(', ')}`)
            }
        } catch { /* ollama running but list failed */ }
    } catch { }

    let dockerVersion: string | undefined
    try {
        dockerVersion = execSync('docker --version', {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        }).trim().match(/Docker version ([\d.]+)/)?.[1]
        caps.push('docker')
    } catch { }

    let cudaVersion: string | undefined
    try {
        const nvcc = execSync('nvcc --version 2>&1', {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        })
        cudaVersion = nvcc.match(/release ([\d.]+)/)?.[1]
    } catch {
        // Try nvidia-smi for CUDA version
        try {
            const smi = execSync('nvidia-smi', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
            cudaVersion = smi.match(/CUDA Version: ([\d.]+)/)?.[1]
        } catch { }
    }

    let hasFFmpeg = false
    try { execSync('ffmpeg -version', { stdio: 'pipe', timeout: 3000 }); hasFFmpeg = true; caps.push('ffmpeg', 'media') } catch { }

    let hasGit = false
    try { execSync('git --version', { stdio: 'pipe', timeout: 3000 }); hasGit = true; caps.push('git') } catch { }

    // ADB (Android Debug Bridge — for TV/Beamer control)
    try { execSync('adb version', { stdio: 'pipe', timeout: 3000 }); caps.push('adb') } catch { }

    // SSH client
    try { execSync('ssh -V 2>&1', { stdio: 'pipe', timeout: 3000 }); caps.push('ssh') } catch { }

    // Internet connectivity (quick DNS check)
    try { execSync(process.platform === 'win32' ? 'ping -n 1 -w 1000 8.8.8.8' : 'ping -c 1 -W 1 8.8.8.8', { stdio: 'pipe', timeout: 3000 }); caps.push('internet') } catch { }

    // OpenCV (via python import check)
    if (pythonVersion) {
        try { execSync('python3 -c "import cv2" 2>/dev/null || python -c "import cv2" 2>/dev/null', { stdio: 'pipe', timeout: 5000 }); caps.push('opencv') } catch { }
    }

    // --- TTS/STT binary + Python import detection ---
    // (catches installations from conda, venv, brew, manual — not just pip)
    const ttsBinaries = ['chatterbox', 'chatterbox-server', 'piper', 'piper-tts', 'espeak', 'espeak-ng', 'festival']
    const ttsImports = ['chatterbox', 'chatterbox_tts', 'piper', 'TTS', 'bark', 'f5_tts', 'styletts2']
    const sttBinaries = ['whisper', 'faster-whisper', 'faster-whisper-server', 'vosk-server']
    const sttImports = ['whisper', 'faster_whisper', 'vosk', 'speech_recognition']

    if (!caps.includes('tts')) {
        // Check binaries
        for (const bin of ttsBinaries) {
            try { execSync(`which ${bin} 2>/dev/null`, { stdio: 'pipe', timeout: 2000 }); caps.push('tts'); break } catch { }
        }
        // Check Python imports
        if (!caps.includes('tts') && pythonVersion) {
            for (const mod of ttsImports) {
                try { execSync(`python3 -c "import ${mod}" 2>/dev/null`, { stdio: 'pipe', timeout: 5000 }); caps.push('tts'); break } catch { }
            }
        }
    }

    if (!caps.includes('stt')) {
        for (const bin of sttBinaries) {
            try { execSync(`which ${bin} 2>/dev/null`, { stdio: 'pipe', timeout: 2000 }); caps.push('stt'); break } catch { }
        }
        if (!caps.includes('stt') && pythonVersion) {
            for (const mod of sttImports) {
                try { execSync(`python3 -c "import ${mod}" 2>/dev/null`, { stdio: 'pipe', timeout: 5000 }); caps.push('stt'); break } catch { }
            }
        }
    }

    // Python packages (document reading capabilities)
    let pipPackages: string[] | undefined
    if (pythonVersion) {
        try {
            const out = execSync('python3 -c "import pkg_resources; print(\\";\\".join([p.key for p in pkg_resources.working_set]))" 2>/dev/null || python -c "import pkg_resources; print(\\";\\".join([p.key for p in pkg_resources.working_set]))" 2>/dev/null', {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
            }).trim()
            if (out) {
                const aiRelevant = [
                    // Document Processing
                    'pymupdf', 'python-docx', 'openpyxl', 'python-pptx', 'pillow',
                    // ML Frameworks
                    'torch', 'pytorch', 'tensorflow', 'tensorrt', 'onnxruntime', 'onnx',
                    'transformers', 'accelerate', 'safetensors', 'huggingface-hub',
                    'sentence-transformers', 'openvino',
                    // LLM
                    'vllm', 'exllamav2', 'llama-cpp-python', 'mlx-lm',
                    'comfyui', 'diffusers',
                    // TTS
                    'chatterbox-tts', 'chatterbox', 'piper-tts', 'coqui-tts', 'tts',
                    'bark', 'tortoise-tts', 'f5-tts', 'styletts2', 'espeak-phonemizer',
                    // STT
                    'faster-whisper', 'openai-whisper', 'whisper', 'vosk', 'speechrecognition',
                    // Vision
                    'ultralytics', 'opencv-python', 'opencv-python-headless',
                    'detectron2', 'supervision', 'yolov5',
                    // Embeddings & Vector
                    'chromadb', 'fastembed', 'lancedb',
                    // CUDA / GPU
                    'cuda-bindings', 'nvidia-cuda-runtime-cu12', 'nvidia-cudnn-cu12',
                    'torchvision', 'torchaudio',
                    // Utilities
                    'numpy', 'scipy', 'requests', 'flask', 'fastapi', 'gradio', 'streamlit',
                ]
                pipPackages = out.split(';').filter(p => aiRelevant.includes(p.toLowerCase()))
                if (pipPackages.some(p => ['torch', 'pytorch', 'transformers', 'tensorflow'].includes(p.toLowerCase()))) caps.push('ml-inference')
                if (pipPackages.some(p => ['faster-whisper', 'openai-whisper', 'whisper', 'vosk'].includes(p.toLowerCase()))) caps.push('stt')
                if (pipPackages.some(p => ['chatterbox-tts', 'chatterbox', 'piper-tts', 'coqui-tts', 'bark', 'tts'].includes(p.toLowerCase()))) caps.push('tts')
                if (pipPackages.some(p => ['ultralytics', 'yolov5', 'detectron2'].includes(p.toLowerCase()))) caps.push('vision')
                if (pipPackages.some(p => ['comfyui', 'diffusers'].includes(p.toLowerCase()))) caps.push('image-generation')
                if (pipPackages.some(p => ['vllm', 'exllamav2', 'llama-cpp-python', 'mlx-lm'].includes(p.toLowerCase()))) caps.push('inference-runtime', 'local-llm')
                if (pipPackages.some(p => ['tensorrt', 'onnxruntime'].includes(p.toLowerCase()))) caps.push('inference-runtime')
                if (pipPackages.includes('pymupdf')) caps.push('pdf-reader')
                if (pipPackages.some(p => ['python-docx', 'openpyxl'].includes(p))) caps.push('office-reader')
            }
        } catch { }
    }

    // Vision capability
    if (caps.includes('ollama') || process.env.OPENAI_API_KEY) {
        caps.push('vision')
    }

    // Document reading
    caps.push('document-reader')  // Always available (text at minimum)

    // --- Package Managers ---
    const packageManagers: string[] = []
    const pmChecks: Array<[string, string]> = [
        ['apt', 'apt --version'],
        ['apt-get', 'apt-get --version'],
        ['dnf', 'dnf --version'],
        ['pacman', 'pacman --version'],
        ['brew', 'brew --version'],
        ['choco', 'choco --version'],
        ['snap', 'snap --version'],
        ['pip', 'pip3 --version'],
        ['npm', 'npm --version'],
        ['cargo', 'cargo --version'],
    ]
    for (const [name, cmd] of pmChecks) {
        try { execSync(cmd, { stdio: 'pipe', timeout: 3000 }); packageManagers.push(name) } catch { }
    }
    if (packageManagers.length > 0) caps.push('package-manager')

    // --- What COULD this node install if needed? ---
    const canInstall: string[] = []
    const hasApt = packageManagers.includes('apt') || packageManagers.includes('apt-get')
    const hasBrew = packageManagers.includes('brew')
    const hasChoco = packageManagers.includes('choco')
    const hasPip = packageManagers.includes('pip')

    // Things we know how to install
    if (!ollamaVersion) canInstall.push('ollama')  // curl -fsSL https://ollama.com/install.sh | sh
    if (!dockerVersion && (hasApt || hasBrew)) canInstall.push('docker')
    if (!pythonVersion && (hasApt || hasBrew || hasChoco)) canInstall.push('python')
    if (!hasFFmpeg && (hasApt || hasBrew || hasChoco)) canInstall.push('ffmpeg')
    if (!hasGit && (hasApt || hasBrew || hasChoco)) canInstall.push('git')
    if (pythonVersion && hasPip) {
        // Check which pip packages could be installed
        const installable = ['pymupdf', 'python-docx', 'openpyxl', 'python-pptx', 'pillow', 'requests']
        const installed = (pipPackages || []).map(p => p.toLowerCase())
        for (const pkg of installable) {
            if (!installed.includes(pkg)) canInstall.push(`pip:${pkg}`)
        }
    }
    // Jetson-specific
    if (caps.includes('jetson') && !caps.includes('cuda')) canInstall.push('jetpack-cuda')
    // GPU inference tools
    if (caps.includes('gpu') && !ollamaVersion) canInstall.push('ollama-gpu')

    const hardware: NodeHardware = {
        cpu: cpuName,
        cores: cpuCores,
        arch: process.arch,
        ram_gb: ramGb,
        disk_gb: diskGb,
        disk_free_gb: diskFreeGb,
        gpu: gpuName,
        gpu_vram_mb: gpuVramMb,
        os_name: osName,
        os_version: osVersion,
    }

    const software: NodeSoftware = {
        node_version: process.version,
        python: pythonVersion,
        ollama: ollamaVersion,
        ollama_models: ollamaModels.length > 0 ? ollamaModels : undefined,
        embedding_model: embeddingModel,
        docker: dockerVersion,
        cuda: cudaVersion,
        ffmpeg: hasFFmpeg,
        git: hasGit,
        pip_packages: pipPackages,
        package_managers: packageManagers,
        can_install: canInstall,
    }

    return { caps, hardware, software }
}

// ============================================
// Format for User Display
// ============================================

export function formatMeshStatus(): string {
    return `🌐 *Nova Mesh*\n\nNode ID: \`${NODE_ID}\`\nHostname: ${hostname()}\nPlatform: ${process.platform}\n\n_Nutze mesh_status für Details_`
}

export async function formatMeshNodes(options: { includeHistorical?: boolean } = {}): Promise<string> {
    const nodes = await discoverNodes({ includeHistorical: options.includeHistorical })
    const authority = await getMeshMainAuthority()
    const { getPreferredTakeoverNode } = await import('./leader-election.js')
    const preferred = await getPreferredTakeoverNode()
    if (nodes.length === 0) {
        return options.includeHistorical
            ? '🌐 Keine Nodes in der Registry.'
            : '🌐 Keine aktiven oder kürzlich erreichbaren Nodes. Historie: /nodes all'
    }

    let msg = `🌐 *Nova Mesh — ${nodes.length} ${options.includeHistorical ? 'registrierte' : 'aktuelle'} Node(s)*\n`
    if (authority) msg += `👑 Main: *${authority.hostname || authority.nodeId}* (\`${authority.nodeId}\`) — Lease-Epoche ${authority.epoch}\n`
    else msg += '👑 Main: nicht verifiziert (keine aktive Koordinations-Lease)\n'
    if (preferred) msg += `âš¡ Compute/Failover: *${preferred.hostname || preferred.nodeId}* (\`${preferred.nodeId}\`)\n`
    msg += '\n'

    for (const n of nodes) {
        const isMe = n.node_id === NODE_ID
        const lifecycle = n.lifecycle_state || 'offline'
        const statusIcon = lifecycle === 'active' ? '🟢' : lifecycle === 'offline' ? '🔴' : lifecycle === 'retired' ? '⚫' : '🚫'
        const lastBeat = new Date(n.last_heartbeat)
        const ago = Math.max(0, Math.round((Date.now() - lastBeat.getTime()) / 1000))
        const agoText = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.round(ago / 60)}min` : ago < 86400 ? `${Math.round(ago / 3600)}h` : `${Math.round(ago / 86400)}d`
        msg += `${statusIcon} *${n.hostname}*${isMe ? ' (ich)' : ''} — ${lifecycle}\n`
        msg += `   ID: \`${n.node_id}\` | ${n.platform} | Tools: ${n.tools_count}\n`
        msg += `   Heartbeat: vor ${agoText}\n`
        if (n.superseded_by) msg += `   Ersetzt durch: \`${n.superseded_by}\`\n`
        if (n.tombstone_reason) msg += `   Grund: ${n.tombstone_reason}\n`
        if (n.active_mission && lifecycle === 'active') msg += `   🎯 Mission: ${n.active_mission}\n`
        msg += '\n'
    }
    msg += options.includeHistorical
        ? '_Standardansicht: /nodes · Services: /nodes services_'
        : '_Historie: /nodes all · Services: /nodes services_'
    return msg
}

export async function formatMeshServices(): Promise<string> {
    const lines = ['🧩 *Nova Infrastruktur & AI-Services*', '']
    try {
        const { getMeshTransport } = await import('./mesh-transport-runtime.js')
        const transport = getMeshTransport()
        for (const health of transport?.transportHealth() || []) {
            if (health.name === 'local') continue
            const icon = health.healthy ? '🟢' : '🔴'
            lines.push(`${icon} ${health.name}: ${health.healthy ? 'healthy' : 'unhealthy'}${health.connectedPeers ? ` | Peers ${health.connectedPeers}` : ''}${health.queued ? ` | Queue ${health.queued}` : ''}`)
        }
    } catch { /* runtime may not be initialized in CLI-only mode */ }

    try {
        const config = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf8'))
        const witnesses = config.mesh?.coordination?.witnesses || []
        lines.push(witnesses.length ? `🗳️ Witness: ${witnesses.length}/3 konfiguriert` : '⚪ Witness: nicht konfiguriert')
    } catch { /* config already validated by daemon */ }

    try {
        const { getCapabilityGraph } = await import('./capability-graph.js')
        const snapshot = getCapabilityGraph().getSnapshot()
        const cutoff = Date.now() - 10 * 60_000
        const runtimes = snapshot.nodes.flatMap(node => node.runtimes
            .filter(runtime => runtime.status === 'running' && Date.parse(runtime.verifiedAt) >= cutoff)
            .map(runtime => ({ node: node.hostname, ...runtime })))
        if (runtimes.length) {
            lines.push('', `🤖 *Laufende AI-Runtimes (${runtimes.length}):*`)
            for (const runtime of runtimes) lines.push(`🟢 ${runtime.name} @ ${runtime.node}${runtime.models.length ? ` — ${runtime.models.slice(0, 3).join(', ')}` : ''}`)
        }
    } catch { /* graph optional */ }
    return lines.join('\n')
}

export async function formatNodeDetail(target: string): Promise<string> {
    const nodes = await discoverNodes({ includeHistorical: true })
    const node = nodes.find(n =>
        n.hostname.toLowerCase() === target.toLowerCase() ||
        n.node_id.includes(target.toLowerCase()) ||
        n.ip === target
    )
    if (!node) return `❌ Node "${target}" nicht gefunden.`

    const isMe = node.node_id === NODE_ID
    const statusIcon = node.status === 'online' ? '🟢' : node.status === 'busy' ? '🟡' : '🔴'
    const lastBeat = new Date(node.last_heartbeat)
    const ago = Math.round((Date.now() - lastBeat.getTime()) / 1000)

    let msg = `${statusIcon} *Node: ${node.hostname}*${isMe ? ' (this node)' : ''}\n\n`
    msg += `🆔 ID: \`${node.node_id}\`\n`
    msg += `💻 Platform: ${node.platform}\n`
    msg += `📦 Version: ${node.version}\n`
    msg += `🔧 Tools: ${node.tools_count}\n`
    msg += `📡 Status: ${node.status}\n`
    msg += `💓 Heartbeat: vor ${ago}s\n`
    if (node.ip) msg += `🌐 IP: ${node.ip}\n`
    if (node.ssh_user) msg += `👤 SSH: ${node.ssh_user}@${node.ip}:${node.ssh_port || 22}\n`
    if (node.registered_at) msg += `📅 Registriert: ${new Date(node.registered_at).toLocaleString('de-DE')}\n`
    if (node.active_mission) msg += `🎯 Mission: ${node.active_mission}\n`

    // Hardware info
    if (node.hardware) {
        const hw = node.hardware
        msg += `\n🖥️ *Hardware:*\n`
        msg += `  CPU: ${hw.cpu} (${hw.cores} cores, ${hw.arch})\n`
        msg += `  RAM: ${hw.ram_gb}GB\n`
        msg += `  Disk: ${hw.disk_gb}GB total, ${hw.disk_free_gb}GB frei\n`
        if (hw.gpu) msg += `  GPU: ${hw.gpu}${hw.gpu_vram_mb ? ` (${Math.round(hw.gpu_vram_mb / 1024)}GB VRAM)` : ''}\n`
        msg += `  OS: ${hw.os_name} ${hw.os_version}\n`
    }

    // Software info
    if (node.software) {
        const sw = node.software
        msg += `\n📦 *Software:*\n`
        msg += `  Node.js: ${sw.node_version}\n`
        if (sw.python) msg += `  Python: ${sw.python}\n`
        if (sw.ollama) msg += `  Ollama: ${sw.ollama}\n`
        if (sw.cuda) msg += `  CUDA: ${sw.cuda}\n`
        if (sw.docker) msg += `  Docker: ${sw.docker}\n`
        if (sw.ffmpeg) msg += `  FFmpeg: ✅\n`
        if (sw.pip_packages && sw.pip_packages.length > 0) {
            msg += `  Pip: ${sw.pip_packages.join(', ')}\n`
        }
        if (sw.package_managers && sw.package_managers.length > 0) {
            msg += `  📥 Package Mgr: ${sw.package_managers.join(', ')}\n`
        }
        if (sw.can_install && sw.can_install.length > 0) {
            msg += `\n🔧 *Installierbar bei Bedarf:*\n${sw.can_install.map(c => `  ⬇️ ${c}`).join('\n')}\n`
        }
    }

    msg += `\n🏷️ *Capabilities:*\n${node.capabilities?.map(c => `  • ${c}`).join('\n') || '  keine'}\n`

    if (!isMe && node.ip) {
        msg += `\n*Aktionen:*\n`
        msg += `  /nodes restart ${node.hostname}\n`
        msg += `  /nodes sync ${node.hostname}\n`
        msg += `  /preflight ${node.ip}\n`
    }

    return msg
}

function getPlatformLabel(): string {
    const plat = process.platform
    const arch = process.arch
    if (plat === 'win32') return `Windows ${arch === 'x64' ? 'x64' : arch}`
    if (plat === 'darwin') return `macOS ${arch === 'arm64' ? 'Apple Silicon' : arch}`
    if (plat === 'linux') return `Linux ${arch}`
    return `${plat} ${arch}`
}

// ============================================
// Cleanup
// ============================================

export function stopHeartbeat(): void {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
    }
}

// ============================================
// Export
// ============================================

export default {
    registerNode,
    discoverNodes,
    getOnlineNodes,
    getAvailableNodes,
    getNodeId: getNodeId_,
    delegateTask,
    checkIncomingTasks,
    completeTask,
    failTask,
    setNodeBusy,
    setNodeOnline,
    addRemoteNode,
    loadMeshData,
    saveMeshData,
    formatMeshStatus,
    formatMeshNodes,
    stopHeartbeat,
    startTaskPoller,
    updateTaskStatus,
    claimTask,
    recoverStaleTasks,
    getTaskResult,
    NODE_ID,
}
