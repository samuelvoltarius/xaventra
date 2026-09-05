/**
 * Nova Capability Router
 *
 * General-purpose runtime-dependency resolver.
 * When Nova needs a tool/package that isn't installed locally, it:
 *   1. Checks all mesh nodes for existing capability
 *   2. Scores each node (power, OS match, already-installed)
 *   3. Either routes the task TO that node, or auto-installs on best node
 *   4. Returns a resolved handle: { node, installed, runRemotely }
 *
 * Works for: Python packages, npm packages, system binaries, Docker images, etc.
 */

import { execSync, execFileSync } from 'node:child_process'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface CapabilityQuery {
    /** Human-readable name, e.g. "Whisper", "ffmpeg", "llama.cpp" */
    name: string
    /** How to check if it's available locally */
    check: CapabilityCheck
    /** How to install it (ordered by preference) */
    install: InstallMethod[]
    /** Minimum RAM required in GB (for routing decision) */
    minRamGb?: number
    /** Preferred platform (linux, darwin, win32) */
    preferPlatform?: string
}

export interface CapabilityCheck {
    /** Type of check */
    type: 'python_import' | 'which' | 'node_module' | 'http_probe' | 'command'
    /** What to check (module name, binary name, URL, command) */
    value: string
}

export interface InstallMethod {
    type: 'pip' | 'pip3' | 'npm' | 'apt' | 'brew' | 'shell'
    command: string
    /** Platform this install works on (optional) */
    platform?: string
}

export interface CapabilityResolution {
    /** The winning node (null = local) */
    node: null | { id: string; ip: string; hostname: string; platform: string }
    /** Whether install was triggered */
    installed: boolean
    /** Whether the task should be run remotely via SSH */
    runRemotely: boolean
    /** SSH prefix for remote execution, e.g. "ssh user@ip" */
    sshPrefix: string
    /** Error message if resolution failed */
    error?: string
}

// ============================================
// Local capability check
// ============================================

