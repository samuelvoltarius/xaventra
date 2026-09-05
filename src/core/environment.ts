/**
 * Nova Global Environment Detection & Self-Healing
 * 
 * Shared service that ALL tools and layers can use to:
 * 1. Detect OS, shell, and available tools
 * 2. Auto-install missing tools
 * 3. Report capabilities honestly
 * 
 * Nova uses this to understand WHERE she runs and WHAT she can do.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { platform, homedir, hostname, arch, cpus, totalmem, freemem } from 'node:os'

// ============================================
// Types
// ============================================

export interface NovaEnvironment {
    os: 'windows' | 'linux' | 'mac'
    arch: string
    hostname: string
    shell: string
    homeDir: string

    // Package managers
    hasChoco: boolean
    hasScoop: boolean
    hasBrew: boolean
    hasApt: boolean
    hasYum: boolean

    // Common tools
    hasSSH: boolean
    hasPlink: boolean
    hasSshpass: boolean
    hasSSHKey: boolean
    hasCurl: boolean
    hasWget: boolean
    hasGit: boolean
    hasPython: boolean
    hasNode: boolean
    hasDocker: boolean
    hasFfmpeg: boolean

    // Network
    networkReachable: boolean

    // Timestamps
    detectedAt: string
    cachedUntil: number  // Unix ms — re-detect after this
}

export interface InstallResult {
    success: boolean
    tool: string
    method: string
    message: string
}

// ============================================
// Cache (detect once, reuse for 5 min)
// ============================================

let cachedEnv: NovaEnvironment | null = null

const ENV_FILE = join(process.cwd(), '.nova-data', 'environment.json')

function loadCachedEnv(): NovaEnvironment | null {
    try {
        // In-memory cache first
        if (cachedEnv && Date.now() < cachedEnv.cachedUntil) return cachedEnv

        // Disk cache
        if (existsSync(ENV_FILE)) {
            const saved = JSON.parse(readFileSync(ENV_FILE, 'utf-8'))
            if (saved.cachedUntil && Date.now() < saved.cachedUntil) {
                cachedEnv = saved
                return cachedEnv
            }
        }
    } catch { /* re-detect */ }
    return null
}

function saveCachedEnv(env: NovaEnvironment): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(ENV_FILE, JSON.stringify(env, null, 2))
    } catch { /* non-critical */ }
}

// ============================================
// Tool Detection Helpers
// ============================================

