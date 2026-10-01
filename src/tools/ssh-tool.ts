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

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs'
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

    // Pass 2: Partial/fuzzy match on name, alias, or description.
    // R2 T4: only "needle is part of a known name" (never the reverse, which
    // sent "raspberry-pi-2" to alias "pi"), never for addresses/FQDNs
    // ("192.168.1.1" must not become "192.168.1.10"), and only when unique.
    if (needle.length < 3 || /[.:]/.test(needle)) return null
    const fuzzy = db.hosts.filter(host => {
        const nameMatch = host.name.toLowerCase().includes(needle)
        const aliasMatch = host.alias.some(a => a.toLowerCase().includes(needle))
        const descMatch = host.description?.toLowerCase().includes(needle)
        return nameMatch || aliasMatch || descMatch
    })
    if (fuzzy.length === 1) {
        const host = fuzzy[0]
        console.log(`[SSH] Host lookup (fuzzy): "${nameOrAlias}" → ${host.user}@${host.ip} (${host.name})`)
        return { ip: host.ip, user: host.user, name: host.name, password: withPassword ? resolveHostPassword(host) : undefined }
    }
    if (fuzzy.length > 1) console.log(`[SSH] Host lookup ambiguous for "${nameOrAlias}" (${fuzzy.length} matches) — using it literally`)

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

    // Step 1: Generate key if it doesn't exist (argument vector, no shell)
    if (!existsSync(keyPath)) {
        try {
            if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true })
            console.log('[SSH] Generating SSH key pair...')
            execFileSync('ssh-keygen', ['-t', 'ed25519', '-C', 'nova-auto', '-f', keyPath, '-N', ''], {
                encoding: 'utf-8',
                timeout: 30000,
                windowsHide: true,
                stdio: 'pipe',
            })
            console.log('[SSH] ✅ SSH key generated!')
        } catch (err: any) {
            return { success: false, message: `Key generation failed: ${redactSecret(String(err.message || ''), password).slice(0, 80)}` }
        }
    }

    // Step 2: Copy public key to remote host using password
    if (existsSync(pubKeyPath)) {
        const pubKey = readFileSync(pubKeyPath, 'utf-8').trim()
        if (!/^[A-Za-z0-9+/=@. _-]+$/.test(pubKey)) return { success: false, message: 'Public key has an unexpected format; not copied.' }
        console.log(`[SSH] Copying public key to ${user}@${host}...`)
        const remote = `mkdir -p ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`
        const methods = [env.hasSshpass ? 'sshpass' : '', env.hasPlink ? 'plink' : '', env.os === 'windows' ? 'askpass' : ''].filter(Boolean)
        for (const method of methods) {
            const built = buildSSHCommand(host, remote, user, port, password, method, env)
            try {
                runSSH(built, 30000)
                console.log(`[SSH] ✅ SSH key copied to remote host via ${method}!`)
                return { success: true, message: `SSH-Key auf ${host} hinterlegt! Ab jetzt verbinde ich mich ohne Passwort.` }
            } catch (err: any) {
                console.log(`[SSH] ⚠️ Key copy via ${method} failed: ${redactSecret(String(err.message || ''), password).slice(0, 80)}`)
            } finally {
                cleanupFiles(built.cleanup)
            }
        }

        return { success: false, message: `Key generiert aber konnte nicht auf ${host} kopiert werden. Bitte manuell: cat ${pubKeyPath} und auf dem Server in ~/.ssh/authorized_keys einfügen.` }
    }

    return { success: false, message: 'Key generation failed' }
}

// ============================================
// SSH Command Builders (per method)
// ============================================

/**
 * R2 T5/T30: every method is an argument vector for execFileSync. No local
 * shell ever sees the remote command, host, user or password, so $(...),
 * backticks and $VAR are evaluated by the remote shell only. Passwords go
 * through environment/askpass files, never into a command line or log.
 */
interface BuiltSSHCommand {
    file: string
    args: string[]
    input?: string
    customEnv?: Record<string, string>
    cleanup?: string[]
    display: string
}

