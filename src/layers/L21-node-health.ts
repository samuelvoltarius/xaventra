/**
 * Layer 21 - Cross-Node Health Monitor
 * 
 * Periodically SSH into configured nodes (Pi5, Jetson, etc.)
 * and collects CPU, RAM, disk, temperature.
 * Alerts via Telegram when thresholds are breached.
 * 
 * Config in nova.config.json:
 * {
 *   "nodes": [
 *     { "name": "Pi5", "host": "xaventra@100.64.0.21", "role": "edge" },
 *     { "name": "Jetson", "host": "xaventra@100.64.0.22", "role": "edge" }
 *   ]
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { NodeIntelligence } from '../mesh/node-intelligence.js'
import { probeHttpService, summarizeReachability, type ServiceProbe } from '../core/health-contract.js'

// ============================================
// Types
// ============================================

export interface NodeConfig {
    name: string
    host: string  // user@ip
    role?: 'main' | 'edge' | 'cloud'
    runtime?: string
    services?: Record<string, string>
}

export interface NodeHealthSnapshot {
    name: string
    host: string
    online: boolean
    reachability?: 'online' | 'degraded' | 'unreachable' | 'offline'
    hostReachable?: boolean
    sshReachable?: boolean
    services?: ServiceProbe[]
    connectionError?: string
    timestamp: number
    cpu?: {
        loadAvg1m: number
        loadAvg5m: number
        cores: number
    }
    memory?: {
        usedMB: number
        totalMB: number
        usedPercent: number
    }
    disk?: {
        usedGB: number
        totalGB: number
        usedPercent: number
    }
    temperature?: number  // Celsius
    uptime?: string
    daemonRunning?: boolean
    warnings: string[]
}

export interface NodeHealthHistory {
    snapshots: NodeHealthSnapshot[]
    lastAlert: Record<string, number>  // node name → last alert timestamp
}

// ============================================
// Thresholds
// ============================================

const THRESHOLDS = {
    diskUsedPercent: 90,      // Warn if disk > 90% used
    memoryUsedPercent: 90,    // Warn if RAM > 90% used
    temperatureCelsius: 80,   // Warn if temp > 80°C
    cpuLoadPerCore: 2.0,      // Warn if load avg > 2x cores
    alertCooldownMs: 30 * 60 * 1000,  // Don't re-alert for 30 min
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000  // Every 5 minutes
const DATA_DIR = join(process.cwd(), '.nova-data')
const HEALTH_FILE = join(DATA_DIR, 'node-health.json')

// ============================================
// SSH Helper
// ============================================

function sshExec(host: string, command: string, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
        const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${host} "${command}"`
        const child = exec(sshCmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`SSH to ${host} failed: ${error.message}`))
                return
            }
            resolve(stdout.trim())
        })
    })
}

// ============================================
// Health Data Collection
// ============================================

async function collectNodeHealth(node: NodeConfig): Promise<NodeHealthSnapshot> {
    const snapshot: NodeHealthSnapshot = {
        name: node.name,
        host: node.host,
        online: false,
        reachability: 'unreachable',
        timestamp: Date.now(),
        warnings: [],
        services: [],
    }

    try {
        // Nova entdeckt das OS und die Befehle selbst — kein hardcoding
        const playbook = await NodeIntelligence.getOrDiscover(node.host, node.name)

        const combined = await sshExec(node.host, playbook.healthCmd)

        snapshot.online = true
        snapshot.reachability = 'online'
        snapshot.hostReachable = true
        snapshot.sshReachable = true

        // Parse sections
        const sections = combined.split(/===(\w+)===/g)
        for (let i = 1; i < sections.length; i += 2) {
            const key = sections[i]
            const value = (sections[i + 1] || '').trim()

            switch (key) {
                case 'UPTIME': {
                    snapshot.uptime = value.replace(/.*up\s+/, '').replace(/,\s*\d+ user.*/, '').trim()
                    break
                }
                case 'CPU': {
                    const lines = value.split('\n')
                    const cores = parseInt(lines[0]) || 1
                    const loadParts = (lines[1] || '').split(' ')
                    snapshot.cpu = {
                        cores,
                        loadAvg1m: parseFloat(loadParts[0]) || 0,
                        loadAvg5m: parseFloat(loadParts[1]) || 0,
                    }
                    if (snapshot.cpu.loadAvg5m > cores * THRESHOLDS.cpuLoadPerCore) {
                        snapshot.warnings.push(`CPU-Last hoch: ${snapshot.cpu.loadAvg5m.toFixed(1)} (${cores} Kerne)`)
                    }
                    break
                }
                case 'MEM': {
                    const parts = value.split(/\s+/)
                    const total = parseInt(parts[1]) || 1
                    const used = parseInt(parts[2]) || 0
                    const percent = Math.round((used / total) * 100)
                    snapshot.memory = { usedMB: used, totalMB: total, usedPercent: percent }
                    if (percent > THRESHOLDS.memoryUsedPercent) {
                        snapshot.warnings.push(`RAM kritisch: ${percent}% belegt (${used}MB/${total}MB)`)
                    }
                    break
                }
                case 'DISK': {
                    const parts = value.split(/\s+/)
                    const totalStr = parts[1] || '0G'
                    const usedStr = parts[2] || '0G'
                    const total = parseInt(totalStr) || 1
                    const used = parseInt(usedStr) || 0
                    const percent = Math.round((used / total) * 100)
                    snapshot.disk = { usedGB: used, totalGB: total, usedPercent: percent }
                    if (percent > THRESHOLDS.diskUsedPercent) {
                        snapshot.warnings.push(`Speicherplatz knapp: ${percent}% belegt (${used}G/${total}G)`)
                    }
                    break
                }
                case 'TEMP': {
                    if (value !== 'N/A') {
                        const tempMilliC = parseInt(value)
                        if (!isNaN(tempMilliC)) {
                            snapshot.temperature = Math.round(tempMilliC / 1000)
                            if (snapshot.temperature > THRESHOLDS.temperatureCelsius) {
                                snapshot.warnings.push(`Temperatur hoch: ${snapshot.temperature}°C`)
                            }
                        }
                    }
                    break
                }
                case 'CHIP': {
                    if (value && value.trim()) {
                        // Store Apple Silicon chip info for routing decisions
                        ;(snapshot as any).chip = value.trim()
                    }
                    break
                }
                case 'DAEMON': {
                    snapshot.daemonRunning = value === 'running'
                    if (!snapshot.daemonRunning) {
                        snapshot.warnings.push('Nova Daemon läuft NICHT!')
                    }
                    break
                }
            }
        }
    } catch (err: any) {
        snapshot.sshReachable = false
        snapshot.connectionError = err.message?.slice(0, 160) || String(err).slice(0, 160)
        const configuredServices = Object.entries(node.services || {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^https?:\/\//.test(entry[1]))
        try {
            const { getLastScanResult } = await import('../mesh/ai-scanner.js')
            const scanned = getLastScanResult()?.services || []
            const nodeHost = node.host.split('@').pop()?.split(':')[0]
            for (const service of scanned) {
                if ((service.host === nodeHost || service.sourceNode === node.name) && service.endpoint
                    && !configuredServices.some(([, endpoint]) => endpoint === service.endpoint)) {
                    configuredServices.push([service.name, service.endpoint])
                }
            }
        } catch { /* scanner is optional during early boot */ }
        snapshot.services = await Promise.all(configuredServices.map(([name, endpoint]) => {
            const url = new URL(endpoint)
            const path = name === 'ollama' ? '/api/tags'
                : name === 'vllm' ? '/v1/models'
                    : name === 'comfyui' ? '/system_stats' : url.pathname
            url.pathname = path
            return probeHttpService(name, url.toString(), 3000)
        }))
        const summary = summarizeReachability({ host: 'unknown', ssh: 'down', services: snapshot.services })
        snapshot.online = summary === 'online' || summary === 'degraded'
        snapshot.reachability = summary === 'degraded' ? 'degraded' : summary === 'offline' ? 'offline' : 'unreachable'
        if (snapshot.online) {
            snapshot.warnings.push(`SSH nicht erreichbar; ${snapshot.services.filter(service => service.state === 'up').length} Dienst(e) antworten weiterhin`)
        } else {
            snapshot.warnings.push(`Erreichbarkeit unbekannt: SSH fehlgeschlagen und kein Dienst antwortet (${snapshot.connectionError})`)
        }
    }

    return snapshot
}

// ============================================
// Uptime Formatter
// ============================================

function formatUptime(daemonSec?: number, systemSec?: number): string {
    const fmt = (s: number): string => {
        if (s < 60) return `${s}s`
        if (s < 3600) return `${Math.floor(s / 60)}min`
        if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`
        return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
    }
    if (daemonSec !== undefined && daemonSec > 0) return `Daemon ${fmt(daemonSec)}`
    if (systemSec !== undefined && systemSec > 0) return `System ${fmt(systemSec)}`
    return '?'
}

// ============================================
// NodeHealthMonitor
// ============================================

class NodeHealthMonitor {
    private nodes: NodeConfig[] = []
    private history: NodeHealthHistory = { snapshots: [], lastAlert: {} }
    private intervalId: ReturnType<typeof setInterval> | null = null
    private alertCallback: ((message: string) => Promise<void>) | null = null
    private lastSnapshots: Map<string, NodeHealthSnapshot> = new Map()

    constructor() {
        this.loadNodesFromConfig() // Sync fallback first
        this.loadHistory()
        // Async mesh discovery will overwrite on first poll
        this.loadNodesFromMesh().catch(() => { })
    }

    private async loadNodesFromMesh(): Promise<void> {
        try {
            const { getOnlineNodes } = await import('../mesh/mesh-registry.js')
            const { hostname } = await import('node:os')
            const meshNodes = await getOnlineNodes()

            // Filter out self-node: skip nodes matching local hostname
            const selfHostname = hostname().toLowerCase()
            const remoteNodes = meshNodes.filter(n => {
                const nodeHost = (n.hostname || n.node_id || '').toLowerCase()
                return nodeHost !== selfHostname
                    && nodeHost !== 'home'  // common local hostname alias
                    && nodeHost !== selfHostname.split('.')[0] // short hostname
            })

            if (remoteNodes.length > 0) {
                // Cross-reference with config to get correct IPs
                // (mesh nodes often don't know their own external IP)
                let configNodes: NodeConfig[] = []
                try {
                    const configPath = join(process.cwd(), 'nova.config.json')
                    if (existsSync(configPath)) {
                        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                        configNodes = config.nodes || []
                    }
                } catch { /* ok */ }

                this.nodes = remoteNodes.map(n => {
                    const nodeName = (n.hostname || n.node_id || '').toLowerCase()
                    // Try to find matching config entry by multiple strategies
                    const configMatch = configNodes.find(c => {
                        const cName = c.name.toLowerCase()
                        const cHost = (c.host || '').toLowerCase()
                        // Strategy 1: Name match (Pi5 === pi5)
                        if (cName === nodeName) return true
                        // Strategy 2: Config name contained in hostname (jetson in xaventra-desktop? no)
                        if (nodeName.includes(cName)) return true
                        // Strategy 3: Config host contains hostname
                        if (cHost.includes(nodeName)) return true
                        // Strategy 4: IP match — extract IP from config host (user@ip)
                        if (n.ip) {
                            const configIp = cHost.split('@')[1] || ''
                            if (configIp === n.ip) return true
                        }
                        // Strategy 5: SSH user match — if only one config node has this user
                        const nodeUser = n.ssh_user || ''
                        if (nodeUser && cHost.startsWith(nodeUser + '@')) {
                            // Check uniqueness: only match if this user is unique among config nodes
                            const sameUserCount = configNodes.filter(cn =>
                                (cn.host || '').toLowerCase().startsWith(nodeUser + '@')
                            ).length
                            if (sameUserCount === 1) return true
                        }
                        return false
                    })
                    // If no match found, try assigning by elimination
                    // (if there are unmatched config nodes, assign the first one)
                    let finalConfigMatch = configMatch
                    if (!finalConfigMatch && configNodes.length > 0) {
                        // Find config nodes not yet matched by any remote node
                        const matchedNames = new Set(
                            remoteNodes
                                .filter(rn => rn !== n)
                                .map(rn => {
                                    const rName = (rn.hostname || rn.node_id || '').toLowerCase()
                                    return configNodes.find(c => c.name.toLowerCase() === rName)?.name
                                })
                                .filter(Boolean)
                        )
                        const unmatched = configNodes.filter(c => !matchedNames.has(c.name))
                        if (unmatched.length === 1) {
                            finalConfigMatch = unmatched[0]
                            console.log(`[L21] 🔗 Matched "${nodeName}" → config "${finalConfigMatch.name}" by elimination`)
                        }
                    }
                    // Prefer config host (has correct IP), fallback to mesh data
                    const host = finalConfigMatch?.host || `${n.ssh_user || 'xaventra'}@${n.ip || n.hostname}`
                    return {
                        name: finalConfigMatch?.name || n.hostname || n.node_id,
                        host,
                        role: (finalConfigMatch?.role || 'edge') as 'edge' | 'main',
                        runtime: finalConfigMatch?.runtime || (n as any).runtime,
                        services: finalConfigMatch?.services,
                    }
                })
                console.log(`[L21] 🌐 ${remoteNodes.length} remote Nodes aus Mesh-Registry geladen (${meshNodes.length - remoteNodes.length} self/local übersprungen)`)
                return
            }
        } catch {
            // Mesh not available — fallback
        }

        // Fallback: config.nodes[]
        this.loadNodesFromConfig()
    }

    private loadNodesFromConfig(): void {
        try {
            const configPath = join(process.cwd(), 'nova.config.json')
            if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                this.nodes = config.nodes || []
                if (this.nodes.length > 0) {
                    console.log(`[L21] 📋 ${this.nodes.length} Nodes aus config geladen (Fallback)`)
                }
            }
        } catch { /* non-critical */ }
    }

    private loadHistory(): void {
        try {
            if (existsSync(HEALTH_FILE)) {
                this.history = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'))
            }
        } catch { /* non-critical */ }
    }

    private saveHistory(): void {
        try {
            if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
            // Keep only last 24h of snapshots
            const cutoff = Date.now() - (24 * 60 * 60 * 1000)
            this.history.snapshots = this.history.snapshots.filter(s => s.timestamp > cutoff)
            writeFileSync(HEALTH_FILE, JSON.stringify(this.history, null, 2))
        } catch { /* non-critical */ }
    }

    setAlertCallback(cb: (message: string) => Promise<void>): void {
        this.alertCallback = cb
    }

    async checkAllNodes(): Promise<NodeHealthSnapshot[]> {
        const results: NodeHealthSnapshot[] = []
        const coveredHosts = new Set<string>()

        // ── Pass 1: Nodes that self-register via mesh heartbeat ──
        try {
            const { discoverNodes } = await import('../mesh/mesh-registry.js')
            const allNodes = await discoverNodes()
            const selfHostname = (await import('node:os')).hostname().toLowerCase()

            for (const n of allNodes) {
                const nodeHost = (n.hostname || n.node_id || '').toLowerCase()
                if (nodeHost === selfHostname || nodeHost === 'home' || nodeHost === selfHostname.split('.')[0]) {
                    continue // Skip localhost
                }

                const hardware = n.hardware
                let diskPercent = 0
                if (hardware?.disk_gb && hardware?.disk_free_gb) {
                    const used = hardware.disk_gb - hardware.disk_free_gb
                    diskPercent = Math.round((used / hardware.disk_gb) * 100)
                }

                const warnings: string[] = []
                if (hardware?.ram_used_percent && hardware.ram_used_percent > THRESHOLDS.memoryUsedPercent) {
                    warnings.push(`RAM kritisch: ${hardware.ram_used_percent}% belegt`)
                }
                if (hardware?.temp && hardware.temp > THRESHOLDS.temperatureCelsius) {
                    warnings.push(`Temperatur hoch: ${hardware.temp}°C`)
                }
                if (hardware?.cpu_load && hardware?.cores && hardware.cpu_load > hardware.cores * THRESHOLDS.cpuLoadPerCore) {
                    warnings.push(`CPU-Last hoch: ${hardware.cpu_load.toFixed(1)} (${hardware.cores} Kerne)`)
                }
                if (diskPercent > THRESHOLDS.diskUsedPercent) {
                    warnings.push(`Speicherplatz knapp: ${diskPercent}% belegt`)
                }

                const snapshot: NodeHealthSnapshot = {
                    name: n.hostname || n.node_id,
                    host: n.ip || n.hostname,
                    online: n.status === 'online',
                    reachability: n.status === 'online' ? 'online' : 'offline',
                    timestamp: new Date(n.last_heartbeat).getTime(),
                    daemonRunning: n.status === 'online',
                    uptime: formatUptime((hardware as any)?.daemon_uptime_s, (hardware as any)?.system_uptime_s),
                    warnings,
                    memory: hardware?.ram_used_percent !== undefined ? { totalMB: (hardware.ram_gb || 0) * 1024, usedMB: Math.round((hardware.ram_gb || 0) * 1024 * (hardware.ram_used_percent / 100)), usedPercent: hardware.ram_used_percent } : undefined,
                    disk: hardware?.disk_gb ? { totalGB: hardware.disk_gb, usedGB: hardware.disk_gb - (hardware.disk_free_gb || 0), usedPercent: diskPercent } : undefined,
                    temperature: hardware?.temp,
                    cpu: hardware?.cores ? { cores: hardware.cores, loadAvg1m: hardware.cpu_load || 0, loadAvg5m: 0 } : undefined
                }

                results.push(snapshot)
                coveredHosts.add(n.ip || n.hostname || '')
                this.lastSnapshots.set(snapshot.name, snapshot)
                this.history.snapshots.push(snapshot)
                if (snapshot.warnings.length > 0) await this.handleWarnings(snapshot)
            }
        } catch (err) {
            console.log(`[L21] Mesh registry read failed: ${err}`)
        }

        // ── Pass 2: Config nodes not covered by mesh (Pi5, Jetson, Macs without Nova) ──
        // These are SSH-probed directly — Nova discovers their OS/commands herself
        const sshNodes = this.nodes.filter(n => {
            if ((n as any).enabled === false) return false       // explicitly disabled
            if (!n.host || !n.host.includes('@')) return false   // needs user@host
            if (n.host === 'localhost' || n.host === '127.0.0.1') return false
            const ip = n.host.split('@')[1] || n.host
            return !coveredHosts.has(ip)
        })

        if (sshNodes.length > 0) {
            const sshResults = await Promise.allSettled(
                sshNodes.map(node => this.checkSshNode(node))
            )
            for (const r of sshResults) {
                if (r.status === 'fulfilled') {
                    results.push(r.value)
                    this.lastSnapshots.set(r.value.name, r.value)
                    this.history.snapshots.push(r.value)
                    if (r.value.warnings.length > 0) await this.handleWarnings(r.value)
                }
            }
        }

        this.saveHistory()
        return results
    }

    /**
     * SSH-probe a single node using NodeIntelligence playbook.
     * Triggers auto-discovery when node first comes online or playbook is stale.
     * Detects online→offline transitions to avoid overwriting good playbooks with empty data.
     */
    private async checkSshNode(node: NodeConfig): Promise<NodeHealthSnapshot> {
        const wasOnline = this.lastSnapshots.get(node.name)?.online ?? null

        const snapshot = await collectNodeHealth(node)

        // Node just came online (was offline or unknown) → force fresh discovery
        if (snapshot.online && wasOnline === false) {
            console.log(`[L21] 🔄 ${node.name} ist wieder online — starte Neu-Entdeckung...`)
            NodeIntelligence.discover(node.host, node.name).catch((e: unknown) => {
                console.log(`[L21] Re-discovery ${node.name} failed: ${e}`)
            })
        }

        return snapshot
    }

    private async handleWarnings(snapshot: NodeHealthSnapshot): Promise<void> {
        const lastAlert = this.history.lastAlert[snapshot.name] || 0
        const cooldownOk = (Date.now() - lastAlert) > THRESHOLDS.alertCooldownMs

        const remainingWarnings = snapshot.warnings
        if (remainingWarnings.length === 0 || !cooldownOk) {
            if (!cooldownOk && remainingWarnings.length > 0) {
                console.log(`[L21] ⚠️ ${snapshot.name} has warnings but alert cooldown active`)
            }
            return
        }

        const warningText = [
            `⚠️ *${snapshot.name}* — Probleme erkannt:`,
            '',
            ...remainingWarnings.map(w => `• ${w}`),
            '',
            snapshot.temperature ? `🌡️ Temperatur: ${snapshot.temperature}°C` : '',
            snapshot.memory ? `💾 RAM: ${snapshot.memory.usedPercent}%` : '',
            snapshot.disk ? `💿 Disk: ${snapshot.disk.usedPercent}%` : '',
        ].filter(l => l !== '').join('\n')

        console.log(`[L21] 🚨 Sending alert for ${snapshot.name}: ${remainingWarnings.join(', ')}`)
        this.history.lastAlert[snapshot.name] = Date.now()
        this.saveHistory()

        if (this.alertCallback) {
            try {
                await this.alertCallback(warningText)
            } catch (err) {
                console.log(`[L21] Alert delivery failed: ${err}`)
            }
        }
    }

    start(): void {
        if (this.intervalId) return
        if (this.nodes.length === 0) {
            console.log('[L21] No nodes configured — skipping health monitor')
            return
        }

        console.log(`[L21] 🏥 Node Health Monitor started — checking ${this.nodes.length} nodes every ${CHECK_INTERVAL_MS / 60000}min`)

        // First check after 30s (let boot complete)
        setTimeout(() => this.checkAllNodes(), 30000)

        // Then every 5 minutes
        this.intervalId = setInterval(() => this.checkAllNodes(), CHECK_INTERVAL_MS)
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }

    getLastSnapshots(): NodeHealthSnapshot[] {
        return [...this.lastSnapshots.values()]
    }

    formatStatus(): string {
        const snapshots = this.getLastSnapshots()
        if (snapshots.length === 0) return '📡 Keine Node-Daten verfügbar'

        const lines = ['🏥 *Nova Mesh — Node Status*', '']

        for (const s of snapshots) {
            const status = s.online ? '🟢' : s.reachability === 'unreachable' ? '🟡' : '🔴'
            const daemon = s.daemonRunning ? '✅' : '❌'
            lines.push(`${status} *${s.name}* (${s.host.split('@')[1] || s.host})`)
            if (s.online) {
                lines.push(`   Daemon: ${daemon} | Uptime: ${s.uptime || '?'}`)
                if (s.cpu) lines.push(`   CPU: ${s.cpu.loadAvg1m.toFixed(1)} load (${s.cpu.cores} cores)`)
                if (s.memory) lines.push(`   RAM: ${s.memory.usedPercent}% (${s.memory.usedMB}MB/${s.memory.totalMB}MB)`)
                if (s.disk) lines.push(`   Disk: ${s.disk.usedPercent}% (${s.disk.usedGB}G/${s.disk.totalGB}G)`)
                if (s.temperature) lines.push(`   Temp: ${s.temperature}°C`)
                if (s.warnings.length > 0) {
                    lines.push(`   ⚠️ ${s.warnings.join(', ')}`)
                }
            } else {
                lines.push(s.reachability === 'unreachable'
                    ? `   ⚠️ Von diesem Nova-Node nicht erreichbar${s.connectionError ? `: ${s.connectionError}` : ''}`
                    : '   ❌ Node meldet sich nicht im Mesh')
            }
            lines.push('')
        }

        return lines.join('\n')
    }
}

// ============================================
// Singleton
// ============================================

let monitor: NodeHealthMonitor | null = null

export function getNodeHealthMonitor(): NodeHealthMonitor {
    if (!monitor) {
        monitor = new NodeHealthMonitor()
    }
    return monitor
}

export default { NodeHealthMonitor, getNodeHealthMonitor }
