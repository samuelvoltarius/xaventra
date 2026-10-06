/**
 * Nova Complete Tool Registry
 * 
 * Registers ALL available tools including:
 * - File operations
 * - System commands
 * - Browser tools
 * - Google Search (Playwright)
 * - Self-Extension (create new tools)
 * - Memory tools
 * - Learning tools
 * - Multi-Bot tools
 */

import * as pathModule from 'node:path'
import { join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { withRepairAdmission } from '../doctor/repair-drain-client.js'
import { callDockerHost } from '../host/docker-client.js'
import { sshTool } from './ssh-tool.js'
import { capabilityTool } from './capability-tool.js'
import { browserUseTools } from './browser-use.js'
import { ownerApprovalRefusal } from './owner-approval.js'
import { homeAssistantTools } from './homeassistant.js'
import { scanNowTool } from './scan-now-tool.js'
import { meshInspectUrlTool } from './mesh-inspect-url.js'
import { meshExchangeTools } from './mesh-exchange-tools.js'
import { meshScreenshotTool } from './mesh-screenshot-tool.js'
import { environmentInventoryTool } from './environment-inventory-tool.js'
import { parcelTrackTool } from './parcel-track-tool.js'
import { printerTools } from './3dprinter.js'
import { minimaxTools } from './minimax-tools.js'
import { blueTeamTools } from './blue-team-tools.js'
import { missionWorkspaceTools } from './mission-workspace-tools.js'
import { developerCapabilityTools } from './developer-capability-tools.js'
import { runFencedTool } from '../mesh/fence.js'

// ============================================
// Tool Interface
// ============================================

export interface NovaTool {
    name: string
    description: string
    category: 'file' | 'system' | 'browser' | 'memory' | 'learning' | 'bot' | 'security' | 'media' | 'mesh' | 'other'
    parameters: Array<{
        name: string
        type: 'string' | 'number' | 'boolean' | 'object'
        description: string
        required?: boolean
    }>
    handler: (params: Record<string, unknown>) => Promise<unknown>
}

// ============================================
// File access boundary (H6)
// ============================================

type FilePermission = 'owner' | 'admin' | 'user' | 'guest' | 'blocked'

/** Workspace root for file tools: configured root, else the process cwd. */
export function getFileToolWorkspaceRoot(): string {
    return pathModule.resolve(process.env.XAVENTRA_WORKSPACE_ROOT || process.env.NOVA_WORKSPACE_ROOT || process.cwd())
}

const IS_WINDOWS = process.platform === 'win32'
export const AUTO_PROVISION_DISABLED = 'Auto-Provisioning ist abgeschaltet und installiert nichts. Nutze self_setup_plan fuer einen belegten Vorschlag; installieren kann nur der Owner mit /setup apply.'

function comparablePath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return IS_WINDOWS ? normalized.toLowerCase() : normalized
}

/** Real path for existing targets (symlink escape), resolved path otherwise. */
function canonicalPath(path: string): string {
    try { return realpathSync.native(path) } catch { /* not existing yet */ }
    const { dirname, basename, join: joinPath } = pathModule
    const parent = dirname(path)
    if (parent === path) return path
    return joinPath(canonicalPath(parent), basename(path))
}

export function isPathWithin(root: string, target: string): boolean {
    const rel = pathModule.relative(comparablePath(root), comparablePath(target))
    return rel === '' || (!rel.startsWith('..') && !pathModule.isAbsolute(rel))
}

const SECRET_BASENAMES: RegExp[] = [
    /^\.env(?:\..*)?$/i,
    /^xaventra\.config\.json$/i,
    /^nova\.config\.json$/i,
    /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i,
    /id_(?:rsa|ed25519|ecdsa|dsa)/i,
    /^\.git-credentials$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pgpass$/i,
]
const SECRET_DIRECTORY_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']

/** True when the path names a secret file or lies in a secret directory. */
export function isSecretFilePath(path: string, root: string = getFileToolWorkspaceRoot()): boolean {
    const normalized = comparablePath(path)
    const segments = normalized.split('/').filter(Boolean)
    const base = segments[segments.length - 1] || ''
    if (SECRET_BASENAMES.some(pattern => pattern.test(base))) return true
    // Directory rules apply below the workspace root (the root itself may live
    // inside such a directory, e.g. a worktree under .nova-data).
    const scoped = isPathWithin(root, path)
        ? comparablePath(pathModule.relative(root, path)).split('/').filter(Boolean)
        : segments
    if (scoped.some(segment => SECRET_DIRECTORY_SEGMENTS.includes(segment.toLowerCase()))) return true
    let dataIndex = -1
    scoped.forEach((segment, index) => { if (segment.toLowerCase() === '.nova-data') dataIndex = index })
    if (dataIndex >= 0) {
        const inside = scoped.slice(dataIndex + 1).map(segment => segment.toLowerCase())
        if (inside[0] === 'multi-user') return true
        if (inside.some(segment => /(?:token|secret|credential|password|auth|private|\.key$)/i.test(segment))) return true
    }
    const home = comparablePath(homedir())
    if (normalized === home + '/.ssh' || normalized.startsWith(home + '/.ssh/')) return true
    return false
}

/**
 * INT-12: parent identity for subagents, taken from the authorized execution
 * context (governed executor) and otherwise from the runner-injected
 * userId/authorizationUserId. Never from model-authored task fields.
 */
export async function subagentParentIdentity(params: Record<string, unknown>): Promise<{ userId?: string; authUserId?: string }> {
    const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
    const context = getExecutionPolicyContext()
    const clean = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
    const userId = clean(context.userId) || clean(context.authUserId) || clean(params.userId) || clean(params.authorizationUserId)
    const authUserId = clean(context.authUserId) || (clean(context.userId) ? undefined : clean(params.authorizationUserId)) || userId
    return { ...(userId ? { userId } : {}), ...(authUserId ? { authUserId } : {}) }
}

