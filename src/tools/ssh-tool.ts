/**
 * Enhanced SSH Tool for Nova - SELF-HEALING
 * 
 * Nova AUTONOMOUSLY solves SSH connection problems:
 * 1. Detects OS (Windows/Linux/Mac)
 * 2. Detects what's available (ssh, plink, sshpass, SSH keys)
 * 3. If something is missing → installs/configures it HERSELF
 * 4. Retries automatically
 * 
 * Password auth strategy (in order of preference):
 * - Windows: SSH_ASKPASS trick → plink (auto-install) → SSH key setup
 * - Linux: sshpass (auto-install) → SSH key setup
 * - Mac: sshpass (via brew) → SSH key setup
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform, homedir } from 'node:os'
import { detectEnvironment as detectGlobalEnv, autoInstall } from '../core/environment.js'
import { loadHosts, saveHosts, resolveHostPassword } from './ssh-tool-hosts.js'

// ============================================
// Host Database
// ============================================

/**
 * Look up a host by name, alias, IP, or partial match in description/name.
 * Supports fuzzy matching so "jetson" finds a host named "jetson-orin" or
 * with description containing "jetson".
 */
export function lookupHost(nameOrAlias: string, withPassword = true): { ip: string; user: string; name: string; password?: string } | null {
    const db = loadHosts()
    const needle = nameOrAlias.toLowerCase().trim()

    // Pass 1: Exact match on name, alias, or IP
    for (const host of db.hosts) {
        if (host.name.toLowerCase() === needle ||
            host.alias.some(a => a.toLowerCase() === needle) ||
            host.ip === needle) {
            console.log(`[SSH] Host lookup (exact): "${nameOrAlias}" → ${host.user}@${host.ip} (${host.name})`)
            return { ip: host.ip, user: host.user, name: host.name, password: withPassword ? resolveHostPassword(host) : undefined }
        }
    }

    // Pass 2: Partial/fuzzy match on name, alias, or description
    for (const host of db.hosts) {
        const nameMatch = host.name.toLowerCase().includes(needle) || needle.includes(host.name.toLowerCase())
        const aliasMatch = host.alias.some(a => a.toLowerCase().includes(needle) || needle.includes(a.toLowerCase()))
        const descMatch = host.description?.toLowerCase().includes(needle)
        if (nameMatch || aliasMatch || descMatch) {
            console.log(`[SSH] Host lookup (fuzzy): "${nameOrAlias}" → ${host.user}@${host.ip} (${host.name})`)
            return { ip: host.ip, user: host.user, name: host.name, password: withPassword ? resolveHostPassword(host) : undefined }
        }
    }

    return null
}

/**
 * Save metadata only. Explicit password authentication is connection-local;
 * unattended reconnect uses a separately configured key or environment reference.
 */
function saveHostCredentials(host: string, user: string, _password: string, deviceName?: string): void {
    const db = loadHosts()
    const existing = db.hosts.find(h => h.ip === host)
    if (existing) {
        existing.user = user
        existing.lastSeen = new Date().toISOString()
        // Auto-learn aliases from device name
        if (deviceName && !existing.alias.includes(deviceName.toLowerCase())) {
            existing.alias.push(deviceName.toLowerCase())
            console.log(`[SSH] 📚 Learned alias: "${deviceName}" → ${host}`)
        }
    } else {
        const aliases = deviceName ? [deviceName.toLowerCase()] : []
        db.hosts.push({
            name: deviceName || host,
            alias: aliases,
            ip: host,
            user,
            description: 'Auto-saved by Nova SSH',
            lastSeen: new Date().toISOString()
        })
    }
    try {
        saveHosts(db)
        console.log('[SSH] Host metadata saved; connection password not persisted')
    } catch {
        // Command success and metadata persistence are separate outcomes.
        console.log('[SSH] Host metadata not saved; existing credentials require explicit local migration')
    }
}

// ============================================
// SSH Context Tracking
// ============================================

interface SSHContext {
    host: string
    user?: string
    port?: number
    lastUsed: number
    deviceName?: string
}

const activeSSHContext: Map<string, SSHContext> = new Map()