function hasCommand(cmd: string): boolean {
    try {
        const os = platform()
        const checkCmd = os === 'win32' ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`
        execSync(checkCmd, { encoding: 'utf-8', timeout: 3000, windowsHide: true, stdio: 'pipe' })
        return true
    } catch { return false }
}

function getShell(): string {
    const os = platform()
    if (os === 'win32') {
        return process.env.COMSPEC || 'cmd.exe'
    }
    return process.env.SHELL || '/bin/sh'
}

// ============================================
// Main Detection
// ============================================

export function detectEnvironment(forceRefresh = false): NovaEnvironment {
    if (!forceRefresh) {
        const cached = loadCachedEnv()
        if (cached) return cached
    }

    const os = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'mac' : 'linux'
    const home = homedir()
    const sshKeyExists = existsSync(join(home, '.ssh', 'id_ed25519')) || existsSync(join(home, '.ssh', 'id_rsa'))

    console.log('[Environment] 🔍 Detecting Nova environment...')

    const env: NovaEnvironment = {
        os,
        arch: arch(),
        hostname: hostname(),
        shell: getShell(),
        homeDir: home,

        // Package managers
        hasChoco: os === 'windows' && hasCommand('choco'),
        hasScoop: os === 'windows' && hasCommand('scoop'),
        hasBrew: (os === 'mac' || os === 'linux') && hasCommand('brew'),
        hasApt: os === 'linux' && hasCommand('apt-get'),
        hasYum: os === 'linux' && hasCommand('yum'),

        // Common tools
        hasSSH: hasCommand('ssh'),
        hasPlink: os === 'windows' && hasCommand('plink'),
        hasSshpass: hasCommand('sshpass'),
        hasSSHKey: sshKeyExists,
        hasCurl: hasCommand('curl'),
        hasWget: hasCommand('wget'),
        hasGit: hasCommand('git'),
        hasPython: hasCommand('python') || hasCommand('python3'),
        hasNode: hasCommand('node'),
        hasDocker: hasCommand('docker'),
        hasFfmpeg: hasCommand('ffmpeg'),

        // Network (quick check)
        networkReachable: false,

        detectedAt: new Date().toISOString(),
        cachedUntil: Date.now() + 5 * 60 * 1000,  // Cache for 5 minutes
    }

    // Quick network check
    try {
        execSync(os === 'windows' ? 'ping -n 1 -w 2000 8.8.8.8' : 'ping -c 1 -W 2 8.8.8.8', {
            timeout: 3000, windowsHide: true, stdio: 'pipe',
        })
        env.networkReachable = true
    } catch { /* offline */ }

    console.log(`[Environment] ✅ ${env.os}/${env.arch} | SSH:${env.hasSSH} Key:${env.hasSSHKey} | Choco:${env.hasChoco} Scoop:${env.hasScoop} | Docker:${env.hasDocker} | Net:${env.networkReachable}`)

    cachedEnv = env
    saveCachedEnv(env)
    return env
}

// ============================================
// Auto-Install Tools
// ============================================

export async function autoInstall(toolName: string): Promise<InstallResult> {
    const env = detectEnvironment()

    console.log(`[Environment] 🔧 Auto-installing: ${toolName} on ${env.os}`)

    // Map tool names to install commands per package manager
    const installMap: Record<string, Record<string, string>> = {
        plink: {
            choco: 'choco install putty.portable -y',
        },
        sshpass: {
            apt: 'sudo apt-get install -y sshpass',
            yum: 'sudo yum install -y sshpass',
            brew: 'brew install esolitos/ipa/sshpass',
            scoop: 'scoop install sshpass',
        },
        ffmpeg: {
            choco: 'choco install ffmpeg -y',
            scoop: 'scoop install ffmpeg',
            apt: 'sudo apt-get install -y ffmpeg',
            brew: 'brew install ffmpeg',
        },
        curl: {
            choco: 'choco install curl -y',
            apt: 'sudo apt-get install -y curl',
        },
        wget: {
            choco: 'choco install wget -y',
            apt: 'sudo apt-get install -y wget',
            brew: 'brew install wget',
        },
        git: {
            choco: 'choco install git -y',
            apt: 'sudo apt-get install -y git',
            brew: 'brew install git',
        },
        docker: {
            choco: 'choco install docker-desktop -y',
            apt: 'sudo apt-get install -y docker.io',
            brew: 'brew install --cask docker',
        },
        python: {
            choco: 'choco install python3 -y',
            apt: 'sudo apt-get install -y python3 python3-pip',
            brew: 'brew install python3',
        },
    }

    const toolInstalls = installMap[toolName]
    if (!toolInstalls) {
        return { success: false, tool: toolName, method: 'none', message: `Kein Install-Rezept für ${toolName}` }
    }

    // Try available package managers in order of preference
    const managers: [string, boolean][] = [
        ['choco', env.hasChoco],
        ['scoop', env.hasScoop],
        ['brew', env.hasBrew],
        ['apt', env.hasApt],
        ['yum', env.hasYum],
    ]

    for (const [mgr, available] of managers) {
        if (!available || !toolInstalls[mgr]) continue

        const cmd = toolInstalls[mgr]
        console.log(`[Environment] 📦 Trying: ${cmd}`)

        try {
            execSync(cmd, {
                encoding: 'utf-8',
                timeout: 120000,  // 2 min for installs
                windowsHide: true,
                stdio: 'pipe',
            })

            console.log(`[Environment] ✅ ${toolName} installed via ${mgr}!`)

            // Invalidate cache so next detection picks up the new tool
            cachedEnv = null
            try { if (existsSync(ENV_FILE)) require('fs').unlinkSync(ENV_FILE) } catch { /* ok */ }

            return { success: true, tool: toolName, method: mgr, message: `${toolName} installiert via ${mgr}` }
        } catch (err: any) {
            console.log(`[Environment] ⚠️ ${mgr} install failed: ${err.message?.slice(0, 80)}`)
        }
    }

    return { success: false, tool: toolName, method: 'none', message: `Konnte ${toolName} nicht installieren. Kein Package Manager verfügbar.` }
}

// ============================================  
// Capability Check (for honesty)
// ============================================

/**
 * Check if Nova CAN do something, and say honestly if she can't.
 * Used by the LLM prompt pipeline to inject capability awareness.
 */
export function getCapabilities(): string {
    const env = detectEnvironment()

    // Hardware info (REAL, not hallucinated!)
    const cpuInfo = cpus()
    const cpuModel = cpuInfo[0]?.model || 'unknown'
    const cpuCores = cpuInfo.length
    const totalRamGB = (totalmem() / 1024 / 1024 / 1024).toFixed(1)
    const freeRamGB = (freemem() / 1024 / 1024 / 1024).toFixed(1)

    const caps: string[] = [
        `Nova läuft auf: ${env.os} (${env.arch}) — ${env.hostname}`,
        `CPU: ${cpuModel} (${cpuCores} Kerne)`,
        `RAM: ${totalRamGB} GB total, ${freeRamGB} GB frei`,
        `Shell: ${env.shell}`,
    ]

    // Network
    if (env.networkReachable) {
        caps.push('Internet: ✅ Erreichbar')
    } else {
        caps.push('Internet: ❌ Nicht erreichbar — Google/Web-Suche wird nicht funktionieren')
    }

    // SSH
    if (env.hasSSH) {
        caps.push(`SSH: ✅ Verfügbar${env.hasSSHKey ? ' + Key vorhanden' : ' (kein Key, brauche Passwort)'}`)
        if (env.hasPlink) caps.push('Plink: ✅ (Passwort-Auth möglich)')
        if (env.hasSshpass) caps.push('sshpass: ✅ (Passwort-Auth möglich)')

        // Show known hosts so the LLM knows to use ssh_command for them
        try {
            const hostsFile = join(process.cwd(), '.nova-data', 'hosts.json')
            if (existsSync(hostsFile)) {
                const db = JSON.parse(readFileSync(hostsFile, 'utf-8'))
                if (db.hosts?.length > 0) {
                    const hostList = db.hosts.map((h: any) =>
                        `  - ${h.name}${h.alias?.length ? ` (${h.alias.join(', ')})` : ''}: ${h.user}@${h.ip} [Passwort gespeichert ✅]`
                    ).join('\n')
                    caps.push(`Bekannte Geräte im Netzwerk (IMMER ssh_command benutzen!):\n${hostList}`)
                }
            }
        } catch { /* no hosts file */ }
    } else {
        caps.push('SSH: ❌ Nicht verfügbar')
    }

    // Package managers
    const pkgMgrs = []
    if (env.hasChoco) pkgMgrs.push('Chocolatey')
    if (env.hasScoop) pkgMgrs.push('Scoop')
    if (env.hasBrew) pkgMgrs.push('Homebrew')
    if (env.hasApt) pkgMgrs.push('apt')
    if (pkgMgrs.length > 0) {
        caps.push(`Package Manager: ${pkgMgrs.join(', ')} — ich kann fehlende Tools selbst installieren`)
    } else {
        caps.push('Package Manager: ❌ Keiner verfügbar — kann nichts automatisch installieren')
    }

    // Other tools
    if (env.hasDocker) caps.push('Docker: ✅')
    if (env.hasFfmpeg) caps.push('FFmpeg: ✅')
    if (env.hasPython) caps.push('Python: ✅')

    return caps.join('\n')
}

/**
 * Get a concise environment summary for system prompt injection
 */
export function getEnvironmentSummary(): string {
    const env = detectEnvironment()

    return `[Nova Environment] OS: ${env.os}/${env.arch} | Host: ${env.hostname} | SSH: ${env.hasSSH ? 'ja' : 'nein'}${env.hasSSHKey ? '+key' : ''} | Net: ${env.networkReachable ? 'ja' : 'nein'} | PkgMgr: ${[env.hasChoco && 'choco', env.hasScoop && 'scoop', env.hasBrew && 'brew', env.hasApt && 'apt'].filter(Boolean).join(',') || 'none'}`
}

export default {
    detectEnvironment,
    autoInstall,
    getCapabilities,
    getEnvironmentSummary,
    hasCommand,
}