/** Knowledge-graph scopes for the (runner-injected) requester; undefined = owner, all scopes. */
export async function kgSearchScopes(params: Record<string, unknown>): Promise<string[] | undefined> {
    if (await filePermissionFor(params) === 'owner') return undefined
    const { principalScope } = await import('../users/principal-id.js')
    const ids = [params.userId, params.authorizationUserId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    return [...new Set([...ids.map(id => principalScope(id)), 'global'])]
}

async function filePermissionFor(params: Record<string, unknown>): Promise<FilePermission> {
    const id = typeof params.authorizationUserId === 'string' ? params.authorizationUserId : ''
    if (!id) return 'guest'
    try {
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        return getUserPermission(id, typeof params.channel === 'string' ? params.channel : undefined) as FilePermission
    } catch {
        return 'guest'
    }
}

/**
 * Resolves a model-supplied path and enforces the boundary: non-owner roles
 * stay inside the workspace root; secret files are denied to everyone unless
 * the owner explicitly enabled XAVENTRA_ALLOW_SECRET_FILE_READ=1.
 */
export async function resolveGuardedFilePath(params: Record<string, unknown>): Promise<{ path: string } | { error: string; blocked: true; path: string }> {
    const raw = String(params.path ?? '')
    const root = getFileToolWorkspaceRoot()
    const requested = pathModule.resolve(root, raw)
    const real = canonicalPath(requested)
    const permission = await filePermissionFor(params)
    if (permission === 'blocked') return { error: 'Zugriff verweigert.', blocked: true, path: raw }
    const privileged = permission === 'owner'
    if (!privileged && (!isPathWithin(root, requested) || !isPathWithin(canonicalPath(root), real))) {
        return { error: `Zugriff außerhalb des Arbeitsbereichs verweigert: ${raw}`, blocked: true, path: raw }
    }
    if ((isSecretFilePath(requested, root) || isSecretFilePath(real, canonicalPath(root)))
        && !(privileged && process.env.XAVENTRA_ALLOW_SECRET_FILE_READ === '1')) {
        return { error: `Geschützte Datei (Zugangsdaten/Konfiguration) wird nicht gelesen: ${raw}`, blocked: true, path: raw }
    }
    return { path: requested }
}

// ============================================
// File Tools
// ============================================

export const fileTools: NovaTool[] = [
    {
        name: 'read_document',
        description: 'Liest PDF-, DOCX-, XLSX-, PPTX-, Bild- und Textdateien mit lokaler Extraktion und passenden Fallbacks.',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Dokumentdatei', required: true },
        ],
        handler: async (params) => {
            const guarded = await resolveGuardedFilePath(params)
            if ('error' in guarded) return guarded
            const { readDocument } = await import('./document-reader.js')
            return readDocument(guarded.path)
        },
    },
    {
        name: 'read_file',
        description: 'Liest den Inhalt einer Datei. Unterstützt optionale start_line/end_line für gezieltes Lesen großer Dateien.',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Datei', required: true },
            { name: 'start_line', type: 'number', description: 'Erste Zeile (1-basiert, inklusiv). Optional.', required: false },
            { name: 'end_line', type: 'number', description: 'Letzte Zeile (1-basiert, inklusiv). Optional.', required: false },
        ],
        handler: async (params) => {
            const { readFileSync, existsSync, statSync } = await import('node:fs')
            const guarded = await resolveGuardedFilePath(params)
            if ('error' in guarded) return guarded
            const path = guarded.path
            if (!existsSync(path)) return { error: `Datei nicht gefunden: ${params.path}` }

            const content = readFileSync(path, 'utf-8')
            const startLine = params.start_line as number | undefined
            const endLine = params.end_line as number | undefined

            if (startLine || endLine) {
                const lines = content.split('\n')
                const start = Math.max(1, startLine || 1) - 1
                const end = Math.min(lines.length, endLine || lines.length)
                const slice = lines.slice(start, end)
                return {
                    content: slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n'),
                    total_lines: lines.length,
                    showing: `${start + 1}-${end}`,
                }
            }

            return { content, total_lines: content.split('\n').length }
        },
    },
    {
        name: 'write_file',
        description: 'Schreibt Inhalt in eine Datei. ACHTUNG: Geschützte System-Dateien (daemon.ts, auth/, core/, L0-*) können nicht autonom überschrieben werden.',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Datei', required: true },
            { name: 'content', type: 'string', description: 'Inhalt', required: true },
        ],
        handler: async (params) => {
            const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
            const { dirname, resolve, relative } = await import('node:path')
            const root = getFileToolWorkspaceRoot()
            const path = resolve(root, params.path as string)
            const rel = relative(root, path).replace(/\\/g, '/')

            // === SECURITY: never outside the workspace root (also via symlinks) ===
            if (!isPathWithin(root, path) || !isPathWithin(canonicalPath(root), canonicalPath(path))) {
                console.log(`[SECURITY] BLOCKED write outside workspace: ${params.path}`)
                return {
                    error: `GESCHUETZT: "${params.path}" liegt ausserhalb des Arbeitsbereichs. Schreibvorgang blockiert.`,
                    blocked: true,
                    path: rel,
                }
            }

            // === SECURITY: Protected Paths (Prompt Injection → RCE Prevention) ===
            const PROTECTED_PATTERNS = [
                /^src\/daemon\.ts$/,
                /^src\/core\//,
                /^src\/auth\//,
                /^src\/layers\/L0/,
                /^src\/layers\/L1/,
                /^src\/agents\/nova-runner\.ts$/,
                /^src\/tools\/complete-registry\.ts$/,
                /^src\/tools\/tool-router\.ts$/,
                /^src\/tools\/tool-policy\.ts$/,
                /^\.env/,
                /^nova\.config\.json$/,
                /^xaventra\.config\.json$/,
                /^\.nova-data\/multi-user\//,
                // R2 T24: files here are auto-registered as executable tools on startup
                /^\.nova-tools\//,
                /^dist\//,
                /^package\.json$/,
                /^tsconfig\.json$/,
                /^scripts\/deploy/,
            ]

            // Case-insensitive: on Windows "XAVENTRA.CONFIG.JSON" is the same file.
            const isProtected = PROTECTED_PATTERNS.some(p => new RegExp(p.source, 'i').test(rel))
                || isSecretFilePath(path, root)
            if (isProtected) {
                console.log(`[SECURITY] 🚨 BLOCKED write to protected path: ${rel}`)
                return {
                    error: `🚨 GESCHÜTZT: "${rel}" ist ein System-kritischer Pfad. Änderungen an Core-Dateien (daemon, auth, L0, config) erfordern manuelle Bestätigung durch den Admin. Nutze update_memory um die gewünschte Änderung zu dokumentieren.`,
                    blocked: true,
                    path: rel,
                }
            }

            // === SECURITY: Content Analysis (basic injection detection) ===
            const content = params.content as string
            const DANGEROUS_PATTERNS = [
                /child_process/i,
                /\.exec\s*\(/,
                /\.spawn\s*\(/,
                /eval\s*\(/,
                /Function\s*\(/,
                /require\s*\(\s*['"]child/,
                /import\s*\(\s*['"]child/,
                /curl\s+.*\|\s*bash/i,
                /wget\s+.*\|\s*sh/i,
                /reverse.?shell/i,
                /\/etc\/shadow/,
                /\/etc\/passwd/,
            ]

            const hasDangerousContent = DANGEROUS_PATTERNS.some(p => p.test(content))
            if (hasDangerousContent) {
                console.log(`[SECURITY] 🚨 BLOCKED dangerous content in write to: ${rel}`)
                return {
                    error: `🚨 GEFÄHRLICHER INHALT erkannt in "${rel}". Der Inhalt enthält potenziell schädliche Patterns (child_process, exec, eval, shell injection). Schreibvorgang blockiert.`,
                    blocked: true,
                    path: rel,
                }
            }

            // === Code Guardian: AST + Sandbox + Signed Patches ===
            try {
                const { fullSecurityCheck, recordMetric } = await import('../security/code-guardian.js')
                recordMetric('write_attempt', 1)
                recordMetric('code_gen', content.length)

                // Full check for code files
                if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(rel)) {
                    const check = await fullSecurityCheck(content, rel, 'nova-self')
                    if (!check.allowed) {
                        console.log(`[CodeGuardian] 🚨 BLOCKED: ${check.reason}`)
                        return {
                            error: `🛡️ Code Guardian hat den Schreibvorgang blockiert:\n${check.reason}\n\nConfidence: ${check.signature.confidence}\nHash: ${check.signature.hash}`,
                            blocked: true,
                            path: rel,
                            signature: check.signature,
                        }
                    }
                }
            } catch (guardErr) {
                // FAIL-CLOSED: Frueher liess ein Fehler IN der Pruefung den
                // Schreibvorgang durch ("allow write"). Bei Codedateien wird
                // jetzt abgelehnt statt ungeprueft geschrieben.
                if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(rel)) {
                    console.error('[CodeGuardian] Pruefung fehlgeschlagen - Schreibvorgang abgelehnt: ' + guardErr);
                    return {
                        error: 'Code Guardian konnte nicht pruefen (' + String(guardErr).slice(0, 200) + '). '
                             + 'Schreibvorgang abgelehnt - ungeprueften Code schreibe ich auf diesem System nicht.',
                        blocked: true,
                        path: rel,
                    }
                }
                /* Nicht-Code: weiterhin erlaubt — allow write */ }

            const dir = dirname(path)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(path, content)
            return { success: true, path: rel }
        },
    },
    {
        name: 'list_directory',
        description: 'Listet Dateien und Ordner in einem Verzeichnis auf',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zum Verzeichnis', required: true },
        ],
        handler: async (params) => {
            const { readdirSync, statSync } = await import('node:fs')
            const guarded = await resolveGuardedFilePath(params)
            if ('error' in guarded) return guarded
            const path = guarded.path
            const entries = readdirSync(path)
            const result = entries.map(e => {
                const fullPath = join(path, e)
                const stat = statSync(fullPath)
                return {
                    name: e,
                    type: stat.isDirectory() ? 'directory' : 'file',
                    size: stat.size,
                }
            })
            return { entries: result }
        },
    },
    {
        name: 'delete_file',
        description: 'Löscht eine Datei oder Ordner',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Datei/Ordner', required: true },
        ],
        handler: async (params) => {
            const { rmSync } = await import('node:fs')
            rmSync(params.path as string, { recursive: true, force: true })
            return { success: true }
        },
    },
]

// ============================================
// System Tools
// ============================================

// CWD Tracking: Nova remembers the last working directory
let lastUsedCwd: string | null = null

export const systemTools: NovaTool[] = [
    {
        name: 'run_command',
        description: 'Führt einen Shell-Befehl aus. Merkt sich das letzte Arbeitsverzeichnis. WICHTIG: Vor install-Befehlen (npm/pip/etc.) IMMER zuerst mit readfile oder listdir prüfen welche Dateien vorhanden sind! package.json → npm, requirements.txt → pip, Cargo.toml → cargo. Nicht raten — lesen!',
        category: 'system',
        parameters: [
            { name: 'command', type: 'string', description: 'Befehl', required: true },
            { name: 'cwd', type: 'string', description: 'Arbeitsverzeichnis (optional — wird automatisch vom letzten Befehl übernommen)', required: false },
        ],
        handler: async (params) => {
            const { execSync } = await import('node:child_process')
            const { existsSync } = await import('node:fs')
            let command = params.command as string

            // ============================================
            // L8 Prisma Guards: Block dangerous DB operations
            // ============================================
            // UEB-7: fail-closed. If the guard cannot be loaded or evaluated,
            // the command does not run; and there is no confirmation path here,
            // so the message does not promise one.
            let safety: { blocked: boolean; reason?: string; suggestion?: string }
            try {
                const prismaGuards = await import('../layers/L8-prisma-guards.js')
                safety = prismaGuards.default.checkDatabaseSafety(command)
            } catch (error) {
                console.log(`[L8 PrismaGuards] Guard unavailable, command refused: ${String(error).slice(0, 120)}`)
                return `❌ Befehl nicht ausgeführt: Der Datenbank-Schutz (L8) konnte nicht geladen oder geprüft werden (${String(error).slice(0, 120)}). Ohne diese Prüfung führt run_command keine Befehle aus.`
            }
            if (safety?.blocked) {
                console.log(`[L8 PrismaGuards] Blocked: ${safety.reason}`)
                return `🛑 **Vom Datenbank-Schutz blockiert**\n\n${safety.reason}\n${safety.suggestion ? `\n💡 ${safety.suggestion}` : ''}\n\n_run_command führt diesen Befehl nicht aus; eine Freigabe über dieses Werkzeug gibt es nicht. Wenn er wirklich nötig ist, muss der Owner ihn selbst ausführen._`
            }

            // ============================================
            // SECURITY: Dangerous Command Detection
            // ============================================
            const cmdLower = command.toLowerCase()
            const DANGEROUS_CMD_PATTERNS = [
                /curl\s+.*\|\s*(ba)?sh/i,           // curl | bash (remote code exec)
                /wget\s+.*\|\s*(ba)?sh/i,           // wget | sh
                /rm\s+-rf\s+\//,                    // rm -rf / (wipe root)
                /mkfs\./,                            // format disk
                /dd\s+if=.*of=\/dev/,               // overwrite disk
                /:(){ :\|:& };:/,                   // fork bomb
                />\s*\/dev\/sd[a-z]/,               // overwrite block device
                /nc\s+.*-e\s+\/bin/i,               // netcat reverse shell
                /bash\s+-i\s+>&\s+\/dev\/tcp/i,     // bash reverse shell
                /python.*-c.*socket.*connect/i,     // python reverse shell
            ]

            const isDangerous = DANGEROUS_CMD_PATTERNS.some(p => p.test(command))
            if (isDangerous) {
                console.log(`[SECURITY] 🚨 BLOCKED dangerous command: ${command.slice(0, 100)}`)
                return {
                    error: `🚨 GEFÄHRLICHER BEFEHL blockiert! Der Befehl enthält bekannte Angriffsmuster (Shell-Injection, Reverse-Shell, Disk-Wipe). Ausführung verweigert.`,
                    blocked: true,
                }
            }

            // === Anomaly Detection: Record metrics ===
            try {
                const { recordMetric, isKillSwitchActive, getKillSwitchStatus } = await import('../security/code-guardian.js')
                recordMetric('shell_cmd', command.length)
                recordMetric('tool_call', 1)
                if (isKillSwitchActive()) {
                    const ks = getKillSwitchStatus()
                    return { error: `🚨 Kill-Switch aktiv: ${ks.reason}. Keine Befehle erlaubt bis Admin zurücksetzt.`, blocked: true }
                }
            } catch (ksErr) {
                // FAIL-CLOSED: Ein Fehler in der Not-Aus-Pruefung darf den
                // Befehl nicht durchlassen - das lief hier als root.
                console.error('[KillSwitch] Pruefung fehlgeschlagen - Befehl abgelehnt: ' + ksErr);
                return {
                    error: 'Not-Aus-Pruefung fehlgeschlagen (' + String(ksErr).slice(0, 200) + '). '
                         + 'Befehl abgelehnt.',
                    blocked: true,
                }
            }

            // ============================================
            // CWD Tracking: Remember last working directory
            // ============================================
            const explicitCwd = params.cwd as string | undefined
            let cwd: string

            if (explicitCwd) {
                cwd = explicitCwd
            } else if (lastUsedCwd && existsSync(lastUsedCwd)) {
                cwd = lastUsedCwd
                console.log(`[run_command] ?? Reusing last CWD: ${cwd}`)
            } else {
                // Default to workspace root, not nova-core
                try {
                    const { readFileSync } = await import('node:fs')
                    const { join } = await import('node:path')
                    const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf-8'))
                    cwd = cfg.workspace?.root || process.cwd()
                } catch { cwd = process.cwd() }
            }

            // Detect cd commands and update CWD tracking
            const cdMatch = command.match(/^cd\s+["']?([^"'&|;]+)["']?\s*(?:[&|;]|$)/i)
            if (cdMatch) {
                const { resolve } = await import('node:path')
                const targetDir = resolve(cwd, cdMatch[1].trim())
                if (existsSync(targetDir)) {
                    lastUsedCwd = targetDir
                    console.log(`[run_command] ?? CWD updated: ${targetDir}`)
                    // If the command is ONLY cd, return success immediately
                    if (/^cd\s+["']?[^"'&|;]+["']?\s*$/i.test(command)) {
                        return { success: true, cwd: targetDir, output: `Arbeitsverzeichnis: ${targetDir}` }
                    }
                    // Otherwise strip the cd and run the rest in the new dir
                    cwd = targetDir
                    command = command.replace(/^cd\s+["']?[^"'&|;]+["']?\s*[&|;]\s*/i, '')
                }
            }

            // ============================================
            // ENV_MAP: Rewrite commands to use discovered paths
            // ============================================
            try {
                const { getBinaryPath } = await import('../startup/environment-scanner.js')

                // Rewrite python ? full path
                if (/^python3?\s+/i.test(command)) {
                    const pythonPath = getBinaryPath('python')
                    if (pythonPath) {
                        command = command.replace(/^python3?\s+/i, `"${pythonPath}" `)
                        console.log(`[run_command] Rewritten to: ${command.slice(0, 80)}...`)
                    }
                }

                // Rewrite pip ? python -m pip (more reliable)
                if (/^pip3?\s+/i.test(command)) {
                    const pythonPath = getBinaryPath('python')
                    if (pythonPath) {
                        command = command.replace(/^pip3?\s+/i, `"${pythonPath}" -m pip `)
                        console.log(`[run_command] Rewritten pip to: ${command.slice(0, 80)}...`)
                    }
                }
            } catch {
                // ENV_MAP not available, use commands as-is
            }

            // ============================================
            // LINUX ? WINDOWS Auto-Translation
            // LLM sometimes uses Linux commands on Windows
            // ============================================
            if (process.platform === 'win32') {
                // Network commands - catch ALL ip variants
                if (/^ip\s+/i.test(command)) {
                    const oldCmd = command
                    command = 'arp -a'
                    console.log(`[run_command] ?? Linux?Windows: "${oldCmd}" ? "${command}"`)
                }
                if (/^ifconfig/i.test(command)) {
                    command = command.replace(/^ifconfig/i, 'ipconfig')
                    console.log(`[run_command] ?? Linux?Windows: ifconfig ? ipconfig`)
                }
                // File commands
                if (/^ls(\s|$)/i.test(command)) {
                    command = command.replace(/^ls/i, 'dir')
                    console.log(`[run_command] ?? Linux?Windows: ls ? dir`)
                }
                if (/^cat\s+/i.test(command)) {
                    command = command.replace(/^cat\s+/i, 'type ')
                    console.log(`[run_command] ?? Linux?Windows: cat ? type`)
                }
                // grep ? find or findstr
                if (/\|\s*grep\s+/i.test(command)) {
                    command = command.replace(/\|\s*grep\s+(['"]?)([^'"|\s]+)\1/gi, '| find "$2"')
                    console.log(`[run_command] ?? Linux?Windows: grep ? find`)
                }
            }

            // ============================================
            // PRE-FLIGHT: Package manager sanity checks
            // Prevent blind npm install in Python projects etc.
            // ============================================
            if (/^npm\s+(install|i|ci)(\s|$)/i.test(command)) {
                const pkgJson = `${cwd}/package.json`
                const reqTxt = `${cwd}/requirements.txt`
                const setupPy = `${cwd}/setup.py`
                const pyprojectToml = `${cwd}/pyproject.toml`
                if (!existsSync(pkgJson)) {
                    const isPython = existsSync(reqTxt) || existsSync(setupPy) || existsSync(pyprojectToml)
                    return {
                        error: `❌ Kein package.json in ${cwd} — npm install kann hier nichts tun.`,
                        hint: isPython
                            ? `Dies ist ein PYTHON-Projekt! Nutze stattdessen: pip install -r requirements.txt`
                            : `Prüfe ob du im richtigen Verzeichnis bist. Nutze readfile oder listdir um die Dateien zu prüfen.`,
                        cwd,
                        filesFound: isPython ? 'requirements.txt / setup.py erkannt' : 'Kein Paketmanager-Config gefunden',
                    }
                }
            }

            if (/^pip3?\s+install\s+-r\s+(\S+)/i.test(command)) {
                const reqMatch = command.match(/^pip3?\s+install\s+-r\s+(\S+)/i)
                const reqFile = reqMatch?.[1] || 'requirements.txt'
                const fullReqPath = reqFile.startsWith('/') || reqFile.includes(':') ? reqFile : `${cwd}/${reqFile}`
                if (!existsSync(fullReqPath)) {
                    return {
                        error: `❌ ${reqFile} nicht gefunden in ${cwd}`,
                        hint: `Prüfe den Pfad mit listdir. Die Datei muss existieren bevor pip install läuft.`,
                        cwd,
                    }
                }
            }

            // PRE-FLIGHT CHECK: If running a script file, verify it exists first
            // Skip checks for module execution (python -m, npm run, etc.)
            const isModuleExecution = /^(python|python3|py)\s+-m\s+/i.test(command) ||
                /^(pip|pip3)\s+/i.test(command) ||
                /^npm\s+(run|install|i)\s+/i.test(command) ||
                /^(npx|pnpm|yarn)\s+/i.test(command) ||
                /^(curl|wget|powershell|cmd)\s+/i.test(command)

            if (!isModuleExecution) {
                const scriptMatch = command.match(/^(node|python|python3|tsx|npx ts-node|bun)\s+([^\s]+)/)
                if (scriptMatch) {
                    const [, runtime, scriptPath] = scriptMatch
                    // Skip if it looks like a flag or option
                    if (scriptPath.startsWith('-')) {
                        // It's a flag like -m, -c, etc. - not a script file
                    } else {
                        const fullPath = scriptPath.startsWith('/') || scriptPath.includes(':')
                            ? scriptPath
                            : `${cwd}/${scriptPath}`

                        if (!existsSync(fullPath)) {
                            return {
                                action: 'CREATE_FILE_FIRST',
                                error: `Script fehlt: ${fullPath}`,
                                missingFile: fullPath,
                                hint: `Erstelle die Datei zuerst mit write_file bevor du sie ausführen kannst`,
                            }
                        }
                    }
                }
            }

            try {
                // In NovaOS ist "installier mir X" der Hauptzweck: apt-Upgrades,
                // Kompilierlaeufe und grosse Downloads brauchen laenger als 4 min.
                // Ein mittendrin abgeschossenes Paket ist schlimmer als ein
                // abgelehntes. Ausserhalb von NovaOS bleibt es bei 240 s.
                const cmdTimeout = Number(process.env.NOVA_CMD_TIMEOUT_MS)
                    || (process.env.NOVA_OS_MODE === 'true' ? 1_800_000 : 240_000)
                const output = execSync(command, {
                    cwd,
                    encoding: 'utf-8',
                    timeout: cmdTimeout,
                })
                // Save CWD for follow-up commands
                lastUsedCwd = cwd
                return { success: true, output: output.toString().slice(0, 10000), cwd }
            } catch (err: any) {
                const stderr = err.stderr?.toString() || err.message || ''

                // ── Rueckgabewert != 0 ist KEIN Werkzeugfehler ────────────
                // execSync wirft bei jedem Rueckgabewert ungleich 0. Fuer
                // `which`, `grep`, `test`, `diff`, `pgrep` und viele andere
                // ist das aber die normale Art, "nichts gefunden" zu sagen.
                //
                // Vorher landete Nova deshalb bei: "❌ Ergebnis nicht
                // verifiziert: tool reported failure. Rohdaten: Command
                // failed: which chromium ..." — sie konnte also nicht einmal
                // feststellen, dass KEIN Browser installiert ist, ohne dass
                // das als Fehlschlag gewertet wurde. Damit ist jede
                // Erkundung unmoeglich. Am 30.08.2026 am laufenden System
                // nachgewiesen.
                //
                // Lief der Befehl wirklich (es gibt einen Rueckgabewert) und
                // wurde er nicht abgeschossen, geben wir das Ergebnis samt
                // Ausgabe zurueck — mit Rueckgabewert, ohne Fehlerfeld.
                const rueckgabe = typeof err?.status === 'number' ? err.status : null
                const abgeschossen = Boolean(err?.signal) || err?.code === 'ETIMEDOUT'
                if (rueckgabe !== null && rueckgabe !== 0 && !abgeschossen) {
                    lastUsedCwd = cwd
                    const ausgabe = (err.stdout?.toString() || '').slice(0, 10000)
                    const fehlerstrom = (err.stderr?.toString() || '').slice(0, 4000)
                    return {
                        success: true,
                        exitCode: rueckgabe,
                        output: ausgabe,
                        stderr: fehlerstrom,
                        cwd,
                        hinweis: `Der Befehl lief und endete mit Rueckgabewert ${rueckgabe}. `
                            + `Das ist kein Absturz: bei Suchbefehlen (which, grep, test, pgrep) `
                            + `bedeutet es schlicht "nichts gefunden". Werte die Ausgabe aus.`,
                    }
                }

                // Smart detection of missing commands with alternatives
                const missingCmdAlternatives: Record<string, { alt: string; install: string }> = {
                    nmap: { alt: 'netstat -an, arp -a', install: 'winget install nmap' },
                    curl: { alt: 'Invoke-WebRequest (PowerShell)', install: 'winget install curl' },
                    wget: { alt: 'curl, Invoke-WebRequest', install: 'winget install wget' },
                    grep: { alt: 'find, findstr, Select-String', install: '(Windows hat find/findstr)' },
                    ssh: { alt: 'Tailscale SSH', install: 'winget install openssh' },
                    git: { alt: '-', install: 'winget install git' },
                    python: { alt: '-', install: 'winget install python' },
                    node: { alt: '-', install: 'winget install nodejs' },
                }

                // Check if it's a "command not found" error
                if (stderr.includes('nicht gefunden') || stderr.includes('not recognized') || stderr.includes('not found')) {
                    // Extract command name
                    const cmdMatch = command.match(/^(\S+)/)
                    const cmdName = cmdMatch?.[1]?.toLowerCase()

                    if (cmdName && missingCmdAlternatives[cmdName]) {
                        const info = missingCmdAlternatives[cmdName]
                        return {
                            error: `? ${cmdName} ist nicht installiert.`,
                            alternatives: `?? Alternativen: ${info.alt}`,
                            install: `?? Installieren: ${info.install}`,
                        }
                    }
                }

                return { error: err.message, stderr }
            }
        },
    },
    {
        name: 'ssh_command',
        description: 'Führt einen Befehl auf einem Remote-Gerät via SSH aus (Pi, NAS, Server etc.). WICHTIG: Nutze dieses Tool für ALLE Befehle die auf einem anderen Gerät laufen sollen — NICHT run_command! Gespeicherte Hosts/Passwörter werden automatisch verwendet. Anführungszeichen im Befehl werden automatisch escaped.',
        category: 'system',
        parameters: [
            { name: 'host', type: 'string', description: 'Host/IP', required: true },
            { name: 'command', type: 'string', description: 'Befehl', required: true },
            { name: 'user', type: 'string', description: 'User z.B. abc', required: false },
            { name: 'port', type: 'number', description: 'Port z.B. 2223', required: false },
            { name: 'password', type: 'string', description: 'Passwort', required: false },
        ],
        handler: async (params) => {
            const { executeSSH } = await import('./ssh-tool.js')
            return executeSSH({
                host: params.host as string,
                command: params.command as string,
                user: params.user as string | undefined,
                port: params.port as number | undefined,
                password: params.password as string | undefined,
            })
        },
    },
    {
        name: 'get_env',
        description: 'Liest eine Umgebungsvariable',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Name der Variable', required: true },
        ],
        handler: async (params) => {
            return { value: process.env[params.name as string] ?? null }
        },
    },
    {
        name: 'health_status',
        description: 'Systemgesundheit prüfen: Disk Space, RAM, Nodes. Nutze für: self check, system check, status check, wie geht es dir, alles ok, bin ich gesund.',
        category: 'system',
        parameters: [],
        handler: async () => {
            try {
                const { runHealthCheck, formatHealthStatus } = await import('../layers/L0-health-monitor.js')
                const status = runHealthCheck()
                return { ...status, formatted: formatHealthStatus(status) }
            } catch {
                return { error: 'Health Monitor nicht verfügbar' }
            }
        },
    },
    {
        name: 'update_user_profile',
        description: 'Aktualisiert das User-Profil (USER.md). Nutze das wenn du neue Fakten über den User lernst: Name, Geräte, IPs, Projekte, Präferenzen. Der content ersetzt den GESAMTEN Inhalt von USER.md.',
        category: 'system',
        parameters: [
            { name: 'content', type: 'string', description: 'Neuer Inhalt für USER.md (Markdown)', required: true },
        ],
        handler: async (args: any) => {
            try {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                const record = await getMemoryGovernanceCoordinator().record({
                    content: String(args.content || ''), kind: 'context',
                    scope: `user:${String(args.userId || 'system')}`, source: 'update_user_profile',
                    evidence: 'explicit_user_instruction', confidence: 1, verified: true,
                })
                return { success: Boolean(record), governanceId: record?.id, lifecycle: record?.status }
            } catch (err) {
                return { error: `USER.md Update fehlgeschlagen: ${err}` }
            }
        },
    },
    {
        name: 'update_memory',
        description: 'Fügt einen Eintrag zum Langzeit-Gedächtnis (MEMORY.md) hinzu. Nutze das für wichtige Entscheidungen, gelöste Probleme, gelernte Lektionen.',
        category: 'system',
        parameters: [
            { name: 'section', type: 'string', description: 'Abschnitt: "Gelöste Probleme", "Wichtige Entscheidungen", oder "Gelernte Lektionen"', required: true },
            { name: 'entry', type: 'string', description: 'Der Eintrag (kurz und prägnant)', required: true },
        ],
        handler: async (args: any) => {
            try {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                const record = await getMemoryGovernanceCoordinator().record({
                    content: `${String(args.section || 'Memory')}: ${String(args.entry || '')}`,
                    kind: 'learning', scope: `user:${String(args.userId || 'system')}`,
                    source: 'update_memory', evidence: 'explicit_user_instruction', confidence: 1, verified: true,
                })
                return { success: Boolean(record), governanceId: record?.id, lifecycle: record?.status }
            } catch (err) {
                return { error: `MEMORY.md Update fehlgeschlagen: ${err}` }
            }
        },
    },
    {
        name: 'get_current_time',
        description: 'Gibt die exakte aktuelle Systemzeit zurück. NUTZE DAS wenn du die Uhrzeit brauchst — NIEMALS raten oder schätzen! Dieses Tool liefert die echte Systemuhr.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const now = new Date()
            const h = now.getHours()
            let tageszeit = 'Nacht'
            if (h >= 5 && h < 8) tageszeit = 'Früher Morgen'
            else if (h >= 8 && h < 10) tageszeit = 'Morgen'
            else if (h >= 10 && h < 12) tageszeit = 'Vormittag'
            else if (h >= 12 && h < 14) tageszeit = 'Mittag'
            else if (h >= 14 && h < 17) tageszeit = 'Nachmittag'
            else if (h >= 17 && h < 20) tageszeit = 'Abend'
            else if (h >= 20 && h < 23) tageszeit = 'Spätabend'
            else if (h >= 0 && h < 5) tageszeit = 'Nacht (spät/früh)'

            return {
                uhrzeit: now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                datum: now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                wochentag: now.toLocaleDateString('de-DE', { weekday: 'long' }),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                tageszeit,
                unix_timestamp: Date.now(),
                iso: now.toISOString(),
            }
        },
    },
    {
        name: 'set_quiet_hours',
        description: 'Setzt Novas Ruhezeiten (Quiet Hours). Nutze dieses Tool wenn der User sagt er möchte nicht gestört werden, nur im Notfall kontaktiert werden, oder die Ruhezeiten ändern möchte.',
        category: 'system',
        parameters: [
            { name: 'mode', type: 'string', description: 'Modus: "on" (Standard 23-07), "off" (24/7 erreichbar), "emergency" (nur Notfälle), "custom" (eigene Zeiten)', required: true },
            { name: 'start', type: 'number', description: 'Startzeit (0-23) — nur bei mode=custom', required: false },
            { name: 'end', type: 'number', description: 'Endzeit (0-23) — nur bei mode=custom', required: false },
        ],
        handler: async (params) => {
            try {
                const { updateAutonomyConfig, getAutonomyStatus } = await import('../core/autonomy-loop.js')
                const mode = (params.mode as string || 'on').toLowerCase()

                if (mode === 'on' || mode === 'an') {
                    const { DEFAULT_QUIET_HOURS } = await import('../core/quiet-hours.js')
                    updateAutonomyConfig({ quietHoursStart: DEFAULT_QUIET_HOURS.start, quietHoursEnd: DEFAULT_QUIET_HOURS.end })
                    return { success: true, message: `Quiet Hours aktiviert: ${DEFAULT_QUIET_HOURS.start}:00 - 0${DEFAULT_QUIET_HOURS.end}:00 (gilt für alle Meldungen). Keine autonomen Nachrichten in dieser Zeit.` }
                }

                if (mode === 'off' || mode === 'aus') {
                    updateAutonomyConfig({ quietHoursStart: -1, quietHoursEnd: -1 })
                    return { success: true, message: 'Quiet Hours deaktiviert. Xaventra kann dich rund um die Uhr kontaktieren.' }
                }

                if (mode === 'emergency' || mode === 'notfall' || mode === 'critical') {
                    updateAutonomyConfig({ quietHoursStart: 0, quietHoursEnd: 23, maxNotificationsPerHour: 1 })
                    return { success: true, message: 'Nur-Notfall Modus aktiviert. Xaventra meldet sich nur bei kritischen Problemen (max 1x/Stunde).' }
                }

                if (mode === 'custom') {
                    const start = params.start as number ?? 22
                    const end = params.end as number ?? 7
                    if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
                        updateAutonomyConfig({ quietHoursStart: start, quietHoursEnd: end })
                        return { success: true, message: `Quiet Hours angepasst: ${start}:00 - ${end}:00` }
                    }
                    return { success: false, message: 'Ungültige Zeiten. Bitte 0-23 verwenden.' }
                }

                if (mode === 'status') {
                    const status = getAutonomyStatus()
                    return {
                        enabled: status.config.quietHoursStart >= 0,
                        start: status.config.quietHoursStart,
                        end: status.config.quietHoursEnd,
                        maxNotificationsPerHour: status.config.maxNotificationsPerHour,
                    }
                }

                return { success: false, message: 'Unbekannter Modus. Verfügbar: on, off, emergency, custom, status' }
            } catch (err) {
                return { success: false, error: `${err}` }
            }
        },
    },
]

// ============================================
// Browser/Web Tools
// ============================================

export const browserTools: NovaTool[] = [
    {
        name: 'web_search',
        description: 'Sucht im Internet mit DuckDuckGo (kein API-Key nötig)',
        category: 'browser',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchanfrage', required: true },
            { name: 'count', type: 'number', description: 'Anzahl Ergebnisse', required: false },
        ],
        handler: async (params) => {
            const query = encodeURIComponent(params.query as string)
            const count = (params.count as number) || 5

            try {
                const response = await fetch(
                    `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`
                )
                const data = await response.json() as any

                const results = []
                if (data.AbstractText) {
                    results.push({ type: 'abstract', text: data.AbstractText, url: data.AbstractURL })
                }
                for (const topic of (data.RelatedTopics || []).slice(0, count)) {
                    if (topic.Text) {
                        results.push({ type: 'topic', text: topic.Text, url: topic.FirstURL })
                    }
                }

                return { query: params.query, results }
            } catch (err: any) {
                return { error: err.message }
            }
        },
    },
    {
        name: 'google_search',
        description: 'Sucht mit Google über Headless-Browser (Playwright). Gibt echte Suchergebnisse zurück.',
        category: 'browser',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchanfrage', required: true },
            { name: 'count', type: 'number', description: 'Anzahl Ergebnisse (max 10)', required: false },
        ],
        handler: async (params) => {
            try {
                const { googleSearch } = await import('./google-search.js')
                return googleSearch(params.query as string, (params.count as number) || 5)
            } catch (err: any) {
                // Fallback to DuckDuckGo if Playwright not available
                console.log('[Google Search] Playwright nicht verfügbar, nutze DuckDuckGo Fallback')
                const webSearch = browserTools.find(t => t.name === 'web_search')
                if (webSearch) return webSearch.handler(params)
                return { error: err.message }
            }
        },
    },
    {
        name: 'fetch_url',
        description: 'Lädt den Inhalt einer URL herunter und konvertiert HTML zu sauberem Markdown.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'URL', required: true },
            { name: 'raw', type: 'boolean', description: 'Wenn true, wird rohes HTML zurückgegeben statt Markdown', required: false },
        ],
        handler: async (params) => {
            try {
                const { fetchWithSsrfGuard } = await import('../resilience/ssrf-guard.js')
                const response = await fetchWithSsrfGuard(params.url as string)
                const text = await response.text()

                // Return raw HTML if requested
                if (params.raw) {
                    return { status: response.status, content: text.slice(0, 50000) }
                }

                // Convert HTML to clean Markdown
                let md = text
                // Remove script, style, noscript blocks
                md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                md = md.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
                // Remove HTML comments
                md = md.replace(/<!--[\s\S]*?-->/g, '')
                // Convert headings
                md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
                md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
                md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
                md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n')
                // Convert links
                md = md.replace(/<a[^>]*href="([^"]*?)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
                // Convert bold/italic
                md = md.replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**')
                md = md.replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*')
                // Convert lists
                md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
                // Convert paragraphs and line breaks
                md = md.replace(/<\/p>/gi, '\n\n')
                md = md.replace(/<br\s*\/?>/gi, '\n')
                // Convert code blocks
                md = md.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gi, '```\n$1\n```')
                md = md.replace(/<code>(.*?)<\/code>/gi, '`$1`')
                // Strip remaining HTML tags
                md = md.replace(/<[^>]+>/g, '')
                // Decode common HTML entities
                md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
                // Collapse whitespace
                md = md.replace(/\n{3,}/g, '\n\n').trim()

                return {
                    status: response.status,
                    content: md.slice(0, 50000),
                    url: params.url,
                }
            } catch (err: any) {
                return { error: err.message }
            }
        },
    },
]