export function getActiveSSHContext(userId: string): SSHContext | null {
    const ctx = activeSSHContext.get(userId)
    if (!ctx) return null
    const tenMinutes = 10 * 60 * 1000
    if (Date.now() - ctx.lastUsed > tenMinutes) {
        activeSSHContext.delete(userId)
        return null
    }
    return ctx
}

export function setActiveSSHContext(userId: string, host: string, user?: string, port?: number): void {
    activeSSHContext.set(userId, { host, user, port, lastUsed: Date.now() })
    console.log(`[SSH Context] Active device for ${userId}: ${user ? user + '@' : ''}${host}`)
}

// ============================================
// Environment Detection (Nova learns about her OS)
// ============================================

interface SSHEnvironment {
    os: 'windows' | 'linux' | 'mac'
    hasSSH: boolean
    hasPlink: boolean
    hasSshpass: boolean
    hasSSHKey: boolean
    sshKeyPath: string
}

function detectEnvironment(): SSHEnvironment {
    const global = detectGlobalEnv()
    return {
        os: global.os,
        hasSSH: global.hasSSH,
        hasPlink: global.hasPlink,
        hasSshpass: global.hasSshpass,
        hasSSHKey: global.hasSSHKey,
        sshKeyPath: join(homedir(), '.ssh', 'id_ed25519'),
    }
}

// ============================================ 
// Auto-Install Missing Tools (Self-Healing!)
// ============================================

async function autoInstallSSHTool(env: SSHEnvironment): Promise<{ installed: string | null; error?: string }> {
    console.log('[SSH] 🔧 Auto-installing SSH password tool via global environment...')

    // Try plink first on Windows
    if (env.os === 'windows') {
        const result = await autoInstall('plink')
        if (result.success) return { installed: 'plink' }
    }

    // Try sshpass on any OS
    const result = await autoInstall('sshpass')
    if (result.success) return { installed: 'sshpass' }

    // SSH_ASKPASS works without installing anything on Windows
    if (env.os === 'windows') {
        console.log('[SSH] 💡 Will use SSH_ASKPASS mechanism (built-in)')
        return { installed: 'askpass' }
    }

    return { installed: null, error: 'Kein SSH-Passwort-Tool installierbar' }
}

// ============================================
// Auto-Setup SSH Key (Ultimate Fallback)
// ============================================

async function autoSetupSSHKey(host: string, user: string, password: string, port: number, env: SSHEnvironment): Promise<{ success: boolean; message: string }> {
    console.log('[SSH] 🔑 Auto-Setup SSH Key...')

    const sshDir = join(homedir(), '.ssh')
    const keyPath = join(sshDir, 'id_ed25519')
    const pubKeyPath = keyPath + '.pub'

    // Step 1: Generate key if it doesn't exist
    if (!existsSync(keyPath)) {
        try {
            if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true })
            console.log('[SSH] Generating SSH key pair...')
            execSync(`ssh-keygen -t ed25519 -C "nova-auto" -f "${keyPath}" -N ""`, {
                encoding: 'utf-8',
                timeout: 30000,
                windowsHide: true,
                stdio: 'pipe',
            })
            console.log('[SSH] ✅ SSH key generated!')
        } catch (err: any) {
            return { success: false, message: `Key generation failed: ${err.message?.slice(0, 80)}` }
        }
    }

    // Step 2: Copy public key to remote host using password
    if (existsSync(pubKeyPath)) {
        const pubKey = readFileSync(pubKeyPath, 'utf-8').trim()
        console.log(`[SSH] Copying public key to ${user}@${host}...`)

        // Use whatever method works to copy the key
        const copyCmd = env.hasSshpass
            ? `sshpass -p "${password}" ssh -o StrictHostKeyChecking=accept-new -p ${port} ${user}@${host} "mkdir -p ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`
            : env.hasPlink
                ? `echo y | plink -pw "${password}" -P ${port} ${user}@${host} "mkdir -p ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`
                : null

        if (copyCmd) {
            try {
                execSync(copyCmd, {
                    encoding: 'utf-8',
                    timeout: 30000,
                    windowsHide: true,
                    stdio: 'pipe',
                    shell: env.os === 'windows' ? 'cmd.exe' : '/bin/sh',
                })
                console.log('[SSH] ✅ SSH key copied to remote host!')
                return { success: true, message: `SSH-Key auf ${host} hinterlegt! Ab jetzt verbinde ich mich ohne Passwort.` }
            } catch (err: any) {
                console.log(`[SSH] ⚠️ Key copy failed: ${err.message?.slice(0, 80)}`)
            }
        }

        // Fallback: use SSH_ASKPASS to copy the key
        if (env.os === 'windows') {
            try {
                const askpassFile = join(tmpdir(), `nova_askpass_${Date.now()}.bat`)
                writeFileSync(askpassFile, `@echo ${password}`)
                execSync(
                    `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -p ${port} ${user}@${host} "mkdir -p ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`,
                    {
                        encoding: 'utf-8',
                        timeout: 30000,
                        windowsHide: true,
                        stdio: 'pipe',
                        env: {
                            ...process.env,
                            SSH_ASKPASS: askpassFile,
                            SSH_ASKPASS_REQUIRE: 'force',
                            DISPLAY: ':0',
                        },
                    }
                )
                try { unlinkSync(askpassFile) } catch { /* cleanup */ }
                console.log('[SSH] ✅ SSH key copied via SSH_ASKPASS!')
                return { success: true, message: `SSH-Key auf ${host} hinterlegt!` }
            } catch {
                console.log('[SSH] ⚠️ SSH_ASKPASS key copy failed')
            }
        }

        return { success: false, message: `Key generiert aber konnte nicht auf ${host} kopiert werden. Bitte manuell: cat ${pubKeyPath} und auf dem Server in ~/.ssh/authorized_keys einfügen.` }
    }

    return { success: false, message: 'Key generation failed' }
}