function buildSSHCommand(
    host: string, cmd: string, user: string, port: number,
    password: string, method: string, env: SSHEnvironment
): BuiltSSHCommand {
    const target = user ? `${user}@${host}` : host
    const portArgs = port !== 22 ? ['-p', String(port)] : []
    const display = `ssh ${portArgs.join(' ')}${portArgs.length ? ' ' : ''}${target} <command>`

    switch (method) {
        case 'plink':
            return {
                file: 'plink',
                args: ['-batch', '-pw', password, ...(port !== 22 ? ['-P', String(port)] : []), target, cmd],
                input: 'y\n',
                display: display.replace(/^ssh/, 'plink'),
            }

        case 'sshpass':
            return {
                file: 'sshpass',
                args: ['-e', 'ssh', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', ...portArgs, target, cmd],
                customEnv: { SSHPASS: password },
                display,
            }

        case 'askpass': {
            // SSH_ASKPASS trick: a temp script prints the password from a
            // separate file, so the password is never parsed as script code.
            const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const passwordFile = join(tmpdir(), `nova_askpass_${stamp}.txt`)
            writeFileSync(passwordFile, password, { mode: 0o600 })
            let askpassFile: string
            if (env.os === 'windows') {
                askpassFile = join(tmpdir(), `nova_askpass_${stamp}.bat`)
                writeFileSync(askpassFile, `@type "${passwordFile}"\r\n`)
            } else {
                askpassFile = join(tmpdir(), `nova_askpass_${stamp}.sh`)
                writeFileSync(askpassFile, `#!/bin/sh\ncat '${passwordFile}'\n`, { mode: 0o700 })
                try { chmodSync(askpassFile, 0o700) } catch { /* ok */ }
            }
            return {
                file: 'ssh',
                args: ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', ...portArgs, target, cmd],
                customEnv: {
                    SSH_ASKPASS: askpassFile,
                    SSH_ASKPASS_REQUIRE: 'force',
                    DISPLAY: ':0',
                },
                cleanup: [askpassFile, passwordFile],
                display,
            }
        }

        case 'key':
        default:
            return {
                file: 'ssh',
                args: ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...portArgs, target, cmd],
                display,
            }
    }
}

function runSSH(built: BuiltSSHCommand, timeout: number): string {
    return execFileSync(built.file, built.args, {
        encoding: 'utf-8',
        timeout,
        input: built.input,
        env: {
            ...process.env,
            HOME: process.env.USERPROFILE || process.env.HOME,
            ...built.customEnv,
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    })
}

function cleanupFiles(files: string[] | undefined): void {
    for (const file of files || []) try { unlinkSync(file) } catch { /* ok */ }
}

function redactSecret(text: string, secret: string): string {
    return secret && secret.length >= 2 ? text.split(secret).join('***') : text
}

/**
 * R2 T3: a non-zero exit of the REMOTE command is a result, not a connection
 * failure. Only ssh's own 255, sshpass auth/host-key codes, plink fatal
 * errors, timeouts and spawn errors count as "could not connect".
 */
function isRemoteCommandFailure(err: any, method: string): boolean {
    const status = typeof err?.status === 'number' ? err.status : null
    if (status === null || status === 255) return false
    if (method === 'sshpass' && (status === 5 || status === 6)) return false
    if (method === 'plink' && /FATAL ERROR|Access denied|host key/i.test(String(err?.stderr || ''))) return false
    return true
}

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._:%-]*$/
const SAFE_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

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
    /** Runner-injected identity and the owner's one-time code (only for the self-healing step). */
    authorizationUserId?: string
    channel?: string
    confirm?: string
}