// ============================================
// Memory Tools
// ============================================

export const memoryTools: NovaTool[] = [
    {
        name: 'remember',
        description: 'Speichert Information über die zentrale Memory-Governance; Herkunft, Konflikte und Gültigkeit werden vor LanceDB geprüft.',
        category: 'memory',
        parameters: [
            { name: 'content', type: 'string', description: 'Was soll gemerkt werden', required: true },
            { name: 'type', type: 'string', description: 'Typ: fact, conversation, learning, code, error_solution', required: false },
            { name: 'scope', type: 'string', description: 'Geltungsbereich, z.B. user:sample, node:spark oder global', required: false },
        ],
        handler: async (params) => {
            const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
            const type = String(params.type || 'fact')
            const kind = type === 'learning' ? 'learning' : type === 'conversation' ? 'context' : 'fact'
            const record = await getMemoryGovernanceCoordinator().record({
                content: String(params.content || ''),
                kind,
                scope: String(params.scope || `user:${String(params.userId || 'system')}`),
                source: 'remember-tool',
                evidence: 'user_statement',
                confidence: 0.9,
                verified: true,
            })
            if (!record) return { success: false, error: 'Memory-Governance rejected non-durable or unsafe content' }
            return {
                success: true,
                stored: record.content,
                governanceId: record.id,
                lifecycle: record.status,
                conflicts: record.conflictIds,
                backends: record.backends,
            }
        },
    },
    {
        name: 'recall',
        description: 'Ruft Erinnerungen aus dem Langzeit-Gedächtnis ab (LanceDB mit MMR, Temporal Decay, Hybrid Search)',
        category: 'memory',
        parameters: [
            { name: 'query', type: 'string', description: 'Wonach suchen', required: true },
            { name: 'limit', type: 'number', description: 'Max Anzahl Ergebnisse', required: false },
            { name: 'type', type: 'string', description: 'Filter nach Typ: fact, conversation, learning, code, error_solution', required: false },
        ],
        handler: async (params) => {
            try {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                const results = getMemoryGovernanceCoordinator().recall(
                    [`user:${String(params.userId || 'system')}`, 'global'],
                    String(params.query || ''), (params.limit as number) || 5,
                )
                return {
                    query: params.query,
                    backend: 'memory-governance',
                    memories: results.map(record => ({
                        id: record.id, content: record.content, type: record.kind,
                        lifecycle: record.status, confidence: record.confidence,
                        provenance: record.provenance,
                    })),
                }
            } catch (err) {
                return { query: params.query, backend: 'memory-governance', error: String(err), memories: [] }
            }
        },
    },
]

// ============================================
// Self-Evolution Tools
// ============================================