function checkLocal(check: CapabilityCheck): boolean {
    try {
        switch (check.type) {
            case 'python_import':
                execSync(`python3 -c "import ${check.value}"`, { stdio: 'ignore', timeout: 5000 })
                return true
            case 'which':
                execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${check.value}`, { stdio: 'ignore', timeout: 5000 })
                return true
            case 'node_module':
                require.resolve(check.value)
                return true
            case 'command':
                execSync(check.value, { stdio: 'ignore', timeout: 5000 })
                return true
            case 'http_probe':
                // sync http check via node
                execSync(`node -e "require('http').get('${check.value}', () => process.exit(0)).on('error', () => process.exit(1))"`, { timeout: 5000 })
                return true
        }
    } catch { }
    return false
}

// ============================================
// Remote capability check
// ============================================

async function checkRemote(ip: string, check: CapabilityCheck): Promise<boolean> {
    const ssh = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 xaventra@${ip}`
    try {
        let cmd = ''
        switch (check.type) {
            case 'python_import':
                cmd = `python3 -c "import ${check.value}" 2>/dev/null && echo ok`
                break
            case 'which':
                cmd = `which ${check.value} 2>/dev/null && echo ok`
                break
            case 'command':
                cmd = `${check.value} 2>/dev/null && echo ok`
                break
            default:
                return false
        }
        const result = execSync(`${ssh} '${cmd}'`, { timeout: 8000 }).toString()
        return result.includes('ok')
    } catch {
        return false
    }
}

// ============================================
// Score a node for a capability query
// ============================================

function scoreNode(node: any, query: CapabilityQuery): number {
    let score = 0
    if (node.status !== 'online') return -1

    // Prefer Linux for Python/AI workloads
    const plat = (node.platform || '').toLowerCase()
    if (query.preferPlatform && plat.includes(query.preferPlatform)) score += 30
    if (plat.includes('linux') || plat.includes('arm')) score += 20

    // RAM score (more is better for AI)
    const ramGb = node.hardware?.ram_gb || 0
    if (query.minRamGb && ramGb < query.minRamGb) return -1 // Not enough RAM
    score += Math.min(ramGb, 32) // cap at 32GB for scoring

    // CPU/GPU bonus
    if ((node.hardware?.gpu || '').toLowerCase().includes('cuda')) score += 50
    if ((node.hardware?.gpu || '').toLowerCase().includes('nvidia')) score += 40
    if ((node.capabilities || []).includes('gpu')) score += 30

    // Bonus for already-capable nodes (Jetson = AI node, Pi5 = edge)
    const hostname = (node.hostname || '').toLowerCase()
    if (hostname.includes('jetson') || hostname.includes('desktop')) score += 20
    if (hostname.includes('pi') || hostname.includes('pi5')) score += 10

    return score
}

// ============================================
// Try to install locally
// ============================================

async function installLocal(methods: InstallMethod[]): Promise<boolean> {
    for (const method of methods) {
        if (method.platform && method.platform !== process.platform) continue
        try {
            console.log(`[CapabilityRouter] 🔧 Trying local install: ${method.command}`)
            execSync(method.command, { timeout: 180_000, stdio: 'pipe' })
            console.log(`[CapabilityRouter] ✅ Local install succeeded: ${method.command}`)
            return true
        } catch (err) {
            console.log(`[CapabilityRouter] ⚠️ Local install failed (${method.type}): ${err}`)
        }
    }
    return false
}

// ============================================
// Try to install on a remote node
// ============================================

async function installRemote(ip: string, methods: InstallMethod[], platform = 'linux'): Promise<boolean> {
    const ssh = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 xaventra@${ip}`
    for (const method of methods) {
        if (method.platform && !platform.includes(method.platform)) continue
        if (method.type === 'apt' || method.type === 'pip' || method.type === 'pip3' || method.type === 'shell') {
            try {
                console.log(`[CapabilityRouter] 🔧 Remote install on ${ip}: ${method.command}`)
                execSync(`${ssh} '${method.command}'`, { timeout: 180_000, stdio: 'pipe' })
                console.log(`[CapabilityRouter] ✅ Remote install succeeded on ${ip}`)
                return true
            } catch (err) {
                console.log(`[CapabilityRouter] ⚠️ Remote install failed on ${ip}: ${err}`)
            }
        }
    }
    return false
}

// ============================================
// Main resolver
// ============================================

/**
 * Resolve a capability:
 * - Check locally first
 * - If not available, scan mesh for best node
 * - If found on mesh, return that node for routing
 * - If not found anywhere, try to install on the best node
 * - Returns how to proceed
 */
export async function resolveCapability(query: CapabilityQuery): Promise<CapabilityResolution> {
    console.log(`[CapabilityRouter] 🔍 Resolving: ${query.name}`)

    // 1. Check local
    if (checkLocal(query.check)) {
        console.log(`[CapabilityRouter] ✅ ${query.name} available locally`)
        return { node: null, installed: false, runRemotely: false, sshPrefix: '' }
    }

    console.log(`[CapabilityRouter] ⚠️ ${query.name} not available locally — checking mesh...`)

    // 2. Fetch mesh nodes
    let meshNodes: any[] = []
    try {
        const { discoverNodes } = await import('../mesh/mesh-registry.js')
        meshNodes = await discoverNodes()
    } catch {
        // Mesh unavailable — try to install locally
    }

    // 3. Score and sort nodes
    const scored = meshNodes
        .map(n => ({ node: n, score: scoreNode(n, query) }))
        .filter(s => s.score >= 0)
        .sort((a, b) => b.score - a.score)

    // 4. Check if any node already has the capability
    for (const { node } of scored) {
        if (!node.ip) continue
        const has = await checkRemote(node.ip, query.check)
        if (has) {
            console.log(`[CapabilityRouter] ✅ ${query.name} found on mesh node: ${node.hostname || node.ip}`)
            return {
                node: { id: node.node_id, ip: node.ip, hostname: node.hostname || node.ip, platform: node.platform || 'linux' },
                installed: false,
                runRemotely: true,
                sshPrefix: `ssh -o StrictHostKeyChecking=no xaventra@${node.ip}`,
            }
        }
    }

    // 5. No node has it — try to install on best node or locally
    const bestNode = scored[0]?.node

    // Try local install first (if Windows or same OS)
    const localInstalled = await installLocal(query.install)
    if (localInstalled) {
        return { node: null, installed: true, runRemotely: false, sshPrefix: '' }
    }

    // Try mesh install on best node
    if (bestNode?.ip) {
        const remoteInstalled = await installRemote(bestNode.ip, query.install, bestNode.platform || 'linux')
        if (remoteInstalled) {
            return {
                node: { id: bestNode.node_id, ip: bestNode.ip, hostname: bestNode.hostname, platform: bestNode.platform || 'linux' },
                installed: true,
                runRemotely: true,
                sshPrefix: `ssh -o StrictHostKeyChecking=no xaventra@${bestNode.ip}`,
            }
        }
    }

    // 6. Failed entirely
    return {
        node: null,
        installed: false,
        runRemotely: false,
        sshPrefix: '',
        error: `Could not resolve ${query.name} on any node.`,
    }
}

// ============================================
// Pre-built capability definitions
// ============================================

export const CAPABILITIES = {
    whisper: (): CapabilityQuery => ({
        name: 'OpenAI Whisper (STT)',
        check: { type: 'python_import', value: 'whisper' },
        install: [
            { type: 'pip3', command: 'pip3 install openai-whisper --quiet' },
            { type: 'pip', command: 'pip install openai-whisper --quiet' },
        ],
        minRamGb: 2,
        preferPlatform: 'linux',
    }),

    ffmpeg: (): CapabilityQuery => ({
        name: 'ffmpeg',
        check: { type: 'which', value: 'ffmpeg' },
        install: [
            { type: 'apt', command: 'sudo apt-get install -y ffmpeg', platform: 'linux' },
            { type: 'brew', command: 'brew install ffmpeg', platform: 'darwin' },
            { type: 'shell', command: 'choco install ffmpeg -y', platform: 'win32' },
        ],
    }),

    ollama: (): CapabilityQuery => ({
        name: 'Ollama (LLM runtime)',
        check: { type: 'http_probe', value: 'http://localhost:11434' },
        install: [
            { type: 'shell', command: 'curl -fsSL https://ollama.com/install.sh | sh', platform: 'linux' },
        ],
        minRamGb: 4,
        preferPlatform: 'linux',
    }),

    yt_dlp: (): CapabilityQuery => ({
        name: 'yt-dlp (video downloader)',
        check: { type: 'which', value: 'yt-dlp' },
        install: [
            { type: 'pip3', command: 'pip3 install yt-dlp --quiet' },
            { type: 'pip', command: 'pip install yt-dlp --quiet' },
        ],
    }),

    imagemagick: (): CapabilityQuery => ({
        name: 'ImageMagick',
        check: { type: 'which', value: 'convert' },
        install: [
            { type: 'apt', command: 'sudo apt-get install -y imagemagick', platform: 'linux' },
            { type: 'brew', command: 'brew install imagemagick', platform: 'darwin' },
        ],
    }),

    pandoc: (): CapabilityQuery => ({
        name: 'Pandoc (document converter)',
        check: { type: 'which', value: 'pandoc' },
        install: [
            { type: 'apt', command: 'sudo apt-get install -y pandoc', platform: 'linux' },
            { type: 'brew', command: 'brew install pandoc', platform: 'darwin' },
        ],
    }),

    tesseract: (): CapabilityQuery => ({
        name: 'Tesseract OCR',
        check: { type: 'which', value: 'tesseract' },
        install: [
            { type: 'apt', command: 'sudo apt-get install -y tesseract-ocr', platform: 'linux' },
            { type: 'brew', command: 'brew install tesseract', platform: 'darwin' },
        ],
    }),
}

// ============================================
// Helper: format resolution for Telegram
// ============================================

export function formatResolution(query: CapabilityQuery, res: CapabilityResolution): string {
    if (res.error) {
        return `❌ *${query.name}* konnte nicht aufgelöst werden.\n\nBitte manuell installieren.`
    }
    if (!res.runRemotely && !res.installed) {
        return `✅ *${query.name}* ist lokal verfügbar.`
    }
    const loc = res.runRemotely ? `📡 auf *${res.node?.hostname || res.node?.ip}*` : '🏠 lokal'
    const installMsg = res.installed ? ' (soeben installiert)' : ''
    return `✅ *${query.name}* läuft ${loc}${installMsg}`
}
