/**
 * Nova Brain Installer
 * ====================
 * Installs Graphiti + Neo4j on a chosen Tailscale node.
 *
 * Flow:
 *   1. Scan all online nodes via MeshBrain
 *   2. Filter: only nodes with ≥4GB RAM + Docker or Linux+root
 *   3. Ask user which node to install Brain on
 *   4. SCP brain_api.py + install.sh to the node
 *   5. Run install.sh via SSH
 *   6. Save brainUrl to xaventra.config.json
 *   7. Reload brain-hook plugin config
 */

import { exec, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveConfigPath } from '../config/config-path.js'


const execAsync = promisify(exec)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrainInstallOptions {
    /** Force install even if Brain already running on a node */
    force?: boolean
    /** Port to run Brain API on (default: 8765) */
    port?: number
    /** Neo4j password (default: auto-generated) */
    neo4jPassword?: string
    /** Called with status updates during install */
    onProgress?: (msg: string) => void
}

export interface NodeCandidate {
    name: string
    host: string      // SSH target (user@ip)
    ip: string
    ramGb: number
    os: string
    hasDocker: boolean
    tier: string
    online: boolean
}

export interface BrainInstallResult {
    ok: boolean
    node: string
    brainUrl: string
    neo4jUrl: string
    error?: string
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT_DIR  = join(process.cwd())
const INFRA_DIR = join(ROOT_DIR, 'infra', 'brain')
const CONFIG_PATH = resolveConfigPath(ROOT_DIR)

// ── SSH helper ────────────────────────────────────────────────────────────────

async function sshCmd(host: string, cmd: string, timeout = 30000): Promise<{ stdout: string; stderr: string }> {
    const sshArgs = [
        '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'BatchMode=yes',
        host, cmd,
    ]
    return execAsync(`ssh ${sshArgs.map(a => JSON.stringify(a)).join(' ')}`, { timeout })
}

async function scpFile(localPath: string, host: string, remotePath: string): Promise<void> {
    const cmd = `scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${JSON.stringify(localPath)} ${host}:${JSON.stringify(remotePath)}`
    await execAsync(cmd, { timeout: 60000 })
}

// ── Node capability check ─────────────────────────────────────────────────────

/**
 * Probe a single node to see if it can run Brain.
 * Min requirements: 4GB RAM, Python 3.10+, internet access
 * Preferred: Docker installed (for Neo4j container)
 */
async function probeNode(host: string, name: string): Promise<NodeCandidate | null> {
    try {
        const { stdout } = await sshCmd(host,
            `echo OS=$(uname -s); ` +
            `echo RAM=$(free -m 2>/dev/null | awk '/Mem:/{print $2}' || sysctl hw.memsize 2>/dev/null | awk '{print int($2/1024/1024)}' || echo 0); ` +
            `echo DOCKER=$(command -v docker &>/dev/null && echo yes || echo no); ` +
            `echo PYTHON=$(python3 --version 2>&1 | grep -oP '\\d+\\.\\d+' | head -1 || echo 0)`
        )

        const get = (key: string) => stdout.match(new RegExp(`${key}=(.+)`))?.[1]?.trim() ?? ''

        const ramMb = parseInt(get('RAM') || '0')
        const ramGb = Math.round(ramMb / 1024)
        const hasDocker = get('DOCKER') === 'yes'
        const os = get('OS') || 'linux'
        const ip = host.includes('@') ? host.split('@')[1] : host

        if (ramGb < 3) return null  // Not enough RAM

        return { name, host, ip, ramGb, os, hasDocker, tier: ramGb >= 16 ? 'flagship' : ramGb >= 8 ? 'compute' : 'edge', online: true }
    } catch {
        return null
    }
}

// ── Candidate discovery ───────────────────────────────────────────────────────

/**
 * Get all Tailscale-connected nodes and probe them for Brain compatibility.
 */
export async function findCapableNodes(): Promise<NodeCandidate[]> {
    const candidates: NodeCandidate[] = []

    // Get Tailscale node list
    let tailscaleNodes: Array<{ name: string; ip: string; os: string }> = []
    try {
        const { stdout } = await execAsync('tailscale status --json', { timeout: 8000 })
        const data = JSON.parse(stdout)
        if (data.Self) {
            tailscaleNodes.push({ name: data.Self.HostName || 'self', ip: data.Self.TailscaleIPs?.[0] || '', os: data.Self.OS || '' })
        }
        if (data.Peer) {
            for (const peer of Object.values(data.Peer) as any[]) {
                if (peer.Online) {
                    tailscaleNodes.push({ name: peer.HostName || peer.DNSName?.split('.')[0] || '', ip: peer.TailscaleIPs?.[0] || '', os: peer.OS || '' })
                }
            }
        }
    } catch {
        // Tailscale not available — try config nodes
        try {
            const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
            if (config.nodes) {
                for (const n of config.nodes) {
                    if (n.host && n.host !== 'localhost') {
                        tailscaleNodes.push({ name: n.name, ip: n.host, os: 'linux' })
                    }
                }
            }
        } catch { /* no config nodes */ }
    }

    // Probe each node in parallel (skip Windows nodes — no SSH by default)
    const probePromises = tailscaleNodes
        .filter(n => n.ip && !n.os?.toLowerCase().includes('windows'))
        .map(async n => {
            // Try common SSH users
            for (const user of ['xaventra', 'ubuntu', 'root']) {
                const host = `${user}@${n.ip}`
                const result = await probeNode(host, n.name)
                if (result) return result
            }
            return null
        })

    const results = await Promise.allSettled(probePromises)
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
            candidates.push(r.value)
        }
    }

    // Sort: prefer more RAM + Docker
    return candidates.sort((a, b) => {
        const scoreA = a.ramGb * 10 + (a.hasDocker ? 50 : 0)
        const scoreB = b.ramGb * 10 + (b.hasDocker ? 50 : 0)
        return scoreB - scoreA
    })
}