export const evolutionTools: NovaTool[] = [
    {
        name: 'self_evolve',
        description: 'Erzeugt einen exakten Quellpatch-Vorschlag und prüft ihn isoliert (PATCH_GATE-Warteschlange). Anwenden kann nur der Owner per Knopf-Karte; Live-Aktivierung über einen externen Release-Controller, Heilung benötigt unabhängige Live-Evidence.',
        category: 'system',
        parameters: [
            { name: 'file', type: 'string', description: 'Relativer Pfad zur Datei (z.B. src/core/runtime.ts)', required: true },
            { name: 'description', type: 'string', description: 'Was die Änderung bewirkt', required: true },
            { name: 'search', type: 'string', description: 'Exakter Text der ersetzt werden soll', required: true },
            { name: 'replace', type: 'string', description: 'Neuer Text', required: true },
            { name: 'repairProfileId', type: 'string', description: 'Vom Operator registriertes Quell-/Probe-Profil, keine freien Ziele', required: false },
            { name: 'reproductionTest', type: 'string', description: 'Vorhandener unveränderter src/*.test.ts-Regressionsbeleg: muss vorher fehlschlagen und danach bestehen', required: false },
            { name: 'reason', type: 'string', description: 'Warum diese Änderung', required: false },
        ],
        handler: async (params) => {
            const { evolve } = await import('../synthesis/self-evolution.js')
            return await evolve({
                file: params.file as string,
                description: params.description as string,
                search: params.search as string,
                replace: params.replace as string,
                reason: params.reason as string | undefined,
                // P9: no apply/approvalToken from the model — activation only via the PATCH_GATE card.
                repairProfileId: params.repairProfileId as string | undefined,
                reproductionTest: params.reproductionTest as string | undefined,
            })
        },
    },
    {
        name: 'patch_proposals',
        description: 'Listet reviewbare PATCH_GATE-Vorschlaege aus self_evolve.',
        category: 'system',
        parameters: [
            { name: 'limit', type: 'number', description: 'Max Anzahl Eintraege', required: false },
        ],
        handler: async (params) => {
            const { getPatchProposals } = await import('../synthesis/self-evolution.js')
            return getPatchProposals((params.limit as number) || 20)
        },
    },
    {
        name: 'evolution_history',
        description: 'Zeigt die letzten Self-Evolution-Änderungen an',
        category: 'system',
        parameters: [
            { name: 'limit', type: 'number', description: 'Max Anzahl Einträge', required: false },
        ],
        handler: async (params) => {
            const { getEvolutionHistory } = await import('../synthesis/self-evolution.js')
            return getEvolutionHistory((params.limit as number) || 20)
        },
    },
    {
        name: 'evolution_stats',
        description: 'Zeigt Statistiken über bisherige Self-Evolutions',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { getEvolutionStats } = await import('../synthesis/self-evolution.js')
            return getEvolutionStats()
        },
    },
    {
        name: 'self_doctor',
        description: 'Prueft Novas Health, Tool-Health, Trace-Insights, Mesh und Self-Update-Proposals und erzeugt eine reviewbare Verbesserungs-Queue.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { runSelfDoctor } = await import('../core/self-doctor.js')
            return await runSelfDoctor()
        },
    },
    {
        name: 'self_doctor_findings',
        description: 'Listet offene Self-Doctor Findings aus der lokalen Verbesserungs-Queue.',
        category: 'system',
        parameters: [
            { name: 'status', type: 'string', description: 'Optional: open, acknowledged, resolved oder dismissed', required: false },
            { name: 'limit', type: 'number', description: 'Maximale Anzahl Findings', required: false },
        ],
        handler: async (params) => {
            const { getDoctorFindings } = await import('../core/self-doctor.js')
            return getDoctorFindings({
                status: params.status as any,
                limit: (params.limit as number) || 20,
            })
        },
    },
    {
        name: 'self_doctor_update_finding',
        description: 'Setzt den Status eines Self-Doctor Findings, z.B. acknowledged, resolved oder dismissed.',
        category: 'system',
        parameters: [
            { name: 'id', type: 'string', description: 'Finding-ID', required: true },
            { name: 'status', type: 'string', description: 'open, acknowledged, resolved oder dismissed', required: true },
        ],
        handler: async (params) => {
            const { updateDoctorFindingStatus } = await import('../core/self-doctor.js')
            const ok = updateDoctorFindingStatus(String(params.id), params.status as any)
            return { success: ok }
        },
    },
    {
        name: 'import_skill',
        description: 'Installiert ein externes Agent Skill Paket (z.B. firebase/agent-skills). Nutzt npx skills add.',
        category: 'system',
        parameters: [
            { name: 'package', type: 'string', description: 'Paketname (z.B. firebase/agent-skills)', required: true },
            { name: 'confirm', type: 'string', description: 'Einmal-Freigabecode, den der Owner selbst nennt. Niemals selbst bilden.', required: false },
        ],
        handler: async (params) => {
            // R2 T28: third-party skill content ends up in the prompt for good
            // (and npx runs remote code): only on the owner's explicit say-so.
            const refusal = await ownerApprovalRefusal(params, 'import_skill', String(params.package ?? ''))
            if (refusal) return { success: false, message: refusal }
            const { importSkill } = await import('./skills-import-cli.js')
            return await importSkill(params.package as string)
        },
    },
    {
        name: 'list_skills',
        description: 'Listet alle installierten Agent Skills auf',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { listInstalledSkills } = await import('./skills-import-cli.js')
            const skills = listInstalledSkills()
            return skills.length > 0 ? `Installierte Skills: ${skills.join(', ')}` : 'Keine Skills installiert'
        },
    },
    {
        name: 'auto_fix',
        description: 'Versucht automatisch Build-Fehler zu fixen (tsc errors parsen, LLM fix, verify)',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { runAutoFixCycle } = await import('../layers/auto-bug-fix.js')
            const result = await runAutoFixCycle()
            return `AutoFix: ${result.fixed} gefixt, ${result.failed} fehlgeschlagen`
        },
    },
    {
        name: 'mesh_capabilities',
        description: 'Zeigt alle Capabilities aller Nodes + Cloud (was kann wer, welche Modelle wo)',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { getCapabilityMap, getMissingCapabilities } = await import('../mesh/capability-orchestrator.js')
            const map = getCapabilityMap()
            const missing = getMissingCapabilities()
            return map + (missing.length > 0 ? `\n\nFehlend: ${missing.join(', ')}` : '\n\nAlle Capabilities verfuegbar!')
        },
    },
    {
        name: 'codex_install',
        description: 'Installiert Codex persistent auf dem aktuellen Linux-Node. NUR verwenden, wenn Owner/Admin in der aktuellen Nachricht ausdrücklich verlangt, Codex zu installieren. Kein freier Shell-Befehl; Ziel muss der lokale Node/Main sein. Danach /codex login.',
        category: 'system',
        parameters: [
            { name: 'target_node', type: 'string', description: 'Explizit genannter Ziel-Node, z.B. spark, nova-spark oder current', required: false },
        ],
        handler: async (params) => {
            const { getUserPermission } = await import('../users/multi-user-middleware.js')
            const authorizationUserId = String(params.authorizationUserId || '')
            const permission = getUserPermission(authorizationUserId, String(params.channel || 'unknown'))
            if (permission !== 'owner' && permission !== 'admin') {
                return { success: false, message: 'Nur Owner/Admin dürfen Codex auf einem Node installieren.' }
            }
            const { installCodexOnLocalNode } = await import('../auth/codex-installer.js')
            return installCodexOnLocalNode({
                targetNode: params.target_node ? String(params.target_node) : undefined,
                requestText: String(params.requestText || ''),
            })
        },
    },
    {
        name: 'self_setup_status',
        description: 'NUR bei einer ausdrücklichen aktuellen Setup-/Capability-/Runtime-Frage verwenden. Zeigt Novas aktuellen Self-Setup-State; niemals aus allgemeinen Wünschen wie "Nova besser/schlauer machen" ableiten.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { formatSelfSetupStatus } = await import('../core/self-setup-orchestrator.js')
            return formatSelfSetupStatus()
        },
    },
    {
        name: 'self_setup_plan',
        description: 'NUR wenn die aktuelle Nachricht ausdrücklich Setup, Installation, Hardware, Runtime oder fehlende Capabilities prüfen lässt. Nicht für allgemeine Verbesserungsziele. Scannt read-only, installiert nichts und ändert keine Config.',
        category: 'system',
        parameters: [
            { name: 'skip_network', type: 'boolean', description: 'Nur lokale/config-basierte Pruefung ohne Netzwerk-Probes', required: false },
        ],
        handler: async (params) => {
            const { runSelfSetupScan, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
            const state = await runSelfSetupScan({ skipNetwork: params.skip_network === true })
            return formatSelfSetupPlan(state)
        },
    },
    {
        name: 'self_setup_apply',
        description: 'Fuehrt eine freigegebene Self-Setup-Aktion aus. Es braucht den Einmal-Freigabecode, den der Owner selbst per "/setup apply <actionId>" (bzw. "/setup apply all") erhaelt und dir nennt; Codes niemals selbst bilden. Ohne Code (auch im YOLO-Modus) landen nur Katalog-Aktionen in der Installations-Warteschlange; installiert wird erst nach dem Ja des Owners auf der Knopf-Karte oder bei dauerhafter Erlaubnis (/setup allow). Freie Befehle werden nie ausgefuehrt.',
        category: 'system',
        parameters: [
            { name: 'action_id', type: 'string', description: 'Action-ID aus self_setup_plan oder "all"', required: true },
            { name: 'confirm', type: 'string', description: 'Einmal-Freigabecode aus der Antwort auf /setup apply (vom Owner genannt)', required: false },
        ],
        handler: async (params) => {
            // INT-6: the confirmation is the one-time, principal-bound token the
            // /setup apply slash command issued, never a model-constructible
            // string like "APPLY:<id>". Channel and principal come from the
            // server-side execution context (runner-injected), not the model.
            const { applySelfSetupAction, applySelfSetupPlan, loadSelfSetupState } = await import('../core/self-setup-orchestrator.js')
            const { consumeSetupConfirmation, setupActionTarget, setupConfirmationPrincipal, setupPlanTarget } = await import('../core/setup-confirmation.js')
            const actionId = String(params.action_id || '')
            if (!/^[A-Za-z0-9:_.-]{1,128}$/.test(actionId)) return { success: false, message: 'Ungueltige Aktions-ID.' }
            const principal = setupConfirmationPrincipal(String(params.channel || ''), String(params.userId || params.authorizationUserId || ''))
            const token = typeof params.confirm === 'string' ? params.confirm.trim() : ''
            const state = loadSelfSetupState()
            if (!state) return { success: false, message: 'Kein Setup-Plan vorhanden. Erst self_setup_plan ausfuehren.' }
            const refusal = (command: string) => ({
                success: false,
                message: `Freigabe fehlt oder ist ungueltig/abgelaufen. Der Owner muss selbst "${command}" senden und dir den Einmal-Code nennen (oder "${command} <code>" direkt senden).`,
            })
            // P9 (YOLO-Luecke): without the owner's code — YOLO or not — only catalog
            // actions proceed, and only into the install queue (Knopf-Karte); they are
            // installed without a card only with a standing permission (trust.json).
            if (actionId === 'all') {
                if (!token) return await applySelfSetupPlan('')
                if (!consumeSetupConfirmation(principal, setupPlanTarget(state.generatedAt), token)) return refusal('/setup apply all')
                return await applySelfSetupPlan(`APPLY_ALL:${state.generatedAt}`)
            }
            if (!token) {
                const action = state.actions.find(a => a.id === actionId)
                const queueOnly = Boolean(action?.catalogId) && action?.verification?.kind !== 'gpu_backend'
                return queueOnly ? await applySelfSetupAction(actionId, '') : refusal(`/setup apply ${actionId}`)
            }
            if (!consumeSetupConfirmation(principal, setupActionTarget(actionId), token)) return refusal(`/setup apply ${actionId}`)
            return await applySelfSetupAction(actionId, `APPLY:${actionId}`)
        },
    },
    {
        name: 'self_setup_research',
        description: 'Recherchiert via Websuche für ALLE aktuell fehlenden Capabilities die beste aktuelle Installationsstrategie und schreibt die Ergebnisse (mit Confidence, Quelle, Hardware-Match) zurück in setup-state.json. Research läuft ohne Gate. Install/Apply bleibt weiter freigabepflichtig.',
        category: 'system',
        parameters: [
            { name: 'force', type: 'boolean', description: 'Cache ignorieren und alles neu recherchieren (auch frischer Scan)', required: false },
        ],
        handler: async (params) => {
            const { runSelfSetupResearch, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
            const state = await runSelfSetupResearch({ force: params.force === true })
            return formatSelfSetupPlan(state)
        },
    },
    {
        name: 'research_capability_plan',
        description: 'Recherchiert via Websuche die aktuell beste Installationsstrategie für eine fehlende AI-Capability (stt/tts/llm/embedding/vision/ffmpeg) auf der passenden Hardware. Berücksichtigt Apple Silicon, CUDA, ARM, Windows. Ergebnis wird in Setup-Aktionen umgewandelt.',
        category: 'system',
        parameters: [
            { name: 'capability', type: 'string', description: 'Welche Capability: stt, tts, llm, embedding, vision, ffmpeg, whisper, ollama', required: true },
            { name: 'node', type: 'string', description: 'Spezifischer Mesh-Node-Name (optional; sonst wird bester Node automatisch gewählt)', required: false },
            { name: 'force', type: 'boolean', description: 'Cache ignorieren und neu recherchieren', required: false },
        ],
        handler: async (params) => {
            const capability = String(params.capability || '').toLowerCase().trim()
            const force = params.force === true
            const { runSelfSetupResearch, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
            const state = await runSelfSetupResearch({ force, capabilities: [capability], timeoutMs: 90_000 })
            return formatSelfSetupPlan(state)
        },
    },
    {
        name: 'research_all_capabilities',
        description: 'Recherchiert fuer alle aktuell fehlenden Capabilities die beste aktuelle Installationsstrategie via Websuche und schreibt den enrichierten Plan in setup-state.json.',
        category: 'system',
        parameters: [
            { name: 'force', type: 'boolean', description: 'Cache ignorieren und alles neu recherchieren', required: false },
        ],
        handler: async (params) => {
            const { runSelfSetupResearch, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
            const state = await runSelfSetupResearch({ force: params.force === true })
            return formatSelfSetupPlan(state)
        },
    },
    {
        name: 'auto_provision',
        description: 'Abgeschaltet: installiert nichts. Fuer fehlende Faehigkeiten self_setup_plan nutzen; installieren nur der Owner per /setup apply.',
        category: 'system',
        parameters: [
            { name: 'capability', type: 'string', description: 'Gewuenschte Capability (nur fuer den Hinweis)', required: false },
        ],
        // A confirm string the model can compose itself is no approval, and
        // YOLO must not reopen a shell path (Stufe 1, 30.09.2026).
        handler: async () => AUTO_PROVISION_DISABLED,
    },
    {
        name: 'find_capability',
        description: 'Findet den besten Provider fuer eine Capability. Installiert nicht automatisch; fuer fehlende Dinge self_setup_plan nutzen.',
        category: 'system',
        parameters: [
            { name: 'capability', type: 'string', description: 'Was gebraucht wird: vision, tts, stt, llm, embedding', required: true },
            { name: 'prefer_local', type: 'boolean', description: 'Lokale Nodes bevorzugen (statt Cloud)?', required: false },
        ],
        handler: async (params) => {
            const { findBestCapability } = await import('../mesh/capability-orchestrator.js')
            const match = findBestCapability({
                capability: params.capability as string,
                preferLocal: params.prefer_local as boolean || false,
                preferQuality: true,
            })
            if (match) return `Beste Option: ${match.reason}`
            return `Kein Provider fuer ${params.capability} gefunden. Nutze self_setup_plan fuer Installations-/Config-Vorschlaege.`
        },
    },
]

// ============================================
// System Helper Tools (Docker, Ports, Process)
// ============================================

export const systemHelperTools: NovaTool[] = [
    {
        name: 'docker_ps',
        description: 'Listet laufende Docker-Container auf',
        category: 'system',
        parameters: [
            { name: 'all', type: 'boolean', description: 'Auch gestoppte Container zeigen', required: false },
        ],
        handler: async (params) => {
            return callDockerHost('list', { all: params.all ?? false })
        },
    },
    {
        name: 'docker_logs',
        description: 'Zeigt Logs eines Docker-Containers',
        category: 'system',
        parameters: [
            { name: 'container', type: 'string', description: 'Vollständige 64-stellige Container-ID aus docker_ps', required: true },
            { name: 'lines', type: 'number', description: 'Anzahl der letzten Zeilen (1–200)', required: false },
        ],
        handler: async (params) => {
            // Exact immutable ID, never a shell interpolation or prefix match.
            return callDockerHost('logs', { containerId: params.container, lines: params.lines ?? 50 })
        },
    },
    {
        name: 'docker_status', description: 'Liest verifizierten Host-Containerstatus anhand der vollständigen ID aus docker_ps.', category: 'system',
        parameters: [{ name: 'containerId', type: 'string', required: true, description: 'Vollständige 64-stellige Container-ID' }],
        handler: async params => callDockerHost('status', { containerId: params.containerId }),
    },
    {
        name: 'docker_control', description: 'Start/Stop/Neustart eines freigegebenen Containers. Benötigt separat signierte Operator-Freigabe; keine Löschung, Shell oder freien Docker-Parameter.', category: 'system',
        parameters: [{ name: 'permit', type: 'object', required: true, description: 'Operator-signierte, kurzlebige Freigabe für exakte Node-, Client- und Container-ID sowie Aktion' },
            { name: 'signature', type: 'string', required: true, description: 'Ed25519-Freigabesignatur; niemals selbst erzeugen' }],
        handler: async params => {
            const { getUserPermission } = await import('../users/multi-user-middleware.js')
            const user = String(params.authorizationUserId || ''), channel = String(params.channel || '')
            if (!user || !['owner', 'admin'].includes(getUserPermission(user, channel))) return { success: false, blocked: true, error: 'Docker-Aktionen erfordern Owner/Admin.' }
            const permit = params.permit as any
            if (permit?.approvedBy !== `${channel}:${user}`) return { success: false, blocked: true, error: 'Host-Freigabe gehört nicht zum aktuellen Benutzerkontext.' }
            return callDockerHost('action', { permit, signature: params.signature })
        },
    },
    {
        name: 'port_scan',
        description: 'Scannt offene Ports auf localhost',
        category: 'system',
        parameters: [
            { name: 'ports', type: 'string', description: 'Komma-getrennte Ports zum Prüfen (z.B. "3000,3001,8080"). Leer = Standard-Ports', required: false },
        ],
        handler: async (params) => {
            const net = await import('node:net')
            const portsStr = params.ports as string || '80,443,3000,3001,3002,5432,6379,8080,8443,11434,27017'
            const ports = portsStr.split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p))

            const results: Array<{ port: number; open: boolean }> = []
            for (const port of ports) {
                const open = await new Promise<boolean>((resolve) => {
                    const socket = new net.Socket()
                    socket.setTimeout(1000)
                    socket.on('connect', () => { socket.destroy(); resolve(true) })
                    socket.on('timeout', () => { socket.destroy(); resolve(false) })
                    socket.on('error', () => { resolve(false) })
                    socket.connect(port, '127.0.0.1')
                })
                results.push({ port, open })
            }

            return {
                success: true,
                openPorts: results.filter(r => r.open).map(r => r.port),
                closedPorts: results.filter(r => !r.open).map(r => r.port),
                details: results,
            }
        },
    },
    {
        name: 'process_list',
        description: 'Listet laufende Prozesse (optional nach Name filtern)',
        category: 'system',
        parameters: [
            { name: 'filter', type: 'string', description: 'Prozessname-Filter', required: false },
        ],
        handler: async (params) => {
            const { execSync } = await import('node:child_process')
            const isWin = process.platform === 'win32'
            try {
                let output: string
                if (isWin) {
                    const filter = params.filter ? `| findstr /i "${params.filter}"` : ''
                    output = execSync(`tasklist /FO CSV /NH ${filter}`, { encoding: 'utf-8', timeout: 10_000 })
                } else {
                    const filter = params.filter ? `| grep -i "${params.filter}"` : ''
                    output = execSync(`ps aux ${filter}`, { encoding: 'utf-8', timeout: 10_000 })
                }
                return { success: true, output: output.trim().slice(0, 3000) }
            } catch (err: any) {
                return { success: false, error: err.message }
            }
        },
    },
    {
        name: 'process_kill',
        description: 'Beendet einen Prozess (PID oder Name)',
        category: 'system',
        parameters: [
            { name: 'target', type: 'string', description: 'PID oder Prozessname', required: true },
            { name: 'force', type: 'boolean', description: 'Force-Kill', required: false },
        ],
        handler: async (params) => {
            const { execSync } = await import('node:child_process')
            const isWin = process.platform === 'win32'
            const target = params.target as string
            const force = params.force as boolean
            try {
                if (isWin) {
                    const isPid = /^\d+$/.test(target)
                    const cmd = isPid
                        ? `taskkill ${force ? '/F' : ''} /PID ${target} /T`
                        : `taskkill ${force ? '/F' : ''} /IM "${target}" /T`
                    execSync(cmd, { encoding: 'utf-8', timeout: 10_000 })
                } else {
                    const sig = force ? '-9' : '-15'
                    execSync(`kill ${sig} ${target}`, { encoding: 'utf-8', timeout: 10_000 })
                }
                return { success: true, killed: target }
            } catch (err: any) {
                return { success: false, error: err.message }
            }
        },
    },
]

// ============================================
// DevOps Helper Tools (Disk, Network, Services, Logs)
// ============================================

export const devopsTools: NovaTool[] = [
    {
        name: 'disk_usage',
        description: 'Zeigt Festplattenauslastung',
        category: 'system',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zum Prüfen (default: /)', required: false },
        ],
        handler: async (params) => {
            // Use Node's native statfsSync (v18+) — no external process, instant,
            // works cross-platform. Replaces deprecated wmic / slow PowerShell.
            try {
                const { statfsSync } = await import('node:fs')
                const isWin = process.platform === 'win32'
                const target = (params.path as string) || (isWin ? process.cwd().slice(0, 3) : '/')
                const s = statfsSync(target)
                const totalBytes = s.blocks * s.bsize
                const freeBytes = s.bavail * s.bsize
                const usedBytes = totalBytes - freeBytes
                const gb = (n: number) => Math.round(n / 1e9 * 10) / 10
                const usedPercent = totalBytes > 0 ? Math.round(usedBytes / totalBytes * 100) : 0
                const formatted = `${target}: ${gb(freeBytes)} GB frei von ${gb(totalBytes)} GB (${usedPercent}% belegt)`
                return {
                    success: true,
                    path: target,
                    freeGB: gb(freeBytes),
                    totalGB: gb(totalBytes),
                    usedGB: gb(usedBytes),
                    usedPercent,
                    formatted,
                    output: formatted,
                }
            } catch (err: any) {
                return { success: false, error: err.message }
            }
        },
    },
    {
        name: 'network_info',
        description: 'Zeigt Netzwerk-Informationen (IP, DNS, Gateway)',
        category: 'system',
        parameters: [],
        handler: async () => {
            const os = await import('node:os')
            const interfaces = os.networkInterfaces()
            const result: Array<{ name: string; addresses: Array<{ address: string; family: string; internal: boolean }> }> = []

            for (const [name, addrs] of Object.entries(interfaces)) {
                if (!addrs) continue
                result.push({
                    name,
                    addresses: addrs.map(a => ({
                        address: a.address,
                        family: a.family,
                        internal: a.internal,
                    })),
                })
            }

            return {
                success: true,
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
                totalMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
                freeMemory: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
                cpus: os.cpus().length,
                interfaces: result.filter(i => !i.addresses.every(a => a.internal)),
            }
        },
    },
    {
        name: 'service_status',
        description: 'Prüft den Status eines systemd-Services (Linux) oder Windows-Dienstes',
        category: 'system',
        parameters: [
            { name: 'service', type: 'string', description: 'Service-Name', required: true },
        ],
        handler: async (params) => {
            const { execSync } = await import('node:child_process')
            const isWin = process.platform === 'win32'
            const service = params.service as string
            try {
                if (isWin) {
                    const output = execSync(`sc query "${service}"`, { encoding: 'utf-8', timeout: 10_000 })
                    return { success: true, service, output: output.trim() }
                } else {
                    const output = execSync(`systemctl status "${service}" 2>&1 || true`, {
                        encoding: 'utf-8', timeout: 10_000,
                    })
                    return { success: true, service, output: output.trim().slice(0, 2000) }
                }
            } catch (err: any) {
                return { success: false, error: err.message }
            }
        },
    },
    {
        name: 'tail_log',
        description: 'Zeigt die letzten N Zeilen einer Log-Datei',
        category: 'system',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Log-Datei', required: true },
            { name: 'lines', type: 'number', description: 'Anzahl Zeilen (default: 50)', required: false },
            { name: 'filter', type: 'string', description: 'Grep-Filter (optional)', required: false },
        ],
        handler: async (params) => {
            const { readFileSync, existsSync } = await import('node:fs')
            const path = params.path as string
            const lines = (params.lines as number) || 50
            const filter = params.filter as string | undefined

            if (!existsSync(path)) {
                return { success: false, error: `Datei nicht gefunden: ${path}` }
            }

            const content = readFileSync(path, 'utf-8')
            let allLines = content.split('\n')

            if (filter) {
                allLines = allLines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
            }

            const result = allLines.slice(-lines).join('\n')
            return { success: true, path, totalLines: allLines.length, showing: lines, output: result }
        },
    },
    {
        name: 'system_info',
        description: 'Zeigt umfassende System-Info: OS, CPU, RAM, Node Version, etc.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const os = await import('node:os')
            return {
                success: true,
                platform: os.platform(),
                arch: os.arch(),
                release: os.release(),
                hostname: os.hostname(),
                cpus: os.cpus().length,
                cpuModel: os.cpus()[0]?.model || 'unknown',
                totalMemoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
                freeMemoryGB: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100,
                uptimeHours: Math.round(process.uptime() / 3600 * 100) / 100,
                nodeVersion: process.version,
                pid: process.pid,
                cwd: process.cwd(),
                env: {
                    NODE_ENV: process.env.NODE_ENV || 'not set',
                    PM2_HOME: process.env.PM2_HOME || 'not set',
                },
            }
        },
    },
]

// ============================================
// Exec-Approval Tools (Command Safety Layer)
// ============================================

export const execApprovalTools: NovaTool[] = [
    {
        name: 'check_command',
        description: 'Prüft ob ein Command sicher ist: erkennt rm -rf, DROP DATABASE, Fork Bombs etc. Gibt Risk-Level zurück.',
        category: 'security',
        parameters: [
            { name: 'command', type: 'string', description: 'Das zu prüfende Command', required: true },
            { name: 'source', type: 'string', description: 'Quelle: user, tool, self-evolution, plugin', required: false },
        ],
        handler: async (params) => {
            const { evaluateCommand } = await import('../security/exec-approvals.js')
            return evaluateCommand({
                command: params.command as string,
                source: (params.source as string) || 'user',
                timestamp: Date.now(),
            })
        },
    },
    {
        name: 'add_exec_rule',
        description: 'Fügt eine Custom Exec-Approval Regel hinzu (allow/deny/confirm)',
        category: 'security',
        parameters: [
            { name: 'pattern', type: 'string', description: 'Regex-Pattern', required: true },
            { name: 'action', type: 'string', description: 'allow, deny, oder confirm', required: true },
            { name: 'risk', type: 'string', description: 'safe, low, medium, high, critical', required: true },
            { name: 'reason', type: 'string', description: 'Begründung', required: true },
        ],
        handler: async (params) => {
            const { addCustomRule } = await import('../security/exec-approvals.js')
            addCustomRule({
                pattern: params.pattern as string,
                action: params.action as 'allow' | 'deny' | 'confirm',
                risk: params.risk as any,
                reason: params.reason as string,
            })
            return { success: true, added: params.pattern }
        },
    },
    {
        name: 'exec_rules',
        description: 'Listet alle Exec-Approval Regeln (builtin + custom)',
        category: 'security',
        parameters: [],
        handler: async () => {
            const { listRules } = await import('../security/exec-approvals.js')
            return listRules()
        },
    },
    {
        name: 'exec_history',
        description: 'Zeigt Exec-Approval Verlauf und Statistiken',
        category: 'security',
        parameters: [
            { name: 'limit', type: 'number', description: 'Anzahl Einträge (default: 20)', required: false },
        ],
        handler: async (params) => {
            const { getApprovalHistory, getApprovalStats } = await import('../security/exec-approvals.js')
            return {
                stats: getApprovalStats(),
                history: getApprovalHistory((params.limit as number) || 20),
            }
        },
    },
]