// ============================================
// SSH Command Builders (per method)
// ============================================

function buildSSHCommand(
    host: string, cmd: string, user: string, port: number,
    password: string, method: string, env: SSHEnvironment
): { command: string; customEnv?: Record<string, string>; cleanup?: string; shell?: string } {
    const userPart = user ? `${user}@` : ''
    const portPart = port !== 22 ? `-p ${port} ` : ''
    const plinkPort = port !== 22 ? `-P ${port} ` : ''

    // Escape inner double quotes in the command so they survive the outer wrapping
    const escapedCmd = cmd.replace(/"/g, '\\"')

    switch (method) {
        case 'plink':
            return {
                command: `echo y | plink -batch -pw "${password}" ${plinkPort}${userPart}${host} "${escapedCmd}"`,
            }

        case 'sshpass':
            return {
                command: `sshpass -p "${password}" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 ${portPart}${userPart}${host} "${escapedCmd}"`,
            }

        case 'askpass': {
            // SSH_ASKPASS trick: create temp script that echoes password
            // IMPORTANT: Must use PowerShell on Windows — cmd.exe doesn't handle SSH_ASKPASS_REQUIRE correctly
            const askpassFile = join(tmpdir(), `nova_askpass_${Date.now()}.bat`)
            if (env.os === 'windows') {
                writeFileSync(askpassFile, `@echo ${password}`)
            } else {
                writeFileSync(askpassFile, `#!/bin/sh\necho "${password}"`)
                try { execSync(`chmod +x "${askpassFile}"`, { stdio: 'pipe' }) } catch { /* ok */ }
            }
            return {
                command: `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o PreferredAuthentications=password -o PubkeyAuthentication=no ${portPart}${userPart}${host} "${escapedCmd}"`,
                customEnv: {
                    SSH_ASKPASS: askpassFile,
                    SSH_ASKPASS_REQUIRE: 'force',
                    DISPLAY: ':0',
                },
                cleanup: askpassFile,
                shell: env.os === 'windows' ? 'powershell.exe' : '/bin/sh',
            }
        }

        case 'key':
        default:
            return {
                command: `ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 ${portPart}${userPart}${host} "${escapedCmd}"`,
            }
    }
}

// ============================================
// Main SSH Execution - AUTO-HEALING
// ============================================

export interface SSHParams {
    host: string
    command: string
    user?: string
    port?: number
    password?: string
    userId?: string
}

export async function executeSSH(params: SSHParams): Promise<{ success?: boolean; error?: string; command: string; output?: string; action?: string }> {
    const sanitize = (val: string | undefined): string =>
        val ? val.replace(/^["']|["']$/g, '').trim() : ''

    let host = sanitize(params.host)
    const cmd = params.command
    let user = sanitize(params.user)
    const port = params.port || 22
    let password = sanitize(params.password)

    // === LONG-RUNNING COMMAND DETECTION ===
    // Commands like 'ollama pull', 'apt install', 'pip install' take minutes.
    // Instead of blocking (and timing out), run them in background and return immediately.
    const LONG_RUNNING_PATTERNS = [
        /ollama\s+(pull|run|create)/i,
        /apt(-get)?\s+(install|upgrade|update|dist-upgrade)/i,
        /pip3?\s+install/i,
        /npm\s+(install|ci)\b/i,
        /docker\s+(pull|build)/i,
        /git\s+clone/i,
        /wget\s|curl.*-[oO]/i,
        /make\s|cmake\s|cargo\s+build/i,
    ]

    const isLongRunning = !cmd.trimStart().startsWith('nohup') && LONG_RUNNING_PATTERNS.some(p => p.test(cmd))

    if (isLongRunning) {
        const taskId = `nova_${Date.now()}`
        const logPath = `/tmp/${taskId}.log`
        const bgCmd = `nohup bash -c '${cmd.replace(/'/g, "'\\''")} > ${logPath} 2>&1 && echo NOVA_DONE >> ${logPath} || echo NOVA_FAILED >> ${logPath}' &`

        console.log(`[SSH] 🕐 Long-running command detected: "${cmd.slice(0, 60)}..."`)
        console.log(`[SSH] 🔄 Running in background as task ${taskId}`)

        // Execute the background wrapper — this returns instantly
        const bgParams = { ...params, command: bgCmd }
        const bgResult = await executeSSH({ ...bgParams, command: bgCmd })

        if (bgResult.error) {
            return bgResult // Connection itself failed
        }

        return {
            success: true,
            command: cmd,
            output: `⏳ Langläufiger Befehl gestartet!\n\n` +
                `📋 Task: \`${taskId}\`\n` +
                `📂 Log: \`${logPath}\`\n` +
                `🔍 Status prüfen: \`cat ${logPath}\`\n\n` +
                `Der Befehl läuft im Hintergrund auf ${host}. ` +
                `Prüfe den Status mit: ssh ${user}@${host} "tail -5 ${logPath}"`,
            action: `Befehl "${cmd.slice(0, 50)}..." im Hintergrund gestartet. Log: ${logPath}`,
        }
    }

    // Look up known host (may have saved password)
    let passwordFromSaved = false
    let knownHost: ReturnType<typeof lookupHost>
    try { knownHost = lookupHost(host, !password) }
    catch { return { success: false, command: cmd, error: 'Node-local SSH credentials unavailable; configure the reference locally or explicitly choose SSH-key authentication' } }
    if (knownHost) {
        host = knownHost.ip
        user = knownHost.user
        if (!password && knownHost.password) {
            password = knownHost.password
            passwordFromSaved = true
            console.log(`[SSH] Using saved password for ${user}@${host}`)
        }
        console.log(`[SSH] Using known host: ${knownHost.name} → ${user}@${host}`)
    }

    // Detect "no password" phrases — but NEVER clear a saved password
    if (!passwordFromSaved) {
        const noPasswordPhrases = ['kein password', 'kein passwort', 'no password', 'none', 'ssh-key', '-']
        const pwLower = password.toLowerCase().trim()
        if (noPasswordPhrases.includes(pwLower) || password.length < 2) {
            password = ''
            console.log('[SSH] Key-auth mode (no password)')
        } else {
            console.log(`[SSH] Password-auth mode (${password.length} chars)`)
        }
    } else {
        console.log(`[SSH] Password-auth mode (saved, ${password.length} chars)`)
    }

    // === DETECT ENVIRONMENT ===
    const env = detectEnvironment()
    console.log(`[SSH] 🖥️ Running on: ${env.os} | Connecting to: ${user}@${host}:${port}`)

    // === DETERMINE AUTH METHOD ===
    // Build a priority list of methods to try
    const methods: string[] = []

    if (password) {
        // With password: askpass first (proven to work on Windows), then alternatives
        if (env.os === 'windows') methods.push('askpass')  // FIRST — already proven to work
        if (env.hasSshpass) methods.push('sshpass')
        if (env.hasPlink && env.os === 'windows') methods.push('plink')
        methods.push('key')  // Last resort fallback
    } else {
        methods.push('key')
    }

    console.log(`[SSH] 🎯 Auth methods to try: ${methods.join(' → ')}`)

    // === TRY EACH METHOD ===
    let lastError = ''

    for (const method of methods) {
        console.log(`[SSH] 🔄 Trying method: ${method}`)

        const { command: sshCmd, customEnv, cleanup, shell: methodShell } = buildSSHCommand(host, cmd, user, port, password, method, env)
        const displayCmd = sshCmd.replace(password || 'x', '***')
        const defaultShell = env.os === 'windows' ? 'cmd.exe' : '/bin/sh'

        try {
            const output = execSync(sshCmd, {
                encoding: 'utf-8',
                timeout: (method === 'plink' || method === 'key') ? 15000 : 60000,
                shell: methodShell || defaultShell,
                env: {
                    ...process.env,
                    HOME: process.env.USERPROFILE || process.env.HOME,
                    ...customEnv,
                },
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            // Cleanup temp files
            if (cleanup) try { unlinkSync(cleanup) } catch { /* ok */ }

            // Auto-learn: if command was 'hostname' or similar, learn the device name as alias
            const trimmedOutput = output.trim()
            let deviceName: string | undefined
            if (cmd.trim() === 'hostname' && trimmedOutput && trimmedOutput.length < 50 && !trimmedOutput.includes('\n')) {
                deviceName = trimmedOutput
            }

            // Save context + credentials on success
            if (params.userId) setActiveSSHContext(params.userId, host, user, port)
            if (password) saveHostCredentials(host, user, password, deviceName)

            // Auto-learn hostname if this host only has an IP as name (no descriptive name yet)
            const currentHost = loadHosts().hosts.find(h => h.ip === host)
            if (currentHost && /^[\d.]+$/.test(currentHost.name) && cmd.trim() !== 'hostname') {
                // Host name is just an IP — silently learn the real hostname
                try {
                    const { command: hostnameCmd, customEnv: hnEnv, cleanup: hnCleanup, shell: hnShell } = buildSSHCommand(host, 'hostname', user, port, password, method, env)
                    const hostname = execSync(hostnameCmd, {
                        encoding: 'utf-8',
                        timeout: 10000,
                        shell: hnShell || defaultShell,
                        env: { ...process.env, HOME: process.env.USERPROFILE || process.env.HOME, ...hnEnv },
                        windowsHide: true,
                        stdio: ['pipe', 'pipe', 'pipe'],
                    }).trim()
                    if (hnCleanup) try { unlinkSync(hnCleanup) } catch { /* ok */ }
                    if (hostname && hostname.length < 50 && !hostname.includes('\n')) {
                        saveHostCredentials(host, user, password, hostname)
                        console.log(`[SSH] 🧠 Auto-learned hostname: "${hostname}" for ${host}`)
                    }
                } catch { /* non-critical: hostname learning failed */ }
            }

            // === SELF-HEALING: "command not found" on remote host ===
            // Non-interactive SSH doesn't load .bashrc → PATH is incomplete
            if (trimmedOutput.includes('command not found') || trimmedOutput.includes('not found')) {
                const cmdName = cmd.trim().split(/\s+/)[0]
                console.log(`[SSH] ⚠️ "${cmdName}" not found on remote — trying PATH fix...`)

                // Retry 1: source ~/.bashrc first
                const bashrcCmd = `source ~/.bashrc 2>/dev/null; source ~/.profile 2>/dev/null; ${cmd}`
                try {
                    const { command: fixCmd, customEnv: fixEnv, cleanup: fixCleanup, shell: fixShell } = buildSSHCommand(host, bashrcCmd, user, port, password, method, env)
                    const fixOutput = execSync(fixCmd, {
                        encoding: 'utf-8',
                        timeout: 60000,
                        shell: fixShell || defaultShell,
                        env: { ...process.env, HOME: process.env.USERPROFILE || process.env.HOME, ...fixEnv },
                        windowsHide: true,
                        stdio: ['pipe', 'pipe', 'pipe'],
                    }).trim()
                    if (fixCleanup) try { unlinkSync(fixCleanup) } catch { /* ok */ }

                    if (!fixOutput.includes('command not found') && !fixOutput.includes('not found')) {
                        console.log(`[SSH] ✅ Fixed via .bashrc PATH! ${cmdName} works now.`)
                        if (params.userId) setActiveSSHContext(params.userId, host, user, port)
                        if (password) saveHostCredentials(host, user, password)
                        return { success: true, command: displayCmd, output: fixOutput, action: `"${cmdName}" war nicht im SSH-PATH — hab .bashrc geladen und es hat funktioniert.` }
                    }
                } catch { /* bashrc retry failed */ }

                // Retry 2: Try common binary paths
                const commonPaths = ['/usr/local/bin/', '/usr/bin/', '/snap/bin/', '/home/linuxbrew/.linuxbrew/bin/', `~/.local/bin/`]
                for (const binPath of commonPaths) {
                    const fullPathCmd = cmd.replace(new RegExp(`^${cmdName}`), `${binPath}${cmdName}`)
                    try {
                        const { command: pathCmd, customEnv: pathEnv, cleanup: pathCleanup, shell: pathShell } = buildSSHCommand(host, fullPathCmd, user, port, password, method, env)
                        const pathOutput = execSync(pathCmd, {
                            encoding: 'utf-8',
                            timeout: 60000,
                            shell: pathShell || defaultShell,
                            env: { ...process.env, HOME: process.env.USERPROFILE || process.env.HOME, ...pathEnv },
                            windowsHide: true,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        }).trim()
                        if (pathCleanup) try { unlinkSync(pathCleanup) } catch { /* ok */ }

                        if (!pathOutput.includes('not found') && !pathOutput.includes('No such file')) {
                            console.log(`[SSH] ✅ Found ${cmdName} at ${binPath}! Auto-healed.`)
                            if (params.userId) setActiveSSHContext(params.userId, host, user, port)
                            if (password) saveHostCredentials(host, user, password)
                            return { success: true, command: displayCmd, output: pathOutput, action: `"${cmdName}" lag unter ${binPath} — SSH-PATH war unvollständig.` }
                        }
                    } catch { /* path not found, try next */ }
                }

                // All PATH fixes failed — return original "not found" output (don't hide the error)
                console.log(`[SSH] ❌ ${cmdName} wirklich nicht installiert auf ${host}`)
            }

            console.log(`[SSH] ✅ Success via ${method}!`)
            return { success: true, command: displayCmd, output: trimmedOutput }

        } catch (err: any) {
            lastError = err.message || String(err)
            console.log(`[SSH] ❌ Method ${method} failed: ${lastError.slice(0, 100)}`)

            // Cleanup temp files
            if (cleanup) try { unlinkSync(cleanup) } catch { /* ok */ }
        }
    }

    // === ALL METHODS FAILED — SELF-HEALING ===
    console.log('[SSH] ⚠️ All methods failed! Starting self-healing...')

    if (password) {
        // Try auto-installing tools
        const installResult = await autoInstallSSHTool(env)
        if (installResult.installed && installResult.installed !== 'askpass') {
            console.log(`[SSH] 🔄 Retrying with newly installed: ${installResult.installed}`)

            // Retry with the new tool
            const retryMethod = installResult.installed === 'plink' ? 'plink' : 'sshpass'
            const { command: retrySshCmd, customEnv: retryEnv, cleanup: retryCleanup } = buildSSHCommand(host, cmd, user, port, password, retryMethod, detectEnvironment())
            const retryDisplayCmd = retrySshCmd.replace(password, '***')

            try {
                const output = execSync(retrySshCmd, {
                    encoding: 'utf-8',
                    timeout: 30000,
                    shell: env.os === 'windows' ? 'cmd.exe' : '/bin/sh',
                    env: { ...process.env, HOME: process.env.USERPROFILE || process.env.HOME, ...retryEnv },
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                })

                if (retryCleanup) try { unlinkSync(retryCleanup) } catch { /* ok */ }
                if (params.userId) setActiveSSHContext(params.userId, host, user, port)
                if (password) saveHostCredentials(host, user, password)

                console.log(`[SSH] ✅ Self-healing SUCCESS! Connected via ${retryMethod}`)
                return { success: true, command: retryDisplayCmd, output }
            } catch (retryErr: any) {
                console.log(`[SSH] ❌ Self-healing retry also failed: ${retryErr.message?.slice(0, 100)}`)
                if (retryCleanup) try { unlinkSync(retryCleanup) } catch { /* ok */ }
            }
        }

        // Last resort: try to setup SSH key automatically
        console.log('[SSH] 🔑 Last resort: auto-setup SSH key...')
        const keyResult = await autoSetupSSHKey(host, user, password, port, detectEnvironment())
        if (keyResult.success) {
            // Retry with key auth
            try {
                const { command: keySshCmd } = buildSSHCommand(host, cmd, user, port, '', 'key', detectEnvironment())
                const output = execSync(keySshCmd, {
                    encoding: 'utf-8',
                    timeout: 30000,
                    shell: env.os === 'windows' ? 'cmd.exe' : '/bin/sh',
                    env: { ...process.env, HOME: process.env.USERPROFILE || process.env.HOME },
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                })

                if (params.userId) setActiveSSHContext(params.userId, host, user, port)
                console.log('[SSH] ✅ Connected via auto-generated SSH key!')
                return { success: true, command: keySshCmd, output, action: keyResult.message }
            } catch (keyErr: any) {
                console.log(`[SSH] ❌ Key auth after setup also failed: ${keyErr.message?.slice(0, 100)}`)
            }
        }
    }

    // === TRULY FAILED — Report honestly ===
    const errorSummary = lastError.includes('ETIMEDOUT') || lastError.includes('Connection timed out')
        ? `Host ${host} nicht erreichbar (Timeout). Server aus oder kein Netzwerk?`
        : lastError.includes('Permission denied')
            ? `Passwort falsch oder User "${user}" hat keinen SSH-Zugang auf ${host}`
            : lastError.includes('Connection refused')
                ? `SSH-Dienst auf ${host}:${port} läuft nicht`
                : `SSH fehlgeschlagen: ${lastError.slice(0, 150)}`

    // Queue SSH failure as learning topic so Nova researches fixes during idle
    try {
        const { addTopicFromError } = await import('../intelligence/proactive-learning.js')
        addTopicFromError(
            `SSH ${errorSummary.slice(0, 80)}`,
            `Host: ${host}, User: ${user}, Methoden: ${methods.join(', ')}`
        )
    } catch { /* non-critical */ }

    return {
        error: errorSummary,
        command: `ssh ${user}@${host}`,
        action: `Ich habe ${methods.length} Methoden probiert (${methods.join(', ')}) und versucht fehlende Tools zu installieren. ${errorSummary}`,
    }
}

// Tool definition for registry
export const sshTool = {
    name: 'ssh_command',
    description: 'SSH Befehl auf Remote-Server. WICHTIG: user, port, password als SEPARATE Parameter! Nova löst SSH-Probleme SELBST (installiert fehlende Tools, richtet Keys ein).',
    category: 'system' as const,
    parameters: [
        { name: 'host', type: 'string' as const, description: 'SSH Host/IP z.B. 192.0.2.30', required: true },
        { name: 'command', type: 'string' as const, description: 'Befehl z.B. ls -la', required: true },
        { name: 'user', type: 'string' as const, description: 'SSH User z.B. abc', required: false },
        { name: 'port', type: 'number' as const, description: 'SSH Port z.B. 2223 (default: 22)', required: false },
        { name: 'password', type: 'string' as const, description: 'SSH Passwort', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        return executeSSH({
            host: params.host as string,
            command: params.command as string,
            user: params.user as string | undefined,
            port: params.port as number | undefined,
            password: params.password as string | undefined,
        })
    },
}

export default sshTool