// ── Install on node ───────────────────────────────────────────────────────────

async function installOnNode(
    node: NodeCandidate,
    opts: BrainInstallOptions
): Promise<BrainInstallResult> {
    const log = opts.onProgress ?? console.log
    const port = opts.port ?? 8765
    const password = opts.neo4jPassword ?? generatePassword()

    log(`🚀 Installing Nova Brain on ${node.name} (${node.host})...`)

    // 1. Create remote install dir
    log('📁 Creating install directory...')
    await sshCmd(node.host, 'mkdir -p ~/.nova/brain')

    // 2. Copy brain_api.py
    log('📦 Uploading brain_api.py...')
    const brainApiSrc = join(INFRA_DIR, 'brain_api.py')
    if (!existsSync(brainApiSrc)) throw new Error(`brain_api.py not found at ${brainApiSrc}`)
    await scpFile(brainApiSrc, node.host, '~/.nova/brain/brain_api.py')

    // 3. Copy install.sh
    log('📦 Uploading install.sh...')
    const installShSrc = join(INFRA_DIR, 'install.sh')
    await scpFile(installShSrc, node.host, '~/.nova/brain/install.sh')
    await sshCmd(node.host, 'chmod +x ~/.nova/brain/install.sh')

    // 4. Run installer
    log('⚙️  Running installer (this takes 2-5 minutes)...')
    const installCmd =
        `cd ~/.nova/brain && ` +
        `BRAIN_PORT=${port} NEO4J_PASSWORD=${JSON.stringify(password)} ` +
        `bash install.sh 2>&1`

    let installOutput = ''
    try {
        const { stdout } = await sshCmd(node.host, installCmd, 300000)  // 5 min timeout
        installOutput = stdout
        log(stdout.slice(-500))  // Show last 500 chars
    } catch (e: any) {
        throw new Error(`Install script failed: ${e.message}`)
    }

    // 5. Parse result from install.sh output
    const resultMatch = installOutput.match(/BRAIN_INSTALL_RESULT=(\{[\s\S]+?\})/)
    let brainUrl = `http://${node.ip}:${port}`
    let neo4jUrl = `bolt://${node.ip}:7687`

    if (resultMatch) {
        try {
            const result = JSON.parse(resultMatch[1])
            if (result.brainUrl) brainUrl = result.brainUrl
            if (result.neo4jUrl) neo4jUrl = result.neo4jUrl
        } catch { /* use defaults */ }
    }

    // 6. Update xaventra.config.json
    log('💾 Saving Brain config...')
    saveBrainConfig(node.name, brainUrl, node.host)

    log(`✅ Brain installed on ${node.name} — ${brainUrl}`)
    return { ok: true, node: node.name, brainUrl, neo4jUrl }
}

// ── Config persistence ────────────────────────────────────────────────────────

function saveBrainConfig(nodeName: string, brainUrl: string, sshHost: string): void {
    try {
        const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))

        // Save Brain node config
        config.brain = {
            enabled: true,
            node: nodeName,
            brainUrl,
            sshHost,
            installedAt: new Date().toISOString(),
        }

        // Update brain-hook plugin config
        if (!config.plugins) config.plugins = {}
        config.plugins['brain-hook'] = {
            ...(config.plugins['brain-hook'] || {}),
            enabled: true,
            brainUrl,
            minScore: 0.65,
            maxResults: 5,
        }

        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
        console.log(`[BrainInstaller] Saved brainUrl=${brainUrl} to xaventra.config.json`)
    } catch (e) {
        console.warn(`[BrainInstaller] Could not save config: ${e}`)
    }
}