// ============================================
// Auto-Update Tools
// ============================================

export const autoUpdateTools: NovaTool[] = [
    {
        name: 'check_updates',
        description: 'Prüft neue Xaventra GitHub-Releases und die eingeschriebene Publisher-Signatur; keine Installation.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { checkForUpdates } = await import('../infra/auto-update.js')
            return checkForUpdates()
        },
    },
    {
        name: 'pull_update',
        description: 'Kompatibilitätsname: In-place-Git-Updates sind gesperrt. Verwende check_updates und /update prepare mit exakter Release-ID.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { pullAndRebuild } = await import('../infra/auto-update.js')
            return await pullAndRebuild()
        },
    },
    {
        name: 'version_info',
        description: 'Zeigt Nova Version: Commit, Branch, Datum, letzter Commit-Message',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { getVersionInfo } = await import('../infra/auto-update.js')
            return getVersionInfo()
        },
    },
    {
        name: 'update_history',
        description: 'Zeigt Update-Verlauf (checks & updates)',
        category: 'system',
        parameters: [
            { name: 'limit', type: 'number', description: 'Anzahl Einträge', required: false },
        ],
        handler: async (params) => {
            const { getUpdateHistory } = await import('../infra/auto-update.js')
            return getUpdateHistory((params.limit as number) || 10)
        },
    },
]

// ============================================
// TTS Tools (Text-to-Speech)
// ============================================

export const ttsTools: NovaTool[] = [
    {
        name: 'speak',
        description: 'Konvertiert Text zu Sprache. Provider: openai (gpt-4o-mini-tts), edge (kostenlos), elevenlabs (premium)',
        category: 'media',
        parameters: [
            { name: 'text', type: 'string', description: 'Text zum Vorlesen', required: true },
            { name: 'provider', type: 'string', description: 'openai, edge, oder elevenlabs (auto-detect wenn leer)', required: false },
            { name: 'voice', type: 'string', description: 'Stimme (z.B. nova, alloy, de-DE-KatjaNeural)', required: false },
            { name: 'output_path', type: 'string', description: 'Dateipfad für Audio (default: temp)', required: false },
        ],
        handler: async (params) => {
            const { speak } = await import('../tts/text-to-speech.js')
            return await speak({
                text: params.text as string,
                provider: params.provider as any,
                voice: params.voice as string,
                outputPath: params.output_path as string,
            })
        },
    },
    {
        name: 'list_voices',
        description: 'Listet verfügbare TTS-Stimmen für einen Provider',
        category: 'media',
        parameters: [
            { name: 'provider', type: 'string', description: 'openai, edge, oder elevenlabs', required: false },
        ],
        handler: async (params) => {
            const { listVoices } = await import('../tts/text-to-speech.js')
            return listVoices(params.provider as any)
        },
    },
    {
        name: 'tts_cleanup',
        description: 'Räumt alte TTS-Temp-Dateien auf',
        category: 'media',
        parameters: [],
        handler: async () => {
            const { cleanupTempFiles } = await import('../tts/text-to-speech.js')
            return { cleaned: cleanupTempFiles() }
        },
    },
    {
        name: 'voice_setup',
        description: 'Prueft Novas Voice-Abhaengigkeiten. Installiert nur mit install_missing=true oder YOLO-Modus.',
        category: 'system',
        parameters: [
            { name: 'install_missing', type: 'boolean', description: 'Fehlende Pakete wirklich installieren (sonst check-only)', required: false },
        ],
        handler: async (params) => {
            const { ensureVoiceDeps } = await import('../voice/voice-setup.js')
            let cfg: any = {}
            try {
                const { readFileSync } = await import('node:fs')
                const { join } = await import('node:path')
                cfg = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))
            } catch { cfg = {} }
            const yolo = process.env.NOVA_SELF_SETUP_YOLO === '1' || process.env.NOVA_YOLO === '1' || cfg.selfSetup?.mode === 'yolo' || cfg.selfSetup?.yolo === true
            return await ensureVoiceDeps({ installMissing: params.install_missing === true || yolo })
        },
    },
]

// ============================================
// Mesh Brain Tools
// ============================================

export const meshBrainTools: NovaTool[] = [
    {
        name: 'mesh_strengths',
        description: 'Beantwortet „Was kann welcher Knoten/Node/Rechner?“ in einer kurzen Liste: Stärken je Knoten (GPU, Speicher, geladene Modelle, Platte, online/offline). Nur lesend, aus den signierten Knotenprofilen.',
        category: 'mesh',
        parameters: [],
        handler: async () => {
            const { collectNodeStrengths, formatStrengthList } = await import('../mesh/node-strengths.js')
            return formatStrengthList(await collectNodeStrengths())
        },
    },
    {
        name: 'mesh_scan',
        description: 'Zeigt was im Mesh verfügbar ist: Stärken je Knoten plus Modell-Tipps aus dem Katalog. Nur lesend, kein SSH, keine Installation.',
        category: 'mesh',
        parameters: [
            { name: 'force', type: 'boolean', description: 'Neu zusammenstellen, auch wenn der letzte Stand noch frisch ist', required: false },
        ],
        handler: async (params) => {
            const { getMeshBrain } = await import('../mesh/mesh-brain.js')
            const brain = getMeshBrain()
            if (!params.force) {
                const cached = brain.load()
                if (cached) return cached.summary
            }
            const snap = await brain.scan()
            return snap.summary
        },
    },
    {
        name: 'mesh_recommendations',
        description: 'Zeigt Modell-Tipps je Mesh-Knoten (aus dem einen Modellkatalog) — nur Vorschläge, nichts wird installiert.',
        category: 'mesh',
        parameters: [],
        handler: async () => {
            const { getMeshBrain } = await import('../mesh/mesh-brain.js')
            const brain = getMeshBrain()
            if (!brain.load()) await brain.scan()
            const recs = brain.getAllRecommendations()
            if (recs.length === 0) return 'Keine Modell-Tipps — passt so.'
            return recs.map(({ node, rec }) =>
                `[${rec.priority.toUpperCase()}] ${node}: ${rec.tool} — ${rec.reason}${rec.installCmd ? `\n  → ${rec.installCmd}` : ''}`
            ).join('\n\n')
        },
    },
    {
        name: 'mesh_route',
        description: 'Welcher Knoten macht eine Aufgabe am besten, mit kurzem Grund. task = Aufgabe in eigenen Worten ODER Fähigkeit: grosse-modelle, llm, code, embedding, bilder, vision, stt, tts, medien, speicher, rechnen.',
        category: 'mesh',
        parameters: [
            { name: 'task', type: 'string', description: 'Aufgabe in Worten oder Fähigkeit (z. B. "bilder", "Video umwandeln")', required: true },
        ],
        handler: async (params) => {
            const { taskToSkill } = await import('../mesh/mesh-brain.js')
            const { rankNodesLive, shortReason, skillForTask } = await import('../mesh/node-strengths.js')
            const task = String(params.task || '')
            const skill = taskToSkill(task) || skillForTask(task)
            if (!skill) return 'Dafür braucht es keinen besonderen Knoten — läuft hier.'
            const ranking = await rankNodesLive(skill)
            const lines = [`${ranking.label} → ${shortReason(ranking)}`]
            if (ranking.ranked[1]) lines.push(`Danach: ${ranking.ranked[1].nodeId}`)
            return lines.join('\n')
        },
    },
]

// ============================================
// Security Audit Tools
// ============================================

export const securityAuditTools: NovaTool[] = [
    {
        name: 'security_audit',
        description: 'Führt vollständigen Security-Audit durch: Secrets, gefährlicher Code, Config, Permissions. Score 0-100.',
        category: 'security',
        parameters: [
            { name: 'path', type: 'string', description: 'Verzeichnis zum Scannen (default: cwd)', required: false },
        ],
        handler: async (params) => {
            const { runAudit } = await import('../security/security-audit.js')
            return runAudit(params.path as string)
        },
    },
    {
        name: 'quick_scan',
        description: 'Schneller Security-Check: nur kritische Findings',
        category: 'security',
        parameters: [
            { name: 'path', type: 'string', description: 'Verzeichnis', required: false },
        ],
        handler: async (params) => {
            const { quickScan } = await import('../security/security-audit.js')
            return quickScan(params.path as string)
        },
    },
]

// ============================================
// Event Hooks Tools
// ============================================

export const hooksTools: NovaTool[] = [
    {
        name: 'create_hook',
        description: 'Erstellt einen Event-Hook (webhook oder email; script-Hooks werden abgelehnt) der bei Events ausgelöst wird',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Hooks', required: true },
            { name: 'event', type: 'string', description: 'Event: message.received, tool.executed, evolution.completed, error.critical, startup, shutdown', required: true },
            { name: 'type', type: 'string', description: 'webhook oder email', required: true },
            { name: 'target', type: 'string', description: 'URL oder E-Mail-Adresse', required: true },
        ],
        handler: async (params) => {
            const { createHook } = await import('../hooks/event-hooks.js')
            return createHook({
                name: params.name as string,
                event: params.event as any,
                type: params.type as any,
                target: params.target as string,
            })
        },
    },
    {
        name: 'list_hooks',
        description: 'Listet alle Event-Hooks',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { listHooks } = await import('../hooks/event-hooks.js')
            return listHooks()
        },
    },
    {
        name: 'delete_hook',
        description: 'Löscht einen Event-Hook',
        category: 'system',
        parameters: [
            { name: 'hook_id', type: 'string', description: 'Hook-ID', required: true },
        ],
        handler: async (params) => {
            const { deleteHook } = await import('../hooks/event-hooks.js')
            return { success: deleteHook(params.hook_id as string) }
        },
    },
    {
        name: 'hook_history',
        description: 'Zeigt Hook-Ausführungs-Verlauf',
        category: 'system',
        parameters: [
            { name: 'limit', type: 'number', description: 'Anzahl Einträge', required: false },
        ],
        handler: async (params) => {
            const { getHookHistory } = await import('../hooks/event-hooks.js')
            return getHookHistory((params.limit as number) || 20)
        },
    },
]

// ============================================
// Media Understanding Tools
// ============================================

export const mediaTools: NovaTool[] = [
    {
        name: 'detect_media',
        description: 'Erkennt Medientyp und MIME einer Datei',
        category: 'media',
        parameters: [
            { name: 'path', type: 'string', description: 'Dateipfad', required: true },
        ],
        handler: async (params) => {
            const { detectMediaType } = await import('../media/media-understanding.js')
            return detectMediaType(params.path as string)
        },
    },
    {
        name: 'fetch_url',
        description: 'Holt und extrahiert Text-Inhalt von einer URL (HTML?Text, JSON, Links, Bilder)',
        category: 'media',
        parameters: [
            { name: 'url', type: 'string', description: 'URL zum Abrufen', required: true },
        ],
        handler: async (params) => {
            const { fetchUrlContent } = await import('../media/media-understanding.js')
            return await fetchUrlContent(params.url as string)
        },
    },
    {
        name: 'file_to_base64',
        description: 'Liest eine Datei und gibt Base64-Inhalt + MIME zurück',
        category: 'media',
        parameters: [
            { name: 'path', type: 'string', description: 'Dateipfad', required: true },
        ],
        handler: async (params) => {
            const { fileToBase64 } = await import('../media/media-understanding.js')
            return fileToBase64(params.path as string)
        },
    },
]

// ============================================
// Learning Tools
// ============================================

export const learningTools: NovaTool[] = [
    {
        name: 'learn_correction',
        description: 'Lernt aus einer Korrektur des Users',
        category: 'learning',
        parameters: [
            { name: 'original', type: 'string', description: 'Ursprüngliche Antwort', required: true },
            { name: 'corrected', type: 'string', description: 'Korrigierte Antwort', required: true },
            { name: 'context', type: 'string', description: 'Kontext der Anfrage', required: false },
        ],
        handler: async (params) => {
            // One store for corrections: governed memory in the caller's scope.
            const { recordUserCorrectionMemory } = await import('../memory/correction-memory.js')
            const { principalScope } = await import('../users/principal-id.js')
            const record = await recordUserCorrectionMemory({
                scope: principalScope(String(params.userId || 'system')),
                message: `Korrektur: ${String(params.corrected || '')}`,
                priorAssistantResponse: String(params.original || '').slice(0, 300),
            })
            return record ? { success: true, correctionId: record.id, status: record.status } : { success: false, error: 'Korrektur nicht gespeichert (leer oder enthält ein Geheimnis)' }
        },
    },
]

// ============================================
// Media Provider Tools (Wave 1)
// ============================================

export const mediaProviderTools: NovaTool[] = [
    {
        name: 'analyze_image',
        description: 'Analysiert ein Bild mit KI Vision (Nova-LLM/OpenAI/Anthropic). Auto-wählt verfügbaren Provider — funktioniert ohne API Keys über Nova-LLM.',
        category: 'media',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Bilddatei', required: true },
            { name: 'prompt', type: 'string', description: 'Spezifische Frage zum Bild', required: false },
            { name: 'provider', type: 'string', description: 'Provider: nova-llm, openai, anthropic', required: false },
        ],
        handler: async (params) => {
            const { processMedia } = await import('../media/media-providers.js')
            return await processMedia(params.path as string, 'image', { prompt: params.prompt as string, provider: params.provider as string })
        },
    },
    {
        name: 'transcribe_audio',
        description: 'Transkribiert eine Audio-Datei (Whisper/Nova-LLM/Deepgram). Auto-wählt verfügbaren Provider.',
        category: 'media',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Audiodatei', required: true },
            { name: 'provider', type: 'string', description: 'Provider: local-whisper, nova-llm, openai, deepgram', required: false },
        ],
        handler: async (params) => {
            const { processMedia } = await import('../media/media-providers.js')
            return await processMedia(params.path as string, 'audio', { provider: params.provider as string })
        },
    },
    {
        name: 'analyze_video',
        description: 'Analysiert ein Video mit KI (Nova-LLM/OpenAI). Beschreibt Inhalt, Szenen, Text.',
        category: 'media',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Videodatei', required: true },
            { name: 'prompt', type: 'string', description: 'Spezifische Frage zum Video', required: false },
        ],
        handler: async (params) => {
            const { processMedia } = await import('../media/media-providers.js')
            return await processMedia(params.path as string, 'video', { prompt: params.prompt as string })
        },
    },
    {
        name: 'generate_image',
        description: 'Generiert ein Bild mit KI (DALL-E 3 / OpenAI Image). Gibt den Dateipfad des generierten Bildes zurück. Unterstützt verschiedene Seitenverhältnisse.',
        category: 'media',
        parameters: [
            { name: 'prompt', type: 'string', description: 'Beschreibung des zu generierenden Bildes (Englisch empfohlen)', required: true },
            { name: 'aspect_ratio', type: 'string', description: 'Seitenverhältnis: 1:1, 16:9, 9:16, 4:3, 3:4', required: false },
        ],
        handler: async (params) => {
            const { executeImageGen } = await import('./image-gen-tool.js')
            return await executeImageGen(params)
        },
    },
    {
        name: 'send_file',
        description: 'Sendet eine Datei an den User via Telegram. Erkennt automatisch ob Foto (jpg/png/gif/webp) oder Dokument (pdf/zip/etc). Nutze dies um generierte Bilder, Reports, oder andere Dateien zu senden.',
        category: 'media',
        parameters: [
            { name: 'path', type: 'string', description: 'Absoluter Pfad zur Datei', required: true },
            { name: 'caption', type: 'string', description: 'Optionale Bildunterschrift/Beschreibung', required: false },
            { name: 'as_document', type: 'boolean', description: 'Erzwinge Versand als Dokument (auch für Bilder)', required: false },
        ],
        handler: async (params) => {
            const { executeSendFile } = await import('./send-file-tool.js')
            return await executeSendFile(params)
        },
    },
    {
        name: 'list_media_providers',
        description: 'Zeigt alle verfügbaren Media-Provider und ihre Capabilities.',
        category: 'media',
        parameters: [],
        handler: async () => {
            const { listProviders, getAvailableProviders } = await import('../media/media-providers.js')
            return { all: listProviders().map(p => ({ id: p.id, name: p.name, capabilities: p.capabilities })), available: getAvailableProviders().map(p => p.id) }
        },
    },
]

// ============================================
// Markdown Tools (Wave 2)
// ============================================

export const markdownTools: NovaTool[] = [
    {
        name: 'parse_markdown',
        description: 'Parsed Markdown zu IR (Intermediate Representation). Extrahiert Frontmatter, Headings, Code-Blöcke.',
        category: 'other',
        parameters: [
            { name: 'content', type: 'string', description: 'Markdown-Inhalt', required: true },
        ],
        handler: async (params) => {
            const { parseToIR, extractHeadings, extractCodeFences, wordCount } = await import('../utils/markdown-processor.js')
            const md = params.content as string
            return { ir: parseToIR(md), headings: extractHeadings(md), codeFences: extractCodeFences(md), wordCount: wordCount(md) }
        },
    },
    {
        name: 'markdown_to_whatsapp',
        description: 'Konvertiert Markdown zu WhatsApp-kompatiblem Format.',
        category: 'other',
        parameters: [
            { name: 'content', type: 'string', description: 'Markdown-Inhalt', required: true },
        ],
        handler: async (params) => {
            const { toWhatsAppMarkdown } = await import('../utils/markdown-processor.js')
            return { result: toWhatsAppMarkdown(params.content as string) }
        },
    },
]

// ============================================
// Session & Routing Tools (Wave 2)
// ============================================

export const sessionTools: NovaTool[] = [
    {
        name: 'list_sessions',
        description: 'Zeigt alle aktiven Sessions mit Channel, User, Message-Count.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { listSessions } = await import('../routing/session-routing.js')
            return { sessions: listSessions() }
        },
    },
    {
        name: 'set_model_override',
        description: 'Setzt ein Model-Override für eine Session.',
        category: 'system',
        parameters: [
            { name: 'session_id', type: 'string', description: 'Session-ID', required: true },
            { name: 'model', type: 'string', description: 'Model-Name', required: true },
        ],
        handler: async (params) => {
            const { setModelOverride } = await import('../routing/session-routing.js')
            return { success: setModelOverride(params.session_id as string, params.model as string) }
        },
    },
    {
        name: 'add_route',
        description: 'Fügt eine neue Route hinzu (Channel + Pattern ? Agent/Model).',
        category: 'system',
        parameters: [
            { name: 'channel', type: 'string', description: 'Channel (telegram, whatsapp, discord, *)', required: true },
            { name: 'pattern', type: 'string', description: 'Regex-Muster für Nachrichten', required: false },
            { name: 'agent', type: 'string', description: 'Ziel-Agent', required: false },
            { name: 'model', type: 'string', description: 'Ziel-Model', required: false },
        ],
        handler: async (params) => {
            const { addRoute } = await import('../routing/session-routing.js')
            addRoute({ channel: params.channel as string, pattern: params.pattern as string, agent: params.agent as string, model: params.model as string })
            return { success: true }
        },
    },
]