export async function executeSSH(params: SSHParams): Promise<{ success?: boolean; error?: string; command: string; output?: string; action?: string }> {
    const sanitize = (val: string | undefined): string =>
        val ? val.replace(/^["']|["']$/g, '').trim() : ''

    let host = sanitize(params.host)
    const cmd = typeof params.command === 'string' ? params.command : ''
    let user = sanitize(params.user)
    const port = params.port === undefined || params.port === null ? 22 : Number(params.port)
    let password = sanitize(params.password)

    if (!cmd.trim()) return { success: false, command: '', error: 'Kein Befehl angegeben.' }
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { success: false, command: cmd, error: `Ungültiger SSH-Port: ${String(params.port)}` }

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
        // R2 T29: detach the wrapper's own stdio from the SSH channel, otherwise
        // ssh waits for the whole job and the call runs into the timeout.
        const bgCmd = `nohup bash -c '${cmd.replace(/'/g, "'\\''")} > ${logPath} 2>&1 && echo NOVA_DONE >> ${logPath} || echo NOVA_FAILED >> ${logPath}' > /dev/null 2>&1 < /dev/null &`

        console.log(`[SSH] 🕐 Long-running command detected: "${cmd.slice(0, 60)}..."`)
        console.log(`[SSH] 🔄 Running in background as task ${taskId}`)

        // Execute the background wrapper — this returns instantly
        const bgResult = await executeSSH({ ...params, command: bgCmd })

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
        // R2 T4: an explicitly requested user is never overwritten, and a saved
        // password only applies to the user it was saved for.
        const sameUser = !user || user === knownHost.user
        user = user || knownHost.user
        if (!password && knownHost.password && sameUser) {
            password = knownHost.password
            passwordFromSaved = true
            console.log(`[SSH] Using saved password for ${user}@${host}`)
        }
        console.log(`[SSH] Using known host: ${knownHost.name} → ${user}@${host}`)
    }

    if (!SAFE_HOST.test(host)) return { success: false, command: cmd, error: `Ungültiger SSH-Host: ${host.slice(0, 80)}` }
    if (user && !SAFE_USER.test(user)) return { success: false, command: cmd, error: `Ungültiger SSH-User: ${user.slice(0, 40)}` }

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

        const built = buildSSHCommand(host, cmd, user, port, password, method, env)
        const displayCmd = built.display

        try {
            let output: string
            try {
                output = runSSH(built, (method === 'plink' || method === 'key') ? 15000 : 60000)
            } finally {
                cleanupFiles(built.cleanup)
            }

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
                const hn = buildSSHCommand(host, 'hostname', user, port, password, method, env)
                try {
                    const hostname = runSSH(hn, 10000).trim()
                    if (hostname && hostname.length < 50 && !hostname.includes('\n')) {
                        saveHostCredentials(host, user, password, hostname)
                        console.log(`[SSH] 🧠 Auto-learned hostname: "${hostname}" for ${host}`)
                    }
                } catch { /* non-critical: hostname learning failed */ } finally { cleanupFiles(hn.cleanup) }
            }

            console.log(`[SSH] ✅ Success via ${method}!`)
            return { success: true, command: displayCmd, output: trimmedOutput }

        } catch (err: any) {
            if (isRemoteCommandFailure(err, method)) {
                // The connection worked; the remote command itself failed. Never
                // re-run it via another auth method (non-idempotent commands).
                const status = err.status as number
                const failedOutput = `${String(err.stdout || '')}${String(err.stderr || '')}`.trim()
                if (params.userId) setActiveSSHContext(params.userId, host, user, port)

                // === SELF-HEALING: "command not found" (exit 127) on remote host ===
                // Non-interactive SSH doesn't load .bashrc → PATH is incomplete.
                // Exit 127 means the command did not start, so a retry is safe.
                if (status === 127) {
                    const healed = healMissingCommand(host, cmd, user, port, password, method, env)
                    if (healed) {
                        if (healed.status !== 0) {
                            return { success: false, command: displayCmd, output: redactSecret(healed.output, password), error: `Befehl auf ${host} endete mit Exit-Code ${healed.status}`, action: healed.action }
                        }
                        return { success: true, command: displayCmd, output: healed.output, action: healed.action }
                    }
                    console.log(`[SSH] ❌ ${cmd.trim().split(/\s+/)[0]} wirklich nicht installiert auf ${host}`)
                }

                return {
                    success: false,
                    command: displayCmd,
                    output: redactSecret(failedOutput, password),
                    error: `Befehl auf ${host} endete mit Exit-Code ${status}`,
                }
            }
            lastError = redactSecret(String(err.message || err), password)
            console.log(`[SSH] ❌ Method ${method} failed: ${lastError.slice(0, 100)}`)
        }
    }

    // === ALL METHODS FAILED — SELF-HEALING ===
    // Installing packages locally and writing a key into the remote
    // authorized_keys are side effects with external reach: only with an
    // explicit owner approval (R2 T3). P9: the same one-time code as every other
    // owner-gated tool, bound to this user@host — never a context flag.
    const selfHealDetail = `selbstheilung:${user || '?'}@${host}`
    let selfHealApproved = false
    let selfHealHint = ''
    if (password) {
        const { ownerApprovalRefusal } = await import('./owner-approval.js')
        const refusal = await ownerApprovalRefusal(params as unknown as Record<string, unknown>, 'ssh_command', selfHealDetail)
        selfHealApproved = refusal === null
        if (!selfHealApproved) {
            selfHealHint = ` Selbstheilung nur mit Owner-Freigabe: „/freigabe ssh_command ${selfHealDetail}“.`
            console.log('[SSH] ⚠️ All methods failed; self-healing (tool install / key setup) needs explicit approval')
        }
    }

    if (password && selfHealApproved) {
        console.log('[SSH] ⚠️ All methods failed! Starting approved self-healing...')
        // Try auto-installing tools
        const installResult = await autoInstallSSHTool(env)
        if (installResult.installed && installResult.installed !== 'askpass') {
            console.log(`[SSH] 🔄 Retrying with newly installed: ${installResult.installed}`)

            // Retry with the new tool
            const retryMethod = installResult.installed === 'plink' ? 'plink' : 'sshpass'
            const retry = buildSSHCommand(host, cmd, user, port, password, retryMethod, detectEnvironment())

            try {
                const output = runSSH(retry, 30000)
                if (params.userId) setActiveSSHContext(params.userId, host, user, port)
                if (password) saveHostCredentials(host, user, password)

                console.log(`[SSH] ✅ Self-healing SUCCESS! Connected via ${retryMethod}`)
                return { success: true, command: retry.display, output }
            } catch (retryErr: any) {
                if (isRemoteCommandFailure(retryErr, retryMethod)) {
                    return { success: false, command: retry.display, output: redactSecret(`${String(retryErr.stdout || '')}${String(retryErr.stderr || '')}`.trim(), password), error: `Befehl auf ${host} endete mit Exit-Code ${retryErr.status}` }
                }
                console.log(`[SSH] ❌ Self-healing retry also failed: ${redactSecret(String(retryErr.message || ''), password).slice(0, 100)}`)
            } finally {
                cleanupFiles(retry.cleanup)
            }
        }

        // Last resort: try to setup SSH key automatically
        console.log('[SSH] 🔑 Last resort: auto-setup SSH key...')
        const keyResult = await autoSetupSSHKey(host, user, password, port, detectEnvironment())
        if (keyResult.success) {
            // Retry with key auth
            const keyCmd = buildSSHCommand(host, cmd, user, port, '', 'key', detectEnvironment())
            try {
                const output = runSSH(keyCmd, 30000)
                if (params.userId) setActiveSSHContext(params.userId, host, user, port)
                console.log('[SSH] ✅ Connected via auto-generated SSH key!')
                return { success: true, command: keyCmd.display, output, action: keyResult.message }
            } catch (keyErr: any) {
                if (isRemoteCommandFailure(keyErr, 'key')) {
                    return { success: false, command: keyCmd.display, output: `${String(keyErr.stdout || '')}${String(keyErr.stderr || '')}`.trim(), error: `Befehl auf ${host} endete mit Exit-Code ${keyErr.status}`, action: keyResult.message }
                }
                console.log(`[SSH] ❌ Key auth after setup also failed: ${String(keyErr.message || '').slice(0, 100)}`)
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
        action: selfHealApproved
            ? `Ich habe ${methods.length} Methoden probiert (${methods.join(', ')}) und versucht fehlende Tools zu installieren. ${errorSummary}`
            : `Ich habe ${methods.length} Methoden probiert (${methods.join(', ')}). Ohne Freigabe installiere ich nichts und hinterlege keinen SSH-Key. ${errorSummary}${selfHealHint}`,
    }
}

/** PATH fix for exit 127: .bashrc first, then common binary directories. */
function healMissingCommand(
    host: string, cmd: string, user: string, port: number,
    password: string, method: string, env: SSHEnvironment
): { output: string; action: string; status: number } | null {
    const cmdName = cmd.trim().split(/\s+/)[0]
    console.log(`[SSH] ⚠️ "${cmdName}" not found on remote — trying PATH fix...`)

    // Retry 1: source ~/.bashrc first
    const bashrc = buildSSHCommand(host, `source ~/.bashrc 2>/dev/null; source ~/.profile 2>/dev/null; ${cmd}`, user, port, password, method, env)
    try {
        const fixOutput = runSSH(bashrc, 60000).trim()
        console.log(`[SSH] ✅ Fixed via .bashrc PATH! ${cmdName} works now.`)
        if (password) saveHostCredentials(host, user, password)
        return { output: fixOutput, action: `"${cmdName}" war nicht im SSH-PATH — hab .bashrc geladen und es hat funktioniert.`, status: 0 }
    } catch (err: any) {
        // It started this time: report that result, never run it again
        if (err?.status !== 127) return startedButFailed(err, cmdName, 'nach Laden der .bashrc')
    } finally {
        cleanupFiles(bashrc.cleanup)
    }

    // Retry 2: Try common binary paths
    const commonPaths = ['/usr/local/bin/', '/usr/bin/', '/snap/bin/', '/home/linuxbrew/.linuxbrew/bin/', `~/.local/bin/`]
    for (const binPath of commonPaths) {
        const withPath = buildSSHCommand(host, `${binPath}${cmd.trimStart()}`, user, port, password, method, env)
        try {
            const pathOutput = runSSH(withPath, 60000).trim()
            console.log(`[SSH] ✅ Found ${cmdName} at ${binPath}! Auto-healed.`)
            if (password) saveHostCredentials(host, user, password)
            return { output: pathOutput, action: `"${cmdName}" lag unter ${binPath} — SSH-PATH war unvollständig.`, status: 0 }
        } catch (err: any) {
            if (err?.status !== 127) return startedButFailed(err, cmdName, `unter ${binPath}`)
        } finally {
            cleanupFiles(withPath.cleanup)
        }
    }
    return null
}

function startedButFailed(err: any, cmdName: string, where: string): { output: string; action: string; status: number } {
    const status = typeof err?.status === 'number' ? err.status : -1
    return {
        output: `${String(err?.stdout || '')}${String(err?.stderr || '')}`.trim(),
        action: `"${cmdName}" lief ${where}, endete aber mit Exit-Code ${status}.`,
        status,
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
        { name: 'confirm', type: 'string' as const, description: 'Einmal-Freigabecode des Owners nur für die Selbstheilung (Tool-Installation/Key). Niemals selbst bilden.', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        return executeSSH({
            host: params.host as string,
            command: params.command as string,
            user: params.user as string | undefined,
            port: params.port as number | undefined,
            password: params.password as string | undefined,
            userId: typeof params.userId === 'string' ? params.userId : undefined,
            authorizationUserId: typeof params.authorizationUserId === 'string' ? params.authorizationUserId : undefined,
            channel: typeof params.channel === 'string' ? params.channel : undefined,
            confirm: typeof params.confirm === 'string' ? params.confirm : undefined,
        })
    },
}

export default sshTool