function generatePassword(): string {
    return 'nova-' + Math.random().toString(36).slice(2, 10) + '-brain'
}

// ── Check if Brain is already running ────────────────────────────────────────

export async function detectExistingBrain(): Promise<{ running: boolean; url: string | null }> {
    // Check config
    try {
        const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
        const url = config.brain?.brainUrl || config.plugins?.['brain-hook']?.brainUrl
        if (url) {
            // Try to ping it
            try {
                const { stdout } = await execAsync(`curl -s --max-time 4 ${url}/health`, { timeout: 6000 })
                if (stdout.includes('"ok":true')) {
                    return { running: true, url }
                }
            } catch { /* not reachable */ }
            return { running: false, url }
        }
    } catch { /* no config */ }
    return { running: false, url: null }
}

// ── Main installer entry point ────────────────────────────────────────────────

/**
 * Full Brain installation flow.
 * Returns a formatted message string for display to user.
 *
 * @param selectedNodeName  If provided, skip node selection (user already chose)
 */
export async function installBrain(
    opts: BrainInstallOptions & { selectedNodeName?: string } = {}
): Promise<string> {
    const log = opts.onProgress ?? (() => {})

    // 1. Check if already running
    const existing = await detectExistingBrain()
    if (existing.running && !opts.force) {
        return `🧠 Brain läuft bereits unter ${existing.url}\n\nUm neu zu installieren: /brain install --force`
    }

    // 2. Find capable nodes
    log('🔍 Scanne Tailscale-Nodes...')
    const nodes = await findCapableNodes()

    if (nodes.length === 0) {
        return '❌ Keine kompatiblen Nodes gefunden.\nBrain benötigt: Linux/macOS, ≥4GB RAM, Python 3.10+'
    }

    // 3. If node already selected, find it
    let targetNode: NodeCandidate | undefined
    if (opts.selectedNodeName) {
        targetNode = nodes.find(n =>
            n.name.toLowerCase().includes(opts.selectedNodeName!.toLowerCase()) ||
            n.host.includes(opts.selectedNodeName!)
        )
        if (!targetNode) {
            return `❌ Node "${opts.selectedNodeName}" nicht gefunden oder nicht erreichbar.\n\nVerfügbare Nodes:\n${formatNodeList(nodes)}`
        }
    }

    // 4. If no node selected, show selection prompt
    if (!targetNode) {
        return formatNodeSelectionPrompt(nodes)
    }

    // 5. Install
    try {
        const result = await installOnNode(targetNode, opts)
        return formatInstallSuccess(result, targetNode)
    } catch (e: any) {
        return `❌ Installation fehlgeschlagen auf ${targetNode.name}:\n${e.message}`
    }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatNodeList(nodes: NodeCandidate[]): string {
    return nodes.map((n, i) =>
        `${i + 1}. **${n.name}** — ${n.ramGb}GB RAM${n.hasDocker ? ' + Docker' : ''} (${n.tier})`
    ).join('\n')
}

function formatNodeSelectionPrompt(nodes: NodeCandidate[]): string {
    const lines = [
        '🧠 **Nova Brain — Node auswählen**',
        '',
        'Brain (Graphiti + Neo4j) auf welchem Node installieren?',
        '',
    ]

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        const dockerTag = n.hasDocker ? '🐳 Docker' : '⚠️ kein Docker'
        const recommended = i === 0 ? ' ← **empfohlen**' : ''
        lines.push(`**${i + 1}. ${n.name}**${recommended}`)
        lines.push(`   ${n.ramGb}GB RAM | ${dockerTag} | ${n.os} | ${n.tier}`)
        lines.push(`   SSH: ${n.host}`)
        lines.push('')
    }

    lines.push('Antwort: Schreibe die Nummer oder den Node-Namen.')
    lines.push('Beispiel: `1` oder `mac-mini` oder `/brain install mac-mini`')

    return lines.join('\n')
}

function formatInstallSuccess(result: BrainInstallResult, node: NodeCandidate): string {
    return [
        `✅ **Nova Brain installiert auf ${node.name}**`,
        '',
        `🌐 Brain API:  \`${result.brainUrl}\``,
        `🗄️  Neo4j:     \`${result.neo4jUrl}\``,
        '',
        'Was passiert jetzt:',
        '• Nova speichert automatisch wichtige Erkenntnisse im Brain',
        '• Vor jedem LLM-Aufruf sucht der brain-hook nach relevantem Kontext',
        '• Neo4j Web UI: ' + result.brainUrl.replace('8765', '7474'),
        '',
        '`/brain status` — Brain-Status abrufen',
        '`/brain search <query>` — Brain direkt durchsuchen',
    ].join('\n')
}

export default { installBrain, findCapableNodes, detectExistingBrain }