// ============================================
// Plugin Tools (Wave 3)
// ============================================

export const pluginTools: NovaTool[] = [
    {
        name: 'list_plugins',
        description: 'Zeigt alle geladenen Plugins.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { listPlugins } = await import('../plugins/plugin-loader.js')
            return { plugins: listPlugins().map(p => ({
                name: p.name,
                version: p.version,
                enabled: p.active,
                trust: p.trust,
                permissions: p.permissions || [],
            })) }
        },
    },
    {
        name: 'load_plugin',
        description: 'Lädt ein Plugin aus einem Verzeichnis.',
        category: 'system',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zum Plugin-Verzeichnis', required: true },
        ],
        handler: async (params) => {
            const { loadPlugin } = await import('../plugins/plugin-loader.js')
            return await loadPlugin(params.path as string)
        },
    },
    {
        name: 'discover_plugins',
        description: 'Sucht nach Plugins in den angegebenen Verzeichnissen.',
        category: 'system',
        parameters: [
            { name: 'dirs', type: 'string', description: 'Komma-getrennte Verzeichnisse', required: true },
        ],
        handler: async (params) => {
            const { discoverPlugins } = await import('../plugins/plugin-loader.js')
            return { found: discoverPlugins((params.dirs as string).split(',').map(d => d.trim())) }
        },
    },
]



// ============================================
// Poll Tools (Wave 3)
// ============================================

export const pollTools: NovaTool[] = [
    {
        name: 'create_poll',
        description: 'Erstellt eine Umfrage mit Frage und Optionen.',
        category: 'other',
        parameters: [
            { name: 'question', type: 'string', description: 'Frage', required: true },
            { name: 'options', type: 'string', description: 'Komma-getrennte Optionen', required: true },
        ],
        handler: async (params) => {
            const { createPoll, formatPollMessage } = await import('../utils/polls.js')
            const poll = createPoll({ question: params.question as string, options: (params.options as string).split(',').map(o => o.trim()) })
            return { poll, message: formatPollMessage(poll) }
        },
    },
    {
        name: 'vote_poll',
        description: 'Stimmt in einer Umfrage ab.',
        category: 'other',
        parameters: [
            { name: 'poll_id', type: 'string', description: 'Poll-ID', required: true },
            { name: 'option', type: 'string', description: 'Option-ID oder Index', required: true },
            { name: 'voter', type: 'string', description: 'Voter-ID', required: false },
        ],
        handler: async (params) => {
            const { vote } = await import('../utils/polls.js')
            return vote(params.poll_id as string, params.option as string, (params.voter as string) || 'anonymous')
        },
    },
    {
        name: 'poll_results',
        description: 'Zeigt Umfrage-Ergebnisse.',
        category: 'other',
        parameters: [
            { name: 'poll_id', type: 'string', description: 'Poll-ID', required: true },
        ],
        handler: async (params) => {
            const { getPoll, formatPollResults } = await import('../utils/polls.js')
            const poll = getPoll(params.poll_id as string)
            if (!poll) return { error: 'Poll not found' }
            return { poll, formatted: formatPollResults(poll) }
        },
    },
]

// ============================================
// Browser Automation Tools (Wave 4)
// ============================================

export const browserAutomationTools: NovaTool[] = [
    {
        name: 'browser_screenshot',
        description: 'Macht einen Screenshot einer Webseite via Playwright/Puppeteer.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'URL der Webseite', required: true },
            { name: 'full_page', type: 'boolean', description: 'Ganze Seite (default: false)', required: false },
        ],
        handler: async (params) => {
            const { captureScreenshot } = await import('./browser-automation.js')
            const path = captureScreenshot(params.url as string, { fullPage: params.full_page as boolean })
            return { path, success: true }
        },
    },
    {
        name: 'browser_extract',
        description: 'Extrahiert Text, Links und Bilder einer Webseite.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'URL der Webseite', required: true },
        ],
        handler: async (params) => {
            const { fetchPageContent, htmlToText } = await import('./browser-automation.js')
            const { text, status } = await fetchPageContent(params.url as string)
            return { text: htmlToText(text), status }
        },
    },
]

// ============================================
// Agent Pattern Tools (Wave 5)
// ============================================

export const agentPatternTools: NovaTool[] = [
    {
        name: 'set_tool_policy',
        description: 'Setzt eine Tool-Policy (allow/deny/confirm) für ein Tool-Pattern.',
        category: 'security',
        parameters: [
            { name: 'pattern', type: 'string', description: 'Tool-Name oder Pattern (* für alle)', required: true },
            { name: 'action', type: 'string', description: 'allow, deny, oder confirm', required: true },
            { name: 'reason', type: 'string', description: 'Begründung', required: false },
        ],
        handler: async (params) => {
            const { addToolPolicy } = await import('../agents/agent-patterns.js')
            addToolPolicy({ pattern: params.pattern as string, action: params.action as 'allow' | 'deny' | 'confirm', reason: params.reason as string })
            // UEB-9: the rule lives in memory only; say so instead of implying permanence
            return { success: true, persistent: false, message: 'Regel gesetzt. Sie gilt nur bis zum nächsten Neustart (nur im Speicher, nicht in der Konfiguration gespeichert).' }
        },
    },
    {
        name: 'list_tool_policies',
        description: 'Zeigt alle aktiven Tool-Policies.',
        category: 'security',
        parameters: [],
        handler: async () => {
            const { listToolPolicies } = await import('../agents/agent-patterns.js')
            return { policies: listToolPolicies() }
        },
    },
    {
        name: 'list_fallback_chains',
        description: 'Zeigt alle Model-Fallback-Chains.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { createModelFallback } = await import('../llm/fallback.js')
            const fb = createModelFallback()
            return { providers: fb.getStatus(), available: fb.getAvailableProviders() }
        },
    },
    {
        name: 'compact_context',
        description: 'Komprimiert den Kontext (entfernt alte Nachrichten, erstellt Summary).',
        category: 'system',
        parameters: [
            { name: 'max_messages', type: 'number', description: 'Max Nachrichten behalten', required: false },
            { name: 'keep_last', type: 'number', description: 'Letzte N behalten', required: false },
        ],
        handler: async (params) => {
            const { compactMessages, estimateContextTokens } = await import('../agents/agent-patterns.js')
            // Placeholder: actual messages would come from the session
            return { info: 'Context compaction available', config: { maxMessages: params.max_messages || 50, keepLast: params.keep_last || 10 } }
        },
    },
    {
        name: 'list_sub_agents',
        description: 'Zeigt alle registrierten Sub-Agents.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { getSubAgentManager } = await import('../layers/L8-sub-agent.js')
            const manager = getSubAgentManager()
            return { tasks: manager.getActiveTasks() }
        },
    },
    {
        name: 'load_skills',
        description: 'Lädt Skills aus einem Verzeichnis.',
        category: 'system',
        parameters: [
            { name: 'dir', type: 'string', description: 'Skills-Verzeichnis', required: true },
        ],
        handler: async (params) => {
            const { loadSkillsFromDir } = await import('../agents/agent-patterns.js')
            const skills = loadSkillsFromDir(params.dir as string)
            return { skills: skills.map(s => ({ name: s.name, description: s.description, tags: s.tags })), count: skills.length }
        },
    },
]

// ============================================
// All Tools Combined
// ============================================

// Import additional tools
import { apiKeyTool } from './api-key-tool.js'
import { saveConfigTool } from './config-tool.js'
import { braveSearchTool } from './brave-search.js'
import { tavilySearchTool } from './tavily-search.js'
import { searxngSearchTool } from './searxng-search.js'
import { reminderTool, listRemindersTool } from './reminder-tool.js'
import { selfManagementTools } from './self-management.js'
import { buildSkillTool, createSkillTool, listSkillsTool, deleteSkillTool } from './skill-builder.js'
import { isSuccessfulToolResult } from './tool-result-quality.js'
import { selfIntrospect } from './self-introspect.js'
import { loadTraceInsights, runTraceAnalysis } from '../learning/trace-analyzer.js'
import { codeSearchTool, findByNameTool } from './code-search.js'
import { codeOutlineTool, viewCodeItemTool } from './code-outline.js'
import { knowledgeStoreTool, knowledgeRecallTool, knowledgeListTool, knowledgeDeleteTool, knowledgeGetTool } from './knowledge-system.js'

// ============================================
// Self-Modification Tools (L20)
// ============================================

const selfModificationTools: NovaTool[] = [
    {
        name: 'execute_python',
        description: 'Führt Python-Code direkt aus. Nutze dies IMMER wenn du Python-Skripte schreibst — statt sie nur in den Chat zu schreiben. Unterstützt inline Code, .py Dateien, und optionale pip-Installationen.',
        category: 'system',
        parameters: [
            { name: 'code', type: 'string', description: 'Python-Code als String (inline)', required: false },
            { name: 'file', type: 'string', description: 'Pfad zu einer .py Datei', required: false },
            { name: 'install', type: 'string', description: 'Komma-getrennte pip-Pakete die vorher installiert werden sollen (z.B. "python-docx,requests")', required: false },
            { name: 'confirm', type: 'string', description: 'Einmal-Freigabecode, den der Owner selbst nennt (Pflicht, außer die Pipeline hat die Freigabe bereits erteilt). Niemals selbst bilden.', required: false },
        ],
        handler: async (params) => {
            const { executeExecutePython } = await import('./execute-python-tool.js')
            return await executeExecutePython(params)
        },
    },
    {
        name: 'evolve_self',
        description: 'Modifiziert Novas eigenen TypeScript-Quellcode sicher: erstellt Git-Branch ? ändert Code ? kompiliert ? merged bei Erfolg, rollt zurück bei Fehler. Nur für src/tools/ und src/layers/ erlaubt.',
        category: 'system',
        parameters: [
            { name: 'file', type: 'string', description: 'Relativer Pfad zur TS-Datei (z.B. src/tools/reminder-tool.ts)', required: true },
            { name: 'description', type: 'string', description: 'Kurzbeschreibung der Änderung', required: true },
            { name: 'search', type: 'string', description: 'Exakter Text der ersetzt werden soll', required: true },
            { name: 'replace', type: 'string', description: 'Neuer Text (Ersatz)', required: true },
            { name: 'reason', type: 'string', description: 'Warum diese Änderung?', required: false },
        ],
        handler: async (params) => {
            const { default: evolution } = await import('../synthesis/self-evolution.js')
            const result = await evolution.evolve({
                file: String(params.file || ''),
                description: String(params.description || ''),
                search: String(params.search || ''),
                replace: String(params.replace || ''),
                reason: String(params.reason || ''),
            })
            if (result.success) {
                return `? Evolution erfolgreich! Branch: ${result.branch}\nBuild: ${result.buildOutput?.slice(0, 300) || 'OK'}\nNova startet neu...`
            } else {
                return `? Evolution fehlgeschlagen: ${result.error}\nRollback: ${result.rollbackPerformed ? 'Ja ?' : 'Nein ??'}`
            }
        },
    },
    {
        name: 'nova_trace_stats',
        description: 'Zeigt Novas eigene Performance-Statistiken aus den letzten 7 Tagen: welche Tools am langsamsten/fehleranfälligsten sind, welches Modell am besten performt, Latenz-Durchschnitte, Self-Healing Retries. Nutze dies zur Selbstoptimierung oder wenn du wissen willst wie du performst.',
        category: 'system',
        parameters: [
            { name: 'refresh', type: 'boolean', description: 'true = Analyse neu berechnen (dauert ~1s), false = gecachte Insights laden (Standard)', required: false },
        ],
        handler: async (params) => {
            const insights = params.refresh ? runTraceAnalysis() : (loadTraceInsights() ?? runTraceAnalysis())
            if (insights.tracesAnalyzed === 0) return '📊 Noch keine Trace-Daten vorhanden. Nach ein paar Unterhaltungen verfügbar.'

            const lines = [
                `📊 **Nova Trace-Analyse** (${insights.tracesAnalyzed} Requests, letzte ${insights.periodDays} Tage)`,
                '',
                `**Gesamt-Latenz:** ∅ ${(insights.overall.avgTotalLatencyMs / 1000).toFixed(1)}s | LLM: ${(insights.overall.avgLlmLatencyMs / 1000).toFixed(1)}s | Tools: ${(insights.overall.avgToolLatencyMs / 1000).toFixed(1)}s`,
                `**Erfolgsrate:** ${(insights.overall.successRate * 100).toFixed(0)}% | Self-Healing Retries: ∅ ${insights.overall.avgSelfHealingRetries.toFixed(2)}/Request`,
                `**Tool-Calls/Request:** ∅ ${insights.overall.avgToolCallsPerRequest}`,
            ]

            if (insights.models.length > 0) {
                lines.push('\n**Modelle:**')
                for (const m of insights.models.slice(0, 3)) {
                    lines.push(`  • ${m.modelId} (${m.provider}): ${m.callCount} Calls, ${(m.successRate * 100).toFixed(0)}% Erfolg, ∅ ${(m.avgLlmLatencyMs / 1000).toFixed(1)}s`)
                }
            }

            if (insights.tools.length > 0) {
                lines.push('\n**Top Tools:**')
                for (const t of insights.tools.slice(0, 5)) {
                    const errPct = (t.errorRate * 100).toFixed(0)
                    lines.push(`  • ${t.name}: ${t.callCount}x, ∅ ${t.avgLatencyMs}ms, ${errPct}% Fehler`)
                }
            }

            if (insights.slowestTools.length > 0) lines.push(`\n⏱ **Langsamste Tools:** ${insights.slowestTools.join(', ')}`)
            if (insights.mostFailingTools.length > 0) lines.push(`❌ **Fehleranfälligste Tools:** ${insights.mostFailingTools.join(', ')}`)
            if (insights.cacheCandidates.length > 0) lines.push(`💾 **Cache-Kandidaten:** ${insights.cacheCandidates.join(', ')}`)

            if (insights.recommendations.length > 0) {
                lines.push('\n**Empfehlungen:**')
                for (const r of insights.recommendations) lines.push(`  → ${r}`)
            }

            return lines.join('\n')
        },
    },
    {
        name: 'nova_introspect',
        description: 'Zeigt Novas eigenen internen Zustand: Ziele, gelernte Regeln, Skills, Performance-Metriken, Erinnerungen und System-Prompt. Nutze dies wenn du verstehen willst wer du bist, was du weißt, wie du performst oder was deine aktuellen Ziele sind.',
        category: 'system',
        parameters: [
            {
                name: 'type',
                type: 'string',
                description: 'Was soll inspiziert werden? state=Laufzustand, goals=Ziele, skills=Gelerntes (Prozeduren, Routine-Skills, Werkzeuge, Lern-Puls, Entscheidungen; für "Was hast du gelernt?"), performance=Metriken, memories=Erinnerungen, prompt=SystemPrompt, tools=Tool-Inventar, full=Alles (Standard)',
                required: false,
            },
            {
                name: 'search',
                type: 'string',
                description: 'Suchbegriff — nur relevant wenn type=tools (z.B. "search", "browser", "memory")',
                required: false,
            },
        ],
        handler: async (params) => {
            return await selfIntrospect(
                (params.type || 'full') as import('./self-introspect.js').IntrospectType,
                params.search as string | undefined,
                { userId: typeof params.userId === 'string' ? params.userId : undefined },
            )
        },
    },
    {
        name: 'nova_capabilities',
        description: 'Nova fragt ihr eigenes Tool-Inventar ab. Zeigt alle Tools die für ein bestimmtes Thema verfügbar sind — mit Name, Beschreibung und Kategorie. Nutze das wenn du nicht sicher bist welches Tool du für eine Aufgabe verwenden sollst.',
        category: 'system',
        parameters: [
            {
                name: 'topic',
                type: 'string',
                description: 'Suchbegriff für das Tool-Inventar (z.B. "search", "browser", "file", "ssh", "memory", "agent"). Leer = alle Tools gruppiert nach Kategorie.',
                required: false,
            },
        ],
        handler: async (params) => {
            return await selfIntrospect('tools', params.topic as string | undefined)
        },
    },
]

// ============================================
// Auftrags-Tools (P9: „Auftrag“ = Owner-Ziel als Schrittkette; Tool-Namen bleiben)
// ============================================

export const missionTools: NovaTool[] = [
    {
        name: 'start_mission',
        description: 'Startet einen Auftrag: ein Ziel, das selbstständig in mehreren Schritten abgearbeitet wird. Nutze das für komplexe Aufgaben mit mehreren Schritten; schreibe nicht nur „Auftrag gestartet“, sondern rufe dieses Tool auf.',
        category: 'system',
        parameters: [
            { name: 'goal', type: 'string', description: 'Das Ziel des Auftrags: was genau soll erreicht werden?', required: true },
        ],
        async handler(params) {
            const { startMission } = await import('../core/autonomous-executor.js')
            const goal = String(params.goal)
            if (!goal || goal.length < 5) return '❌ Bitte ein konkretes Ziel angeben (mindestens 5 Zeichen).'
            const mission = await startMission(goal, 'nova-self', 'internal')
            return `🚀 Auftrag registriert! ${mission.steps.length} Schritte geplant.\n\nZiel: ${goal.slice(0, 150)}\nSteps: ${mission.steps.map((s: any) => s.description).join(', ')}`
        },
    },
    {
        name: 'mission_status',
        description: 'Zeigt den Status des laufenden Auftrags. Nutze das, bevor du sagst, ob ein Auftrag läuft.',
        category: 'system',
        parameters: [],
        async handler() {
            const { getMissionStatus, getActiveMission } = await import('../core/autonomous-executor.js')
            const active = getActiveMission()
            if (!active) return getMissionStatus()
            return getMissionStatus()
        },
    },
    {
        name: 'mission_config',
        description: 'Zeigt oder ändert die Auftrags-Konfiguration (Folge-Aufträge, Timeout, Schritte usw.)',
        category: 'system',
        parameters: [
            { name: 'key', type: 'string', description: 'Setting: continuations, steps, retries, timeout, delay, notify (leer = alle anzeigen)', required: false },
            { name: 'value', type: 'number', description: 'Neuer Wert (timeout/delay in Sekunden)', required: false },
        ],
        async handler(params) {
            const { formatMissionConfig, updateMissionConfig } = await import('../core/autonomous-executor.js')
            if (!params.key) return formatMissionConfig()
            const key = String(params.key).toLowerCase()
            const val = Number(params.value)
            if (isNaN(val) || val < 0) return '❌ Wert muss eine positive Zahl sein.'
            const keyMap: Record<string, string> = {
                continuations: 'maxContinuations', cont: 'maxContinuations',
                steps: 'maxSteps', retries: 'maxRetries',
                timeout: 'timeoutPerStep', delay: 'delayBetweenSteps',
                notify: 'notifyEveryNSteps',
            }
            const configKey = keyMap[key]
            if (!configKey) return `? Unbekannter Key: ${key}`
            const actualVal = (configKey === 'timeoutPerStep' || configKey === 'delayBetweenSteps') ? val * 1000 : val
            updateMissionConfig({ [configKey]: actualVal })
            return formatMissionConfig()
        },
    },
]

// ============================================
// Mesh Network Tools (Multi-Node)
// ============================================

const meshTools: NovaTool[] = [
    {
        name: 'mesh_transport_status',
        description: 'Zeigt den direkten Mesh-Datenpfad, Transport-Fallbacks, Queue, Peer-Schlüssel-Fingerprints und Verbindungsstatus.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const runtime = await import('../mesh/mesh-transport-runtime.js')
            const transport = runtime.getMeshTransport()
            return {
                identity: runtime.meshTransportPublicIdentity(),
                router: transport?.health(),
                transports: transport?.transportHealth() || [],
                peers: runtime.getMeshPeerStates(),
            }
        },
    },
    {
        name: 'mesh_status',
        description: 'Zeigt die aktuelle Betriebsansicht der Nova-Nodes. Historische und tombstoned Geräte werden bewusst ausgeblendet.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { formatMeshNodes } = await import('../mesh/mesh-registry.js')
            return await formatMeshNodes()
        },
    },
    {
        name: 'mesh_services',
        description: 'Zeigt Relay, Witness, Mesh-Transporte und laufende AI-Runtimes getrennt vom Nova-Node-Status.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { formatMeshServices } = await import('../mesh/mesh-registry.js')
            return await formatMeshServices()
        },
    },
    {
        name: 'mesh_nodes',
        description: 'Listet alle verfügbaren (online, nicht-busy) Nodes im Mesh auf — schnelle Übersicht für Task-Delegation.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { getAvailableNodes } = await import('../mesh/mesh-registry.js')
            const nodes = await getAvailableNodes()
            if (nodes.length === 0) return 'Keine verfügbaren Nodes im Mesh. Nur ich bin aktiv.'
            return nodes.map(n => `?? ${n.hostname} (${n.node_id}) — ${n.capabilities?.join(', ')}`).join('\n')
        },
    },
    {
        name: 'mesh_delegate',
        description: 'Übergibt eine Aufgabe an einen anderen Knoten im Mesh („an Knoten übergeben“); der Knoten arbeitet sie ab. Nicht dasselbe wie die Delegation an Claude, Codex, Hermes oder einen Unteragenten.',
        category: 'system',
        parameters: [
            { name: 'node_id', type: 'string', description: 'ID des Ziel-Nodes (z.B. nova-a1b2c3d4)', required: true },
            { name: 'task', type: 'string', description: 'Die Aufgabe die der Node erledigen soll', required: true },
        ],
        handler: async (params) => {
            const { delegateTask } = await import('../mesh/mesh-registry.js')
            const result = await delegateTask(String(params.node_id), String(params.task))
            if (!result) return '❌ Nicht an den Knoten übergeben: Knoten nicht erreichbar.'
            return `An Knoten übergeben.\nID: ${result.id}\nKnoten: ${result.to_node}\nStatus: ${result.status}\nTransport: ${result.transport || 'legacy'}`
        },
    },
    {
        name: 'mesh_deploy',
        description: 'Installiert Nova auf einem neuen Server via SSH. Klont das Repo, installiert Dependencies, konfiguriert und startet den Daemon.',
        category: 'system',
        parameters: [
            { name: 'host', type: 'string', description: 'SSH-Host (IP oder Hostname)', required: true },
            { name: 'user', type: 'string', description: 'SSH-User (default: root)', required: false },
            { name: 'port', type: 'number', description: 'SSH-Port (default: 22)', required: false },
        ],
        handler: async (params) => {
            const host = String(params.host)
            const user = String(params.user || 'root')
            const port = Number(params.port || 22)
            if (!/^[A-Za-z0-9._:-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(user)
                || !Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error('Ungültiges SSH-Ziel für mesh_deploy')
            }
            const { execFileSync } = await import('node:child_process')
            const target = `${user}@${host}`
            const installPath = '/opt/nova-core'
            const runRemote = (command: string, timeout = 120_000) => execFileSync(
                'ssh', ['-p', String(port), target, command], { encoding: 'utf-8', timeout },
            )
            const previous = runRemote(`if test -d ${installPath}/.git; then cd ${installPath} && git rev-parse HEAD; else echo __NOVA_ABSENT__; fi`, 20_000).trim()
            const previousRevision = /^[0-9a-f]{7,64}$/i.test(previous) ? previous : undefined
            const createdNewInstallation = previous === '__NOVA_ABSENT__'

            const commands = [
                'apt-get update && apt-get install -y nodejs npm git',
                `git clone https://github.com/xaventra/xaventra.git ${installPath} || (cd ${installPath} && git pull)`,
                `cd ${installPath} && npm install && npm run build`,
                `cd ${installPath} && npx pm2 start dist/daemon.js --name nova || npx pm2 restart nova`,
            ]

            const results: string[] = []
            for (const command of commands) {
                try {
                    runRemote(command)
                    results.push(`✅ ${command.slice(0, 60)}`)
                } catch (err: any) {
                    results.push(`❌ ${err.message?.slice(0, 100)}`)
                    break
                }
            }
            const success = results.length === commands.length && results.every(item => item.startsWith('✅'))
            return {
                success, host, steps: results,
                compensationReceipt: {
                    kind: 'mesh-deployment', host, user, port, installPath,
                    previousRevision, createdNewInstallation,
                },
            }
        },
    },
    {
        name: 'mesh_update',
        description: 'Startet den konfigurierten signierten Mesh-Release-Rollout mit Datei-Hashes, Canary, Heartbeat-Verifikation und Rollback.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8'))
            const updateConfig = config.mesh?.update
            if (!updateConfig?.enabled || !updateConfig.nodes?.length) return 'Kein sicheres Mesh-Update-Profil konfiguriert.'
            const { deployUpdateToAllNodes } = await import('../core/auto-updater.js')
            const success = await deployUpdateToAllNodes(updateConfig)
            return success ? 'Mesh-Release auf allen Ziel-Nodes verifiziert.' : 'Rollout fehlgeschlagen oder zurückgerollt; siehe /update status.'
        },
    },
]

// ============================================
// File Transfer Tools (Telegram + Mesh)
// ============================================

const sendFileTool: NovaTool = {
    name: 'send_file',
    description: 'Sendet eine lokale Datei an den User via Telegram. Erkennt automatisch ob Foto oder Dokument. NUTZE DIESES TOOL wenn der User eine Datei, ein Bild oder ein Dokument geschickt haben will.',
    category: 'media',
    parameters: [
        { name: 'path', type: 'string', description: 'Absoluter Pfad zur lokalen Datei', required: true },
        { name: 'caption', type: 'string', description: 'Optionale Beschriftung/Caption', required: false },
        { name: 'as_document', type: 'boolean', description: 'Als Dokument senden (nicht als Foto komprimieren)', required: false },
    ],
    handler: async (params) => {
        const { executeSendFile } = await import('./send-file-tool.js')
        return executeSendFile(params)
    },
}

const meshDownloadFileTool: NovaTool = {
    name: 'mesh_download_file',
    description: 'Lädt eine Datei von einem Remote-Mesh-Node (Jetson, Pi, Server) via SSH herunter und speichert sie lokal. Nutze das um Dateien von anderen Geräten zu holen bevor du sie mit send_file weiterschickst.',
    category: 'system',
    parameters: [
        { name: 'host', type: 'string', description: 'Remote Host/IP (z.B. 100.64.0.22)', required: true },
        { name: 'remote_path', type: 'string', description: 'Dateipfad auf dem Remote-Host (z.B. /tmp/photo.jpg)', required: true },
        { name: 'user', type: 'string', description: 'SSH User (z.B. xaventra)', required: false },
        { name: 'local_name', type: 'string', description: 'Optionaler lokaler Dateiname', required: false },
    ],
    handler: async (params) => {
        const { execSync } = await import('node:child_process')
        const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
        const { join, basename } = await import('node:path')

        const host = params.host as string
        const remotePath = params.remote_path as string
        const user = params.user as string || 'xaventra'
        const localName = (params.local_name as string) || basename(remotePath)

        const downloadDir = join(process.cwd(), '.nova-data', 'downloads')
        if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })
        const localPath = join(downloadDir, localName)

        try {
            // Method 1: SSH cat + base64 (works everywhere, no SCP needed)
            const b64output = execSync(
                `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${user}@${host} "base64 '${remotePath}'"`,
                { encoding: 'utf-8', timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }
            )
            const buffer = Buffer.from(b64output.trim(), 'base64')
            writeFileSync(localPath, buffer)
            console.log(`[MeshDownload] ✅ ${remotePath} → ${localPath} (${buffer.length} bytes)`)
            return { success: true, local_path: localPath, size: buffer.length, source: `${user}@${host}:${remotePath}` }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`[MeshDownload] ❌ ${msg}`)
            return { error: `Download fehlgeschlagen: ${msg}`, host, remote_path: remotePath }
        }
    },
}

const desktopControlTools: NovaTool[] = [
    {
        name: 'desktop_workspace',
        description: 'Liest oder durchsucht den vom Benutzer im verbundenen Nova Desktop explizit freigegebenen Projektordner. Nutze list fuer Struktur, read fuer eine konkrete Text-/Code-Datei und search fuer Quelltextsuche. Nur relative Pfade; keine Writes, Credentials, .git, node_modules oder geheimen Dateien.',
        category: 'file',
        parameters: [
            { name: 'operation', type: 'string', description: 'list, read oder search', required: true },
            { name: 'relative_path', type: 'string', description: 'Relativer Pfad im freigegebenen Workspace, Standard .', required: false },
            { name: 'query', type: 'string', description: 'Suchtext fuer operation=search', required: false },
        ],
        handler: async params => {
            const { getDesktopAgentContext } = await import('../desktop/desktop-agent-context.js')
            const context = getDesktopAgentContext()
            if (!context?.clientId || !context.workspaceId) return { success: false, error: 'No user-approved Desktop workspace is bound to this room.' }
            const operation = String(params.operation || '') as 'list' | 'read' | 'search'
            if (!['list', 'read', 'search'].includes(operation)) return { success: false, error: 'Workspace operation must be list, read, or search.' }
            if (operation === 'search' && !String(params.query || '').trim()) return { success: false, error: 'Workspace search requires a query.' }
            const { getDesktopControlQueue } = await import('../desktop/desktop-control.js')
            const queue = getDesktopControlQueue()
            const command = queue.enqueue(context.principalId, 'workspace_operation', {
                workspaceId: context.workspaceId,
                operation,
                relativePath: String(params.relative_path || '.'),
                query: params.query ? String(params.query) : undefined,
            }, `desktop-workspace:${context.botId}`, context.clientId)
            const completed = await queue.waitForCompletion(context.principalId, command.id, 30_000)
            if (completed.status !== 'acknowledged' || completed.result?.kind !== 'workspace_result') {
                return { success: false, error: completed.error || `Desktop workspace operation ${completed.status}` }
            }
            return { success: true, source: 'authenticated-desktop-workspace', ...completed.result }
        },
    },
    {
        name: 'desktop_control',
        description: 'Steuert Nova Desktop mit typisierten, auditierbaren UI-Aktionen. Nur lokal ueber CLI oder einen authentifizierten Desktop-Owner verwenden; keine freie DOM-, Electron- oder Shell-Steuerung.',
        category: 'other',
        parameters: [
            { name: 'action', type: 'string', description: 'navigate, open_room, select_model, refresh, focus oder notify', required: true },
            { name: 'section', type: 'string', description: 'Fuer navigate: heute, chat, arbeit, system, gedaechtnis, mehr, trust, bots, modules, security oder settings', required: false },
            { name: 'room_id', type: 'string', description: 'Fuer open_room: ID des Themenraums', required: false },
            { name: 'model', type: 'string', description: 'Fuer select_model: Modell-ID oder auto', required: false },
            { name: 'message', type: 'string', description: 'Fuer notify: kurze sichtbare Meldung', required: false },
        ],
        handler: async params => {
            const { getUserPermission } = await import('../users/multi-user-middleware.js')
            const authorizationUserId = String(params.authorizationUserId || '')
            const permission = getUserPermission(authorizationUserId, String(params.channel || 'unknown'))
            if (permission !== 'owner' && permission !== 'admin') return { success: false, blocked: true, error: 'Desktop control requires Owner/Admin' }
            const ownerId = authorizationUserId.startsWith('desktop:')
                ? authorizationUserId.slice('desktop:'.length)
                : (process.env.NOVA_DESKTOP_OWNER_ID || 'desktop-owner')
            const { getDesktopControlQueue } = await import('../desktop/desktop-control.js')
            const command = getDesktopControlQueue().enqueue(ownerId, String(params.action || '') as any, {
                section: params.section as any,
                roomId: params.room_id ? String(params.room_id) : undefined,
                model: params.model ? String(params.model) : undefined,
                message: params.message ? String(params.message) : undefined,
            }, `tool:${authorizationUserId}`)
            return { success: true, queued: true, commandId: command.id, action: command.action, expiresAt: command.expiresAt }
        },
    },
    {
        name: 'desktop_status',
        description: 'Zeigt bestaetigte, fehlgeschlagene und noch offene Nova-Desktop-Steuerbefehle fuer den aktuellen Owner.',
        category: 'other',
        parameters: [],
        handler: async params => {
            const authorizationUserId = String(params.authorizationUserId || '')
            const ownerId = authorizationUserId.startsWith('desktop:')
                ? authorizationUserId.slice('desktop:'.length)
                : (process.env.NOVA_DESKTOP_OWNER_ID || 'desktop-owner')
            const { getDesktopControlQueue } = await import('../desktop/desktop-control.js')
            return { success: true, commands: getDesktopControlQueue().list(ownerId, 25) }
        },
    },
]

export const ALL_TOOLS: NovaTool[] = [
    ...fileTools,
    ...systemTools,
    ...browserTools,
    ...memoryTools,
    ...evolutionTools,
    ...systemHelperTools,
    ...devopsTools,
    ...execApprovalTools,
    ...autoUpdateTools,
    ...ttsTools,
    ...meshBrainTools,
    ...securityAuditTools,
    ...blueTeamTools,
    ...hooksTools,
    ...mediaTools,
    ...learningTools,
    ...selfManagementTools,
    ...mediaProviderTools,
    ...selfModificationTools,
    ...markdownTools,
    ...sessionTools,
    ...pluginTools,
    ...missionTools,
    ...missionWorkspaceTools,
    ...developerCapabilityTools,
    ...meshTools,
    ...desktopControlTools,

    ...pollTools,
    ...browserAutomationTools,
    ...browserUseTools,
    ...agentPatternTools,
    ...homeAssistantTools,
    scanNowTool,
    meshInspectUrlTool,
    ...meshExchangeTools,
    meshScreenshotTool,
    environmentInventoryTool,
    parcelTrackTool,
    ...printerTools,
    ...minimaxTools,
    apiKeyTool,
    saveConfigTool,
    braveSearchTool,
    tavilySearchTool,
    searxngSearchTool,
    reminderTool,
    listRemindersTool,
    createSkillTool,
    listSkillsTool,
    deleteSkillTool,
    buildSkillTool,
    sendFileTool,
    meshDownloadFileTool,
    {
        name: 'send_telegram_message',
        description: 'Sendet eine Telegram-Nachricht an einen konfigurierten Benutzeralias oder eine direkte Chat-ID.',
        category: 'other' as const,
        parameters: [
            { name: 'to', type: 'string', description: 'Empfänger: konfigurierter Alias oder direkte Chat-ID/Nummer', required: true },
            { name: 'message', type: 'string', description: 'Nachricht die gesendet werden soll', required: true },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (!tg) throw new Error('Telegram nicht verbunden')

                // Resolve user names only from the local runtime configuration.
                const aliases: Record<string, string> = {}
                const rawTo = String(params.to || '').toLowerCase().trim()
                const chatId = aliases[rawTo] || String(params.to)

                // Try to load user aliases from config
                try {
                    const { existsSync, readFileSync } = await import('node:fs')
                    const { join } = await import('node:path')
                    const cfgPath = resolveConfigPath()
                    if (existsSync(cfgPath)) {
                        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
                        const configAliases = cfg.userAliases || {}
                        for (const [id, name] of Object.entries(configAliases)) {
                            if ((name as string).toLowerCase() === rawTo) {
                                Object.assign(aliases, { [rawTo]: id })
                            }
                        }
                    }
                } catch { /* non-critical */ }

                const resolvedId = aliases[rawTo] || String(params.to)
                // Anyone but the owner is "nach außen senden" (Alfred 23.09./01.10.):
                // only with the owner's approval, bound to this recipient.
                const { isConfiguredOwner, getConfigAllowFrom } = await import('../users/multi-user-middleware.js')
                if (!isConfiguredOwner(resolvedId, 'telegram', getConfigAllowFrom())) {
                    const refusal = await ownerApprovalRefusal(params, 'send_telegram_message', resolvedId)
                    if (refusal) return { success: false, error: refusal }
                }
                const sent = (tg as any).bot?.sendMessage
                    ? await (tg as any).bot.sendMessage(resolvedId, String(params.message))
                    : await tg.send({ to: resolvedId, content: String(params.message), channel: 'telegram' })
                return {
                    success: true, sentTo: resolvedId,
                    messageId: Number((sent as any)?.message_id || 0) || undefined,
                    message: `✅ Nachricht an ${params.to} (${resolvedId}) gesendet`,
                }
            } catch (err) {
                return { success: false, error: String(err) }
            }
        },
    },

    // Code Analysis Tools (advanced)
    codeSearchTool,
    findByNameTool,
    codeOutlineTool,
    viewCodeItemTool,

    // Knowledge System (KI equivalent)
    knowledgeStoreTool,
    knowledgeRecallTool,
    knowledgeListTool,
    knowledgeDeleteTool,
    knowledgeGetTool,

    // Subagent Delegation
    {
        name: 'spawn_subagent',
        description: 'Spawnt einen fokussierten Subagenten für eine Teilaufgabe. Ideal für parallele Arbeit oder isolierte Recherchen. Der Subagent bekommt nur die erlaubten Tools und läuft mit eigenem Timeout.',
        category: 'system',
        parameters: [
            { name: 'task', type: 'string', description: 'Was soll der Subagent tun? Klare, fokussierte Aufgabenbeschreibung.', required: true },
            { name: 'tools', type: 'string', description: 'Kommagetrennte Tool-Namen (optional). Standard: alle sicheren Tools.', required: false },
            { name: 'timeout_seconds', type: 'number', description: 'Timeout in Sekunden (Standard: 60)', required: false },
            { name: 'mesh_node', type: 'string', description: 'Optional: Knoten-ID für Remote-Delegation, oder "auto" = der passende Knoten nach Stärken (GPU, Modelle, Last, Latenz)', required: false },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { spawnSubagent } = await import('../agents/subagent-orchestrator.js')
                const tools = params.tools ? String(params.tools).split(',').map(t => t.trim()) : undefined
                // Mesh-Gehirn 2.88: "auto" picks the node from the signed strength profiles, with the reason.
                let meshNode = params.mesh_node ? String(params.mesh_node) : undefined
                let placement = ''
                if (meshNode === 'auto') {
                    const { routeTask } = await import('../mesh/mesh-router.js')
                    const decision = await routeTask(String(params.task))
                    meshNode = decision.isLocal ? undefined : decision.nodeId
                    placement = `Knoten: ${decision.isLocal ? 'hier' : decision.nodeId} (${decision.reason})\n`
                }
                const result = await spawnSubagent({
                    task: String(params.task),
                    tools,
                    timeoutMs: (Number(params.timeout_seconds) || 60) * 1000,
                    meshNode,
                    ...(await subagentParentIdentity(params)),
                })
                if (result.status === 'completed') {
                    return `${placement}✅ Subagent ${result.id} fertig (${result.durationMs}ms):\n${result.output}`
                } else {
                    return `${placement}⚠️ Subagent ${result.id}: ${result.status}${result.error ? ' — ' + result.error : ''}`
                }
            } catch (err) {
                return `Subagent-Fehler: ${err}`
            }
        },
    },
    {
        name: 'list_subagents',
        description: 'Zeigt alle aktiven und zuletzt gestarteten Subagenten.',
        category: 'system',
        parameters: [],
        handler: async () => {
            try {
                const { listSubagents } = await import('../agents/subagent-orchestrator.js')
                const agents = listSubagents()
                if (agents.length === 0) return 'Keine aktiven Subagenten.'
                return agents.map(a =>
                    `- [${a.id}] ${a.status.toUpperCase()} | "${a.task}" | ${a.durationMs}ms`
                ).join('\n')
            } catch (err) {
                return `Fehler: ${err}`
            }
        },
    },
    {
        name: 'spawn_subagents_parallel',
        description: 'Spawnt MEHRERE Subagenten gleichzeitig (echt parallel) und wartet auf alle Ergebnisse. Perfekt für parallele Recherchen, Multi-Node-Analysen oder unabhängige Teilaufgaben.',
        category: 'system',
        parameters: [
            {
                name: 'tasks',
                type: 'object',
                description: 'Array von Task-Objekten: [{task: string, tools?: string, timeout_seconds?: number, mesh_node?: string}, ...]',
                required: true,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { spawnSubagentsParallel } = await import('../agents/subagent-orchestrator.js')
                const raw = params.tasks
                const tasks = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : [])
                if (!tasks.length) return 'Keine Tasks übergeben.'
                return await spawnSubagentsParallel(tasks, await subagentParentIdentity(params))
            } catch (err) {
                return `Parallel-Spawn-Fehler: ${err}`
            }
        },
    },

    // Knowledge Graph Tools (LLM-unabhängige Faktensuche)
    {
        name: 'kg_search',
        description: 'Durchsucht den Knowledge Graph per Keyword — kein LLM nötig. Findet Fakten, Beziehungen und Eigenschaften von Entitäten.',
        category: 'memory',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchbegriff oder Frage', required: true },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { searchGraph } = await import('../memory/knowledge-graph.js')
                // INT-10: principal-bound. Only the owner searches every scope;
                // everyone else sees their own scope and global facts.
                const result = searchGraph(String(params.query), 6, await kgSearchScopes(params))
                return result || 'Keine Treffer im Knowledge Graph.'
            } catch (err) {
                return `KG-Suche Fehler: ${err}`
            }
        },
    },
    {
        name: 'kg_remember',
        description: 'Speichert eine Tatsache direkt im Knowledge Graph. Z.B. "Sample nutzt tmux" → kg_remember("Sample", "uses", "tmux")',
        category: 'memory',
        parameters: [
            { name: 'subject', type: 'string', description: 'Entität (z.B. "Sample", "Nova", "MacMini")', required: true },
            { name: 'relation', type: 'string', description: 'Beziehung (z.B. "uses", "prefers", "owns")', required: true },
            { name: 'object', type: 'string', description: 'Wert oder Ziel-Entität', required: true },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                const record = await getMemoryGovernanceCoordinator().record({
                    content: `${params.subject} —[${params.relation}]→ ${params.object}`,
                    kind: 'relationship', scope: `user:${String(params.userId || 'system')}`,
                    source: 'kg_remember', evidence: 'explicit_user_instruction', confidence: 1, verified: true,
                    subject: String(params.subject), predicate: String(params.relation), value: String(params.object),
                })
                return record ? `✅ Governance ${record.id}: ${record.status}` : '❌ Memory rejected'
            } catch (err) {
                return `KG-Fehler: ${err}`
            }
        },
    },

    // External LLM Provider Management (Nova registers APIs herself)
    {
        name: 'register_llm_provider',
        description: 'Registriert einen neuen LLM-API-Provider (OpenAI-kompatibel): MiniMax, Kimi, DeepSeek, Mistral, Cohere, Groq, Together etc. Nova testet den API-Key und speichert den Provider dauerhaft.',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Provider-Name (z.B. "minimax", "kimi", "deepseek")', required: true },
            { name: 'api_key', type: 'string', description: 'API Key des Providers', required: true },
            { name: 'base_url', type: 'string', description: 'OpenAI-kompatibler Basis-URL (z.B. https://api.minimax.chat/v1)', required: true },
            { name: 'models', type: 'string', description: 'Kommagetrennte Modell-IDs (optional — werden sonst auto-entdeckt)', required: false },
            { name: 'roles', type: 'string', description: 'Kommagetrennte Rollen: chat,code,vision,embedding (Standard: chat,code)', required: false },
            { name: 'confirm', type: 'string', description: 'Einmal-Freigabecode, den der Owner selbst nennt. Niemals selbst bilden.', required: false },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                // R2 R1/A8: a provider receives every prompt and the API key.
                // New name only (no silent overwrite), public https endpoint
                // (SSRF guard), explicit owner approval.
                const name = String(params.name ?? '').trim()
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name)) return 'Provider-Registrierung abgelehnt: ungültiger Name.'
                const baseUrl = String(params.base_url ?? '').trim().replace(/\/$/, '')
                if (!/^https:\/\//i.test(baseUrl)) return 'Provider-Registrierung abgelehnt: base_url muss eine https-Adresse sein.'
                const { checkUrlResolved } = await import('../resilience/ssrf-guard.js')
                const target = await checkUrlResolved(baseUrl)
                if (!target.allowed) return `Provider-Registrierung abgelehnt: base_url nicht erlaubt (${target.reason}).`
                const { registerExternalProvider, listExternalProviders } = await import('../core/model-resolver.js')
                const existing = listExternalProviders().some(p => p.name.toLowerCase() === name.toLowerCase())
                let configured = false
                try {
                    const { readFileSync, existsSync } = await import('node:fs')
                    const configPath = resolveConfigPath()
                    if (existsSync(configPath)) {
                        const providers = JSON.parse(readFileSync(configPath, 'utf-8'))?.providers || {}
                        configured = Object.keys(providers).some(key => key.toLowerCase() === name.toLowerCase())
                    }
                } catch {
                    return 'Provider-Registrierung abgelehnt: Konfiguration nicht lesbar.'
                }
                if (existing || configured) return `Provider-Registrierung abgelehnt: "${name}" existiert bereits und wird über dieses Werkzeug nicht überschrieben.`
                // UEB-8: the one-time owner code is bound to exactly this name and base URL
                const refusal = await ownerApprovalRefusal(params, 'register_llm_provider', `${name}@${baseUrl}`)
                if (refusal) return refusal
                const models = params.models ? String(params.models).split(',').map(m => m.trim()).filter(Boolean) : undefined
                const roles = params.roles ? String(params.roles).split(',').map(r => r.trim()) as any[] : ['chat', 'code']
                const result = await registerExternalProvider({
                    name,
                    apiKey: String(params.api_key),
                    baseUrl,
                    models,
                    roles,
                    enabled: true,
                })
                return result.message
            } catch (err) {
                return `Provider-Registrierung fehlgeschlagen: ${err}`
            }
        },
    },
    {
        name: 'list_llm_providers',
        description: 'Zeigt alle registrierten LLM-Provider (lokal, Mesh, Cloud, externe APIs).',
        category: 'system',
        parameters: [],
        handler: async () => {
            try {
                const { listExternalProviders, getCapabilityStatus } = await import('../core/model-resolver.js')
                const ext = listExternalProviders()
                const status = getCapabilityStatus()
                const extList = ext.length > 0
                    ? '\n\n**Registrierte externe Provider:**\n' + ext.map(p =>
                        `- ${p.name}: ${p.enabled ? '✅' : '❌'} | ${p.models?.length || 0} Modelle | ${p.baseUrl}`
                    ).join('\n')
                    : '\n\n*Keine externen Provider registriert*'
                return status + extList
            } catch (err) {
                return `Fehler: ${err}`
            }
        },
    },
    {
        name: 'remove_llm_provider',
        description: 'Entfernt einen registrierten externen LLM-Provider.',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Providers', required: true },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { removeExternalProvider } = await import('../core/model-resolver.js')
                const ok = removeExternalProvider(String(params.name))
                return ok ? `✅ Provider "${params.name}" entfernt.` : `Provider "${params.name}" nicht gefunden.`
            } catch (err) {
                return `Fehler: ${err}`
            }
        },
    },

    // Capability Router — Nova installs missing tools autonomously
    capabilityTool,
]

// ============================================
// ADA V2 / MARK XXXIX Inspired Tools
// ============================================
import { cadGenerateTool } from './cad-tool.js'
import { printerDiscoveryTool, printerStatusTool, printerSliceTool, printerPrintTool } from './printer-tool.js'
import { screenCaptureTool, webcamCaptureTool, faceDetectionTool, handGestureTool, screenAnalysisTool } from './vision-tool.js'
import { desktopScreenshotTool } from './desktop-screenshot-tool.js'
import { desktopInputTool } from './desktop-input-tool.js'
import { resolveConfigPath } from '../config/config-path.js'


// Append new tools to ALL_TOOLS via direct assignment (bypass type strictness)
ALL_TOOLS.push(
    cadGenerateTool as any,
    printerDiscoveryTool as any,
    // R2 T18: not registered — the name belongs to the configured Moonraker
    // printer_status from 3dprinter.ts, which this legacy entry silently replaced.
    // printerStatusTool as any,
    printerSliceTool as any,
    printerPrintTool as any,
    desktopScreenshotTool as any,  // proper desktop capture: vision + auto-send
    desktopInputTool as any,
    screenCaptureTool as any,
    webcamCaptureTool as any,
    faceDetectionTool as any,
    handGestureTool as any,
    screenAnalysisTool as any,
)

// ============================================
// Tool Registry
// ============================================

export class NovaToolRegistry {
    private tools: Map<string, NovaTool> = new Map()
    private wrapped = new WeakSet<NovaTool['handler']>()

    constructor() {
        this.registerAll()
        // Self-built tools come only from the Werkzeug-Schmiede (forge_*, sandboxed);
        // the old .nova-tools/*.json loader (code built from text inside the daemon) is gone.
    }

    registerAll(): void {
        for (const tool of ALL_TOOLS) {
            this.register(tool)
        }

        // Register the Skill Pack loader (from tool-router) — async because ESM
        import('./tool-router.js').then(({ loadSkillPackTool }) => {
            if (loadSkillPackTool) {
                this.register(loadSkillPackTool)
                console.log(`[Tools] ✅ load_skill_pack Tool registriert`)
            }
        }).catch(() => { /* tool-router not yet available */ })

        console.log(`[Tools] ${this.tools.size} Tools registriert`)
    }

    register(tool: NovaTool): void {
        if (this.wrapped.has(tool.handler)) { this.tools.set(tool.name, tool); return }
        // Only the original built-in read handler is currently classified as
        // completion-bounded. Name reuse by a plugin never inherits that claim.
        const bounded = fileTools.some(t => t.name === 'read_file' && t.handler === tool.handler)
        const name = tool.name, execute = tool.handler
        const handler: NovaTool['handler'] = params => withRepairAdmission(name, bounded, () => execute(params))
        this.wrapped.add(handler)
        this.tools.set(tool.name, { ...tool, handler })
    }

    unregister(name: string): boolean {
        return this.tools.delete(name)
    }

    get(name: string): NovaTool | undefined {
        return this.tools.get(name)
    }

    getAll(): NovaTool[] {
        return Array.from(this.tools.values())
    }

    getByCategory(category: NovaTool['category']): NovaTool[] {
        return this.getAll().filter(t => t.category === category)
    }

    // Track consecutive failures per tool for L8 trigger
    private failureCount: Map<string, number> = new Map()

    async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
        const tool = this.tools.get(name)
        if (!tool) throw new Error(`Tool nicht gefunden: ${name}`)

        // One authoritative lifecycle-policy path for built-ins, plugins and
        // MCP tools. Pre-tool hooks may narrow/rewrite input or fail closed;
        // they never execute a second tool path beside the registry.
        const { getToolExecutionPipeline } = await import('../core/tool-execution-pipeline.js')
        const executionPipeline = getToolExecutionPipeline()
        const before = await executionPipeline.preflight(name, params)
        if (before.decision !== 'allow') {
            return executionPipeline.finalize(name, before.input, {
                success: false,
                blocked: true,
                awaitingApproval: before.decision === 'ask',
                error: before.reason || `Tool ${name} was blocked by lifecycle policy`,
            }, false)
        }
        params = before.input

        // ============================================
        // PRE-VALIDATE: Check params before execution
        // ============================================
        try {
            const { validateToolParams } = await import('../validation/tool-validator.js')
            const validation = validateToolParams(name, params)

            if (!validation.valid) {
                console.log(`[Validator] ? ${name}: ${validation.error}`)
                return executionPipeline.finalize(name, params, {
                    error: validation.error,
                    suggestion: validation.suggestion,
                    correctedParams: validation.correctedParams
                }, false)
            }
        } catch {
            // Validator not available, proceed without validation
        }

        // Execute tool and attempt L0 auto-repair if it fails. CL-07: every
        // handler with an effect runs behind the Main fence and is aborted
        // when the lease is lost (enforce); read-only tools are exempt.
        const fencedHandler = (input: Record<string, unknown>) => runFencedTool(name, () => tool.handler(input))
        let result = await fencedHandler(params)
        result = await executionPipeline.postprocess(name, params, result, isSuccessfulToolResult(result))

        // Check if result indicates an error
        if (!isSuccessfulToolResult(result)) {
            // Track failure by TOOL NAME only — not params!
            // Nova often varies params between retries, which would reset the counter
            const key = name
            const failures = (this.failureCount.get(key) || 0) + 1
            this.failureCount.set(key, failures)
            console.log(`[Registry] Tool "${name}" failed (${failures}x)`)

            // Feed L15 Self-Check (tool health tracking)
            try {
                const { reportToolFailure } = await import('../layers/L15-self-check.js')
                reportToolFailure(name)
            } catch { /* L15 not available */ }

            // Feed L7 Tool Learning (auto-learn from failures)
            try {
                const { getToolUsageLearner } = await import('../layers/L7-tool-learning.js')
                const learner = getToolUsageLearner()
                learner.recordUsage(name, 'auto-failure', params, false)
            } catch { /* L7 not available */ }

            // L0 diagnoses only. A repair/retry is a new governed action, never
            // a bare handler invocation hidden inside this failed call.
            try {
                const { getToolAutoRepairEngine } = await import('../layers/L0-tool-autorepair.js')
                const autoRepair = getToolAutoRepairEngine()
                const { result: diagnosedResult } = await autoRepair.repairAndRetry(
                    name,
                    params,
                    result as any,
                    fencedHandler
                )
                return executionPipeline.finalize(name, params, diagnosedResult, false)
            } catch (repairErr) {
                console.log(`[L0 AutoRepair] ? Repair engine not available: ${repairErr}`)
            }

            // Even when diagnosis fails, do not start unapproved background
            // agents or replay effects outside Kernel budgets and Tool-Gates.
        } else {
            // Success - reset failure counter
            const key = name
            this.failureCount.set(key, 0)

            // Feed L15 Self-Check (clear tool health flag)
            try {
                const { reportToolSuccess, reportToolResult } = await import('../layers/L15-self-check.js')
                reportToolSuccess(name)
                // Inspect result quality (empty results, silent errors)
                reportToolResult(name, result)
            } catch { /* L15 not available */ }
        }

        return executionPipeline.finalize(name, params, result, isSuccessfulToolResult(result))
    }

    getStats() {
        const all = this.getAll()
        const byCategory = new Map<string, number>()
        for (const t of all) {
            byCategory.set(t.category, (byCategory.get(t.category) || 0) + 1)
        }
        return {
            total: all.length,
            byCategory: Object.fromEntries(byCategory),
        }
    }
}

// ============================================
// Dynamic Tool Registry (with auto-scan)
// ============================================

let registry: NovaToolRegistry | null = null
let _dynamicTools: NovaTool[] | null = null

export function getToolRegistry(): NovaToolRegistry {
    if (!registry) {
        registry = new NovaToolRegistry()
    }
    return registry
}

/**
 * Returns ALL_TOOLS + any auto-discovered tools from dist/tools/*.js
 * Call this instead of ALL_TOOLS directly for the full tool list.
 */
export async function getDynamicTools(): Promise<NovaTool[]> {
    if (_dynamicTools) return _dynamicTools

    try {
        const { getScannedExtraTools } = await import('./tool-scanner.js')
        const existingNames = new Set(ALL_TOOLS.map(t => t.name))
        const extras = await getScannedExtraTools(existingNames)
        _dynamicTools = [...ALL_TOOLS, ...extras]
        if (extras.length > 0) {
            console.log(`[ToolRegistry] ✅ ${ALL_TOOLS.length} built-in + ${extras.length} auto-scanned = ${_dynamicTools.length} total tools`)
        }
        return _dynamicTools
    } catch {
        return ALL_TOOLS
    }
}

export function invalidateDynamicTools(): void {
    _dynamicTools = null
}

export default {
    NovaToolRegistry,
    getToolRegistry,
    getDynamicTools,
    ALL_TOOLS,
}
