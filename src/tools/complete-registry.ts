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

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { sshTool } from './ssh-tool.js'
import { capabilityTool } from './capability-tool.js'
import { browserUseTools } from './browser-use.js'
import { homeAssistantTools } from './homeassistant.js'
import { printerTools } from './3dprinter.js'
import { minimaxTools } from './minimax-tools.js'
import { blueTeamTools } from './blue-team-tools.js'
import { missionWorkspaceTools } from './mission-workspace-tools.js'
import { developerCapabilityTools } from './developer-capability-tools.js'

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
            const { readDocument } = await import('./document-reader.js')
            return readDocument(params.path as string)
        },
    },
    {
        name: 'read_file',
        description: 'Liest den Inhalt einer Datei. UnterstÃ¼tzt optionale start_line/end_line fÃ¼r gezieltes Lesen groÃŸer Dateien.',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Datei', required: true },
            { name: 'start_line', type: 'number', description: 'Erste Zeile (1-basiert, inklusiv). Optional.', required: false },
            { name: 'end_line', type: 'number', description: 'Letzte Zeile (1-basiert, inklusiv). Optional.', required: false },
        ],
        handler: async (params) => {
            const { readFileSync, existsSync, statSync } = await import('node:fs')
            const path = params.path as string
            if (!existsSync(path)) return { error: `Datei nicht gefunden: ${path}` }

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
        description: 'Schreibt Inhalt in eine Datei. ACHTUNG: GeschÃ¼tzte System-Dateien (daemon.ts, auth/, core/, L0-*) kÃ¶nnen nicht autonom Ã¼berschrieben werden.',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zur Datei', required: true },
            { name: 'content', type: 'string', description: 'Inhalt', required: true },
        ],
        handler: async (params) => {
            const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
            const { dirname, resolve, relative } = await import('node:path')
            const path = resolve(params.path as string)
            const cwd = process.cwd()
            const rel = relative(cwd, path).replace(/\\/g, '/')

            // === SECURITY: Protected Paths (Prompt Injection â†’ RCE Prevention) ===
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
                /^package\.json$/,
                /^tsconfig\.json$/,
                /^scripts\/deploy/,
            ]

            const isProtected = PROTECTED_PATTERNS.some(p => p.test(rel))
            if (isProtected) {
                console.log(`[SECURITY] ðŸš¨ BLOCKED write to protected path: ${rel}`)
                return {
                    error: `ðŸš¨ GESCHÃœTZT: "${rel}" ist ein System-kritischer Pfad. Ã„nderungen an Core-Dateien (daemon, auth, L0, config) erfordern manuelle BestÃ¤tigung durch den Admin. Nutze update_memory um die gewÃ¼nschte Ã„nderung zu dokumentieren.`,
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
                console.log(`[SECURITY] ðŸš¨ BLOCKED dangerous content in write to: ${rel}`)
                return {
                    error: `ðŸš¨ GEFÃ„HRLICHER INHALT erkannt in "${rel}". Der Inhalt enthÃ¤lt potenziell schÃ¤dliche Patterns (child_process, exec, eval, shell injection). Schreibvorgang blockiert.`,
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
                if (rel.endsWith('.ts') || rel.endsWith('.js') || rel.endsWith('.mjs')) {
                    const check = await fullSecurityCheck(content, rel, 'nova-self')
                    if (!check.allowed) {
                        console.log(`[CodeGuardian] ðŸš¨ BLOCKED: ${check.reason}`)
                        return {
                            error: `ðŸ›¡ï¸ Code Guardian hat den Schreibvorgang blockiert:\n${check.reason}\n\nConfidence: ${check.signature.confidence}\nHash: ${check.signature.hash}`,
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
                if (rel.endsWith('.ts') || rel.endsWith('.js') || rel.endsWith('.mjs')) {
                    console.error('[CodeGuardian] Pruefung fehlgeschlagen - Schreibvorgang abgelehnt: ' + guardErr);
                    return {
                        error: 'Code Guardian konnte nicht pruefen (' + String(guardErr).slice(0, 200) + '). '
                             + 'Schreibvorgang abgelehnt - ungeprueften Code schreibe ich auf diesem System nicht.',
                        blocked: true,
                        path: rel,
                    }
                }
                /* Nicht-Code: weiterhin erlaubt â€” allow write */ }

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
            const path = params.path as string
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
        description: 'LÃ¶scht eine Datei oder Ordner',
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
        description: 'FÃ¼hrt einen Shell-Befehl aus. Merkt sich das letzte Arbeitsverzeichnis. WICHTIG: Vor install-Befehlen (npm/pip/etc.) IMMER zuerst mit readfile oder listdir prÃ¼fen welche Dateien vorhanden sind! package.json â†’ npm, requirements.txt â†’ pip, Cargo.toml â†’ cargo. Nicht raten â€” lesen!',
        category: 'system',
        parameters: [
            { name: 'command', type: 'string', description: 'Befehl', required: true },
            { name: 'cwd', type: 'string', description: 'Arbeitsverzeichnis (optional ï¿½ wird automatisch vom letzten Befehl ï¿½bernommen)', required: false },
        ],
        handler: async (params) => {
            const { execSync } = await import('node:child_process')
            const { existsSync } = await import('node:fs')
            let command = params.command as string

            // ============================================
            // L8 Prisma Guards: Block dangerous DB operations
            // ============================================
            try {
                const prismaGuards = await import('../layers/L8-prisma-guards.js')
                const safety = prismaGuards.default.checkDatabaseSafety(command)
                if (safety.blocked) {
                    console.log(`[L8 PrismaGuards] ??? Blocked: ${safety.reason}`)
                    return `??? **Blocked by Safety Guard**\n\n${safety.reason}\n${safety.suggestion ? `\n?? ${safety.suggestion}` : ''}\n\n_Use explicit confirmation to override._`
                }
            } catch { /* L8 not loaded â€” skip */ }

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
                console.log(`[SECURITY] ðŸš¨ BLOCKED dangerous command: ${command.slice(0, 100)}`)
                return {
                    error: `ðŸš¨ GEFÃ„HRLICHER BEFEHL blockiert! Der Befehl enthÃ¤lt bekannte Angriffsmuster (Shell-Injection, Reverse-Shell, Disk-Wipe). AusfÃ¼hrung verweigert.`,
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
                    return { error: `ðŸš¨ Kill-Switch aktiv: ${ks.reason}. Keine Befehle erlaubt bis Admin zurÃ¼cksetzt.`, blocked: true }
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
                        error: `âŒ Kein package.json in ${cwd} â€” npm install kann hier nichts tun.`,
                        hint: isPython
                            ? `Dies ist ein PYTHON-Projekt! Nutze stattdessen: pip install -r requirements.txt`
                            : `PrÃ¼fe ob du im richtigen Verzeichnis bist. Nutze readfile oder listdir um die Dateien zu prÃ¼fen.`,
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
                        error: `âŒ ${reqFile} nicht gefunden in ${cwd}`,
                        hint: `PrÃ¼fe den Pfad mit listdir. Die Datei muss existieren bevor pip install lÃ¤uft.`,
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
                                hint: `Erstelle die Datei zuerst mit write_file bevor du sie ausfï¿½hren kannst`,
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
        description: 'Fï¿½hrt einen Befehl auf einem Remote-Gerï¿½t via SSH aus (Pi, NAS, Server etc.). WICHTIG: Nutze dieses Tool fï¿½r ALLE Befehle die auf einem anderen Gerï¿½t laufen sollen ï¿½ NICHT run_command! Gespeicherte Hosts/Passwï¿½rter werden automatisch verwendet. Anfï¿½hrungszeichen im Befehl werden automatisch escaped.',
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
                return { error: 'Health Monitor nicht verfï¿½gbar' }
            }
        },
    },
    {
        name: 'update_user_profile',
        description: 'Aktualisiert das User-Profil (USER.md). Nutze das wenn du neue Fakten ï¿½ber den User lernst: Name, Gerï¿½te, IPs, Projekte, Prï¿½ferenzen. Der content ersetzt den GESAMTEN Inhalt von USER.md.',
        category: 'system',
        parameters: [
            { name: 'content', type: 'string', description: 'Neuer Inhalt fï¿½r USER.md (Markdown)', required: true },
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
        description: 'Fï¿½gt einen Eintrag zum Langzeit-Gedï¿½chtnis (MEMORY.md) hinzu. Nutze das fï¿½r wichtige Entscheidungen, gelï¿½ste Probleme, gelernte Lektionen.',
        category: 'system',
        parameters: [
            { name: 'section', type: 'string', description: 'Abschnitt: "Gelï¿½ste Probleme", "Wichtige Entscheidungen", oder "Gelernte Lektionen"', required: true },
            { name: 'entry', type: 'string', description: 'Der Eintrag (kurz und prï¿½gnant)', required: true },
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
        description: 'Gibt die exakte aktuelle Systemzeit zurï¿½ck. NUTZE DAS wenn du die Uhrzeit brauchst ï¿½ NIEMALS raten oder schï¿½tzen! Dieses Tool liefert die echte Systemuhr.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const now = new Date()
            const h = now.getHours()
            let tageszeit = 'Nacht'
            if (h >= 5 && h < 8) tageszeit = 'Frï¿½her Morgen'
            else if (h >= 8 && h < 10) tageszeit = 'Morgen'
            else if (h >= 10 && h < 12) tageszeit = 'Vormittag'
            else if (h >= 12 && h < 14) tageszeit = 'Mittag'
            else if (h >= 14 && h < 17) tageszeit = 'Nachmittag'
            else if (h >= 17 && h < 20) tageszeit = 'Abend'
            else if (h >= 20 && h < 23) tageszeit = 'Spï¿½tabend'
            else if (h >= 0 && h < 5) tageszeit = 'Nacht (spï¿½t/frï¿½h)'

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
        description: 'Setzt Novas Ruhezeiten (Quiet Hours). Nutze dieses Tool wenn der User sagt er mï¿½chte nicht gestï¿½rt werden, nur im Notfall kontaktiert werden, oder die Ruhezeiten ï¿½ndern mï¿½chte.',
        category: 'system',
        parameters: [
            { name: 'mode', type: 'string', description: 'Modus: "on" (Standard 23-07), "off" (24/7 erreichbar), "emergency" (nur Notfï¿½lle), "custom" (eigene Zeiten)', required: true },
            { name: 'start', type: 'number', description: 'Startzeit (0-23) ï¿½ nur bei mode=custom', required: false },
            { name: 'end', type: 'number', description: 'Endzeit (0-23) ï¿½ nur bei mode=custom', required: false },
        ],
        handler: async (params) => {
            try {
                const { updateAutonomyConfig, getAutonomyStatus } = await import('../core/autonomy-loop.js')
                const mode = (params.mode as string || 'on').toLowerCase()

                if (mode === 'on' || mode === 'an') {
                    updateAutonomyConfig({ quietHoursStart: 23, quietHoursEnd: 7 })
                    return { success: true, message: 'Quiet Hours aktiviert: 23:00 - 07:00. Keine autonomen Nachrichten in dieser Zeit.' }
                }

                if (mode === 'off' || mode === 'aus') {
                    updateAutonomyConfig({ quietHoursStart: -1, quietHoursEnd: -1 })
                    return { success: true, message: 'Quiet Hours deaktiviert. Nova kann dich rund um die Uhr kontaktieren.' }
                }

                if (mode === 'emergency' || mode === 'notfall' || mode === 'critical') {
                    updateAutonomyConfig({ quietHoursStart: 0, quietHoursEnd: 23, maxNotificationsPerHour: 1 })
                    return { success: true, message: 'Nur-Notfall Modus aktiviert. Nova meldet sich nur bei kritischen Problemen (max 1x/Stunde).' }
                }

                if (mode === 'custom') {
                    const start = params.start as number ?? 23
                    const end = params.end as number ?? 7
                    if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
                        updateAutonomyConfig({ quietHoursStart: start, quietHoursEnd: end })
                        return { success: true, message: `Quiet Hours angepasst: ${start}:00 - ${end}:00` }
                    }
                    return { success: false, message: 'Ungï¿½ltige Zeiten. Bitte 0-23 verwenden.' }
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

                return { success: false, message: 'Unbekannter Modus. Verfï¿½gbar: on, off, emergency, custom, status' }
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
        description: 'Sucht im Internet mit DuckDuckGo (kein API-Key nÃ¶tig)',
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
        description: 'Sucht mit Google Ã¼ber Headless-Browser (Playwright). Gibt echte Suchergebnisse zurÃ¼ck.',
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
                console.log('[Google Search] Playwright nicht verfÃ¼gbar, nutze DuckDuckGo Fallback')
                const webSearch = browserTools.find(t => t.name === 'web_search')
                if (webSearch) return webSearch.handler(params)
                return { error: err.message }
            }
        },
    },
    {
        name: 'fetch_url',
        description: 'LÃ¤dt den Inhalt einer URL herunter und konvertiert HTML zu sauberem Markdown.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'URL', required: true },
            { name: 'raw', type: 'boolean', description: 'Wenn true, wird rohes HTML zurÃ¼ckgegeben statt Markdown', required: false },
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
        description: 'Ruft Erinnerungen aus dem Langzeit-Gedï¿½chtnis ab (LanceDB mit MMR, Temporal Decay, Hybrid Search)',
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
        description: 'ï¿½ndert Novas eigenen Code sicher: Git-Branch ? Code-ï¿½nderung ? Build ? Test ? Merge bei Erfolg / Rollback bei Fehler. NUR Dateien in src/ erlaubt.',
        category: 'system',
        parameters: [
            { name: 'file', type: 'string', description: 'Relativer Pfad zur Datei (z.B. src/core/runtime.ts)', required: true },
            { name: 'description', type: 'string', description: 'Was die ï¿½nderung bewirkt', required: true },
            { name: 'search', type: 'string', description: 'Exakter Text der ersetzt werden soll', required: true },
            { name: 'replace', type: 'string', description: 'Neuer Text', required: true },
            { name: 'apply', type: 'boolean', description: 'Nur true setzen wenn der Patch wirklich angewendet werden soll', required: false },
            { name: 'approvalToken', type: 'string', description: 'Patch-Gate Token aus signiertem User-Befehl', required: false },
            { name: 'reason', type: 'string', description: 'Warum diese ï¿½nderung', required: false },
        ],
        handler: async (params) => {
            const { evolve } = await import('../synthesis/self-evolution.js')
            return await evolve({
                file: params.file as string,
                description: params.description as string,
                search: params.search as string,
                replace: params.replace as string,
                reason: params.reason as string | undefined,
                apply: params.apply === true,
                approvalToken: params.approvalToken as string | undefined,
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
        description: 'Zeigt die letzten Self-Evolution-ï¿½nderungen an',
        category: 'system',
        parameters: [
            { name: 'limit', type: 'number', description: 'Max Anzahl Eintrï¿½ge', required: false },
        ],
        handler: async (params) => {
            const { getEvolutionHistory } = await import('../synthesis/self-evolution.js')
            return getEvolutionHistory((params.limit as number) || 20)
        },
    },
    {
        name: 'evolution_stats',
        description: 'Zeigt Statistiken ï¿½ber bisherige Self-Evolutions',
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
        ],
        handler: async (params) => {
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
        description: 'Fuehrt eine freigegebene Self-Setup-Aktion aus. Im normalen Modus ist confirm="APPLY:<actionId>" noetig; im YOLO-Modus nicht.',
        category: 'system',
        parameters: [
            { name: 'action_id', type: 'string', description: 'Action-ID aus self_setup_plan oder "all"', required: true },
            { name: 'confirm', type: 'string', description: 'Freigabe: APPLY:<actionId> oder APPLY_ALL:<generatedAt>', required: false },
        ],
        handler: async (params) => {
            const { applySelfSetupAction, applySelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
            const actionId = String(params.action_id)
            if (actionId === 'all') return await applySelfSetupPlan(String(params.confirm || ''))
            return await applySelfSetupAction(actionId, String(params.confirm || ''))
        },
    },
    {
        name: 'self_setup_research',
        description: 'Recherchiert via Websuche fÃ¼r ALLE aktuell fehlenden Capabilities die beste aktuelle Installationsstrategie und schreibt die Ergebnisse (mit Confidence, Quelle, Hardware-Match) zurÃ¼ck in setup-state.json. Research lÃ¤uft ohne Gate. Install/Apply bleibt weiter freigabepflichtig.',
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
        description: 'Recherchiert via Websuche die aktuell beste Installationsstrategie fÃ¼r eine fehlende AI-Capability (stt/tts/llm/embedding/vision/ffmpeg) auf der passenden Hardware. BerÃ¼cksichtigt Apple Silicon, CUDA, ARM, Windows. Ergebnis wird in Setup-Aktionen umgewandelt.',
        category: 'system',
        parameters: [
            { name: 'capability', type: 'string', description: 'Welche Capability: stt, tts, llm, embedding, vision, ffmpeg, whisper, ollama', required: true },
            { name: 'node', type: 'string', description: 'Spezifischer Mesh-Node-Name (optional; sonst wird bester Node automatisch gewÃ¤hlt)', required: false },
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
        description: 'Legacy: installiert fehlende Capability nur mit confirm="AUTO_PROVISION:<capability>" oder YOLO-Modus. Sonst self_setup_plan nutzen.',
        category: 'system',
        parameters: [
            { name: 'capability', type: 'string', description: 'Was installiert werden soll: vision, tts, stt, llm, embedding', required: true },
            { name: 'confirm', type: 'string', description: 'Freigabe: AUTO_PROVISION:<capability>', required: false },
        ],
        handler: async (params) => {
            const capability = String(params.capability)
            let cfg: any = {}
            try {
                const { readFileSync } = await import('node:fs')
                const { join } = await import('node:path')
                cfg = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf-8'))
            } catch { cfg = {} }
            const yolo = process.env.NOVA_SELF_SETUP_YOLO === '1' || process.env.NOVA_YOLO === '1' || cfg.selfSetup?.mode === 'yolo' || cfg.selfSetup?.yolo === true
            if (!yolo && params.confirm !== `AUTO_PROVISION:${capability}`) {
                return `Auto-Provisioning ist gesperrt. Nutze self_setup_plan oder bestaetige mit confirm="AUTO_PROVISION:${capability}".`
            }
            const { autoProvision } = await import('../mesh/capability-orchestrator.js')
            const result = await autoProvision(capability)
            return result.message
        },
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
            const { execSync } = await import('node:child_process')
            try {
                const flag = params.all ? '-a' : ''
                const output = execSync(`docker ps ${flag} --format "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"`, {
                    encoding: 'utf-8', timeout: 10_000,
                })
                const containers = output.trim().split('\n').filter(Boolean).map(line => {
                    const [id, name, status, image, ports] = line.split('\t')
                    return { id, name, status, image, ports }
                })
                return { success: true, count: containers.length, containers }
            } catch (err: any) {
                return { success: false, error: `Docker nicht verfï¿½gbar: ${err.message}` }
            }
        },
    },
    {
        name: 'docker_logs',
        description: 'Zeigt Logs eines Docker-Containers',
        category: 'system',
        parameters: [
            { name: 'container', type: 'string', description: 'Container-Name oder ID', required: true },
            { name: 'lines', type: 'number', description: 'Anzahl der letzten Zeilen', required: false },
        ],
        handler: async (params) => {
            const { execSync } = await import('node:child_process')
            try {
                const lines = (params.lines as number) || 50
                const output = execSync(`docker logs --tail ${lines} "${params.container}"`, {
                    encoding: 'utf-8', timeout: 10_000,
                })
                return { success: true, container: params.container, logs: output }
            } catch (err: any) {
                return { success: false, error: err.message }
            }
        },
    },
    {
        name: 'port_scan',
        description: 'Scannt offene Ports auf localhost',
        category: 'system',
        parameters: [
            { name: 'ports', type: 'string', description: 'Komma-getrennte Ports zum Prï¿½fen (z.B. "3000,3001,8080"). Leer = Standard-Ports', required: false },
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
            { name: 'path', type: 'string', description: 'Pfad zum Prï¿½fen (default: /)', required: false },
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
        description: 'Prï¿½ft den Status eines systemd-Services (Linux) oder Windows-Dienstes',
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
        description: 'Prï¿½ft ob ein Command sicher ist: erkennt rm -rf, DROP DATABASE, Fork Bombs etc. Gibt Risk-Level zurï¿½ck.',
        category: 'security',
        parameters: [
            { name: 'command', type: 'string', description: 'Das zu prï¿½fende Command', required: true },
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
        description: 'Fï¿½gt eine Custom Exec-Approval Regel hinzu (allow/deny/confirm)',
        category: 'security',
        parameters: [
            { name: 'pattern', type: 'string', description: 'Regex-Pattern', required: true },
            { name: 'action', type: 'string', description: 'allow, deny, oder confirm', required: true },
            { name: 'risk', type: 'string', description: 'safe, low, medium, high, critical', required: true },
            { name: 'reason', type: 'string', description: 'Begrï¿½ndung', required: true },
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
            { name: 'limit', type: 'number', description: 'Anzahl Eintrï¿½ge (default: 20)', required: false },
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
        description: 'Prï¿½ft ob Nova-Updates verfï¿½gbar sind (git fetch + compare)',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { checkForUpdates } = await import('../infra/auto-update.js')
            return checkForUpdates()
        },
    },
    {
        name: 'pull_update',
        description: 'Zieht Nova-Updates und rebuilt (git pull + npm install + tsc). Rollback bei Fehler.',
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
            { name: 'limit', type: 'number', description: 'Anzahl Eintrï¿½ge', required: false },
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
            { name: 'output_path', type: 'string', description: 'Dateipfad fï¿½r Audio (default: temp)', required: false },
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
        description: 'Listet verfï¿½gbare TTS-Stimmen fï¿½r einen Provider',
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
        description: 'Rï¿½umt alte TTS-Temp-Dateien auf',
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
                cfg = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf-8'))
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
        name: 'mesh_scan',
        description: 'Scannt alle Nodes im Mesh â€” entdeckt Hardware, GPU, RAM, installierte Tools und Ollama-Modelle. Erstellt Empfehlungen was wo installiert werden sollte. Aufrufen wenn du wissen willst was im Netzwerk verfÃ¼gbar ist.',
        category: 'mesh',
        parameters: [
            { name: 'force', type: 'boolean', description: 'Erzwingt neuen Scan auch wenn Cache noch frisch ist', required: false },
        ],
        handler: async (params) => {
            const { getMeshBrain } = await import('../mesh/mesh-brain.js')
            const brain = getMeshBrain()
            const config = JSON.parse(require('fs').readFileSync(require('path').join(process.cwd(), 'nova.config.json'), 'utf-8'))
            const nodes = (config.nodes || []).filter((n: any) => n.enabled !== false)
            if (!params.force) {
                const cached = brain.load()
                if (cached) return cached.summary
            }
            const snap = await brain.scan(nodes)
            return snap.summary
        },
    },
    {
        name: 'mesh_recommendations',
        description: 'Zeigt Installationsempfehlungen fÃ¼r alle Mesh-Nodes â€” was sollte wo installiert werden und warum.',
        category: 'mesh',
        parameters: [],
        handler: async () => {
            const { getMeshBrain } = await import('../mesh/mesh-brain.js')
            const brain = getMeshBrain()
            const snap = brain.load()
            if (!snap) return 'Kein Mesh-Scan vorhanden. Bitte zuerst mesh_scan ausfÃ¼hren.'
            const recs = brain.getAllRecommendations()
            if (recs.length === 0) return 'Keine Empfehlungen â€” alles optimal konfiguriert!'
            return recs.map(({ node, rec }) =>
                `[${rec.priority.toUpperCase()}] ${node}: ${rec.tool} â€” ${rec.reason}${rec.installCmd ? `\n  â†’ ${rec.installCmd}` : ''}`
            ).join('\n\n')
        },
    },
    {
        name: 'mesh_route',
        description: 'Zeigt welcher Node am besten fÃ¼r einen bestimmten Task geeignet ist.',
        category: 'mesh',
        parameters: [
            { name: 'task', type: 'string', description: 'Task-Typ: large-llm, fast-llm, embedding, image-generation, stt-voice, media-convert, cuda-inference', required: true },
        ],
        handler: async (params) => {
            const { getMeshBrain } = await import('../mesh/mesh-brain.js')
            const brain = getMeshBrain()
            const snap = brain.load()
            if (!snap) return 'Kein Mesh-Scan. Bitte mesh_scan ausfÃ¼hren.'
            const route = brain.getBestNodeFor(params.task as string)
            if (!route) return `Kein Node gefunden fÃ¼r Task: ${params.task}`
            const lines = [
                `Task: ${route.task}`,
                `â†’ Bester Node: ${route.bestNode}`,
                `   Grund: ${route.reason}`,
            ]
            if (route.fallback) lines.push(`   Fallback: ${route.fallback} (wenn ${route.bestNode} nicht verfÃ¼gbar)`)
            else lines.push(`   Fallback: keiner verfÃ¼gbar`)
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
        description: 'Fï¿½hrt vollstï¿½ndigen Security-Audit durch: Secrets, gefï¿½hrlicher Code, Config, Permissions. Score 0-100.',
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
        description: 'Erstellt einen Event-Hook (webhook, email, script) der bei Events ausgelï¿½st wird',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Hooks', required: true },
            { name: 'event', type: 'string', description: 'Event: message.received, tool.executed, evolution.completed, error.critical, startup, shutdown', required: true },
            { name: 'type', type: 'string', description: 'webhook, email, oder script', required: true },
            { name: 'target', type: 'string', description: 'URL/Email/Script-Pfad', required: true },
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
        description: 'Lï¿½scht einen Event-Hook',
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
        description: 'Zeigt Hook-Ausfï¿½hrungs-Verlauf',
        category: 'system',
        parameters: [
            { name: 'limit', type: 'number', description: 'Anzahl Eintrï¿½ge', required: false },
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
        description: 'Liest eine Datei und gibt Base64-Inhalt + MIME zurï¿½ck',
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
            { name: 'original', type: 'string', description: 'UrsprÃ¼ngliche Antwort', required: true },
            { name: 'corrected', type: 'string', description: 'Korrigierte Antwort', required: true },
            { name: 'context', type: 'string', description: 'Kontext der Anfrage', required: false },
        ],
        handler: async (params) => {
            const { getCorrectionLearner } = await import('../layers/L7-learning.js')
            const learner = getCorrectionLearner()
            const correction = learner.recordCorrection({
                userId: 'system',
                originalResponse: params.original as string,
                correctedResponse: params.corrected as string,
                context: params.context as string || '',
            })
            return { success: true, correctionId: correction.id }
        },
    },
    {
        name: 'learn_workflow_skill',
        description: 'Erstellt aus validierten Beispielen ein internes L7-Workflow-Muster. Erzeugt keinen ausführbaren Code.',
        category: 'learning',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Skills', required: true },
            { name: 'description', type: 'string', description: 'Beschreibung', required: true },
            { name: 'examples', type: 'string', description: 'Beispiel-Anfragen (kommasepariert)', required: true },
            { name: 'solution', type: 'string', description: 'LÃ¶sungs-Template', required: true },
        ],
        handler: async (params) => {
            const { getSkillSynthesizer } = await import('../layers/L7-learning.js')
            const synthesizer = getSkillSynthesizer()
            const skill = synthesizer.synthesizeFromPattern({
                name: params.name as string,
                description: params.description as string,
                exampleQueries: (params.examples as string).split(',').map(s => s.trim()),
                solutionTemplate: params.solution as string,
            })
            return { success: true, skillId: skill.id, name: skill.name }
        },
    },
]

// ============================================
// Self-Extension Tools
// ============================================

export const extensionTools: NovaTool[] = [
    {
        name: 'create_tool',
        description: 'Legt einen reviewbaren Nova-Studio-Forge-Vorschlag an. Das Tool wird nicht direkt registriert oder ausgeführt.',
        category: 'other',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Tools', required: true },
            { name: 'description', type: 'string', description: 'Beschreibung', required: true },
            { name: 'code', type: 'string', description: 'JavaScript-Code (hat Zugriff auf params, fetch, console, JSON)', required: true },
        ],
        handler: async (params) => {
            const { createSkillProposal } = await import('./skill-builder.js')
            try {
                const proposal = createSkillProposal({
                    ownerId: 'nova-self',
                    name: String(params.name || ''),
                    description: String(params.description || ''),
                    why: 'Neue Runtime-Fähigkeit angefordert',
                    code: String(params.code || ''),
                })
                return { success: true, proposalId: proposal.id, status: proposal.status, message: `Forge-Vorschlag "${proposal.name}" gespeichert; nicht aktiv.` }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
            }
        },
    },
    {
        name: 'list_custom_tools',
        description: 'Listet alle selbst erstellten Tools auf',
        category: 'other',
        parameters: [],
        handler: async () => {
            const { loadCustomTools } = await import('./self-extension.js')
            const tools = loadCustomTools()
            return {
                count: tools.length,
                tools: tools.map(t => ({ name: t.name, description: t.description })),
            }
        },
    },
]

// ============================================
// Bot Management Tools
// ============================================

export const botTools: NovaTool[] = [
    {
        name: 'spawn_bot',
        description: 'Startet einen neuen Bot mit eigener Persona',
        category: 'bot',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Bots', required: true },
            { name: 'persona', type: 'string', description: 'Persona/System-Prompt', required: false },
            { name: 'channel', type: 'string', description: 'Kanal (telegram/discord/whatsapp)', required: false },
        ],
        handler: async (params) => {
            const { getMultiBotManager, BOT_TEMPLATES } = await import('../layers/multi-bot.js')
            const manager = getMultiBotManager()

            const config = manager.createBot({
                name: params.name as string,
                persona: params.persona as string || BOT_TEMPLATES.assistant.persona,
                channel: (params.channel as 'telegram' | 'discord' | 'whatsapp') || 'telegram',
                channelConfig: {},
                enabled: true,
                createdBy: 'nova',
            })

            await manager.startBot(config.id)
            return { success: true, botId: config.id, name: config.name }
        },
    },
    {
        name: 'list_bots',
        description: 'Listet alle Bots auf',
        category: 'bot',
        parameters: [],
        handler: async () => {
            const { getMultiBotManager } = await import('../layers/multi-bot.js')
            const manager = getMultiBotManager()
            const bots = manager.getAllBots()
            return {
                count: bots.length,
                bots: bots.map(b => ({
                    id: b.config.id,
                    name: b.config.name,
                    status: b.status,
                    channel: b.config.channel,
                })),
            }
        },
    },
    {
        name: 'kill_bot',
        description: 'Stoppt einen Bot',
        category: 'bot',
        parameters: [
            { name: 'name', type: 'string', description: 'Name des Bots', required: true },
        ],
        handler: async (params) => {
            const { getMultiBotManager } = await import('../layers/multi-bot.js')
            const manager = getMultiBotManager()
            const bot = manager.getBotByName(params.name as string)
            if (!bot) return { error: 'Bot nicht gefunden' }

            await manager.stopBot(bot.config.id)
            return { success: true, stopped: bot.config.name }
        },
    },
]

// ============================================
// Media Provider Tools (Wave 1)
// ============================================

export const mediaProviderTools: NovaTool[] = [
    {
        name: 'analyze_image',
        description: 'Analysiert ein Bild mit KI Vision (Nova-LLM/OpenAI/Anthropic). Auto-wÃ¤hlt verfÃ¼gbaren Provider â€” funktioniert ohne API Keys Ã¼ber Nova-LLM.',
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
        description: 'Transkribiert eine Audio-Datei (Whisper/Nova-LLM/Deepgram). Auto-wÃ¤hlt verfÃ¼gbaren Provider.',
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
        description: 'Generiert ein Bild mit KI (DALL-E 3 / OpenAI Image). Gibt den Dateipfad des generierten Bildes zurÃ¼ck. UnterstÃ¼tzt verschiedene SeitenverhÃ¤ltnisse.',
        category: 'media',
        parameters: [
            { name: 'prompt', type: 'string', description: 'Beschreibung des zu generierenden Bildes (Englisch empfohlen)', required: true },
            { name: 'aspect_ratio', type: 'string', description: 'Seitenverhï¿½ltnis: 1:1, 16:9, 9:16, 4:3, 3:4', required: false },
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
            { name: 'as_document', type: 'boolean', description: 'Erzwinge Versand als Dokument (auch fï¿½r Bilder)', required: false },
        ],
        handler: async (params) => {
            const { executeSendFile } = await import('./send-file-tool.js')
            return await executeSendFile(params)
        },
    },
    {
        name: 'list_media_providers',
        description: 'Zeigt alle verfï¿½gbaren Media-Provider und ihre Capabilities.',
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
        description: 'Parsed Markdown zu IR (Intermediate Representation). Extrahiert Frontmatter, Headings, Code-Blï¿½cke.',
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
        description: 'Setzt ein Model-Override fï¿½r eine Session.',
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
        description: 'Fï¿½gt eine neue Route hinzu (Channel + Pattern ? Agent/Model).',
        category: 'system',
        parameters: [
            { name: 'channel', type: 'string', description: 'Channel (telegram, whatsapp, discord, *)', required: true },
            { name: 'pattern', type: 'string', description: 'Regex-Muster fï¿½r Nachrichten', required: false },
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
        description: 'Lï¿½dt ein Plugin aus einem Verzeichnis.',
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
        description: 'Setzt eine Tool-Policy (allow/deny/confirm) fï¿½r ein Tool-Pattern.',
        category: 'security',
        parameters: [
            { name: 'pattern', type: 'string', description: 'Tool-Name oder Pattern (* fï¿½r alle)', required: true },
            { name: 'action', type: 'string', description: 'allow, deny, oder confirm', required: true },
            { name: 'reason', type: 'string', description: 'Begrï¿½ndung', required: false },
        ],
        handler: async (params) => {
            const { addToolPolicy } = await import('../agents/agent-patterns.js')
            addToolPolicy({ pattern: params.pattern as string, action: params.action as 'allow' | 'deny' | 'confirm', reason: params.reason as string })
            return { success: true }
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
        description: 'Lï¿½dt Skills aus einem Verzeichnis.',
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
import { skillSynthesisTool, listSkillsTool, deleteSkillTool } from './skill-synthesis.js'
import { buildSkillTool } from './skill-builder.js'
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
        description: 'Fï¿½hrt Python-Code direkt aus. Nutze dies IMMER wenn du Python-Skripte schreibst ï¿½ statt sie nur in den Chat zu schreiben. Unterstï¿½tzt inline Code, .py Dateien, und optionale pip-Installationen.',
        category: 'system',
        parameters: [
            { name: 'code', type: 'string', description: 'Python-Code als String (inline)', required: false },
            { name: 'file', type: 'string', description: 'Pfad zu einer .py Datei', required: false },
            { name: 'install', type: 'string', description: 'Komma-getrennte pip-Pakete die vorher installiert werden sollen (z.B. "python-docx,requests")', required: false },
        ],
        handler: async (params) => {
            const { executeExecutePython } = await import('./execute-python-tool.js')
            return await executeExecutePython(params)
        },
    },
    {
        name: 'create_runtime_tool',
        description: 'Kompatibilitätsname für einen Nova-Studio-Forge-Vorschlag. Keine direkte Laufzeitregistrierung und keine automatische Dependency-Installation.',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Tool-Name (snake_case, z.B. send_email)', required: true },
            { name: 'description', type: 'string', description: 'Was macht das Tool? (fï¿½r LLM-Auswahl)', required: true },
            { name: 'code', type: 'string', description: 'JavaScript-Code. Nutze params.xyz fï¿½r Parameter. Kein import/require/fs/child_process erlaubt. fetch() ist verfï¿½gbar.', required: true },
            { name: 'test_input', type: 'string', description: 'Optional: JSON-Objekt zum Testen (z.B. {"query": "test"})', required: false },
        ],
        handler: async (params) => {
            const { createSkillProposal } = await import('./skill-builder.js')
            const name = String(params.name || '').toLowerCase().replace(/\s+/g, '_')
            const description = String(params.description || '')
            const code = String(params.code || '')

            if (!name || !description || !code) return '? name, description und code sind erforderlich.'

            try {
                const proposal = createSkillProposal({ ownerId: 'nova-self', name, description, why: 'Runtime-Capability-Gap', code })
                return `🧪 Forge-Vorschlag **${proposal.name}** gespeichert (${proposal.id}). Test-Input wurde nicht ausgeführt; echte Sandbox-Evidence ist Pflicht.`
            } catch (error) {
                return `❌ Forge-Vorschlag abgelehnt: ${error instanceof Error ? error.message : String(error)}`
            }
        },
    },
    {
        name: 'list_custom_tools',
        description: 'Zeigt alle Tools die Nova selbst erstellt hat (aus .nova-tools/).',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { loadCustomTools } = await import('./self-extension.js')
            const tools = loadCustomTools()
            if (tools.length === 0) return { count: 0, message: 'Keine selbst erstellten Tools vorhanden.', tools: [] }
            return {
                count: tools.length,
                tools: tools.map(t => ({ name: t.name, description: t.description, createdAt: new Date(t.createdAt).toLocaleString('de-DE'), createdBy: t.createdBy })),
            }
        },
    },
    {
        name: 'evolve_self',
        description: 'Modifiziert Novas eigenen TypeScript-Quellcode sicher: erstellt Git-Branch ? ï¿½ndert Code ? kompiliert ? merged bei Erfolg, rollt zurï¿½ck bei Fehler. Nur fï¿½r src/tools/ und src/layers/ erlaubt.',
        category: 'system',
        parameters: [
            { name: 'file', type: 'string', description: 'Relativer Pfad zur TS-Datei (z.B. src/tools/reminder-tool.ts)', required: true },
            { name: 'description', type: 'string', description: 'Kurzbeschreibung der ï¿½nderung', required: true },
            { name: 'search', type: 'string', description: 'Exakter Text der ersetzt werden soll', required: true },
            { name: 'replace', type: 'string', description: 'Neuer Text (Ersatz)', required: true },
            { name: 'reason', type: 'string', description: 'Warum diese ï¿½nderung?', required: false },
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
        description: 'Zeigt Novas eigene Performance-Statistiken aus den letzten 7 Tagen: welche Tools am langsamsten/fehleranfÃ¤lligsten sind, welches Modell am besten performt, Latenz-Durchschnitte, Self-Healing Retries. Nutze dies zur Selbstoptimierung oder wenn du wissen willst wie du performst.',
        category: 'system',
        parameters: [
            { name: 'refresh', type: 'boolean', description: 'true = Analyse neu berechnen (dauert ~1s), false = gecachte Insights laden (Standard)', required: false },
        ],
        handler: async (params) => {
            const insights = params.refresh ? runTraceAnalysis() : (loadTraceInsights() ?? runTraceAnalysis())
            if (insights.tracesAnalyzed === 0) return 'ðŸ“Š Noch keine Trace-Daten vorhanden. Nach ein paar Unterhaltungen verfÃ¼gbar.'

            const lines = [
                `ðŸ“Š **Nova Trace-Analyse** (${insights.tracesAnalyzed} Requests, letzte ${insights.periodDays} Tage)`,
                '',
                `**Gesamt-Latenz:** âˆ… ${(insights.overall.avgTotalLatencyMs / 1000).toFixed(1)}s | LLM: ${(insights.overall.avgLlmLatencyMs / 1000).toFixed(1)}s | Tools: ${(insights.overall.avgToolLatencyMs / 1000).toFixed(1)}s`,
                `**Erfolgsrate:** ${(insights.overall.successRate * 100).toFixed(0)}% | Self-Healing Retries: âˆ… ${insights.overall.avgSelfHealingRetries.toFixed(2)}/Request`,
                `**Tool-Calls/Request:** âˆ… ${insights.overall.avgToolCallsPerRequest}`,
            ]

            if (insights.models.length > 0) {
                lines.push('\n**Modelle:**')
                for (const m of insights.models.slice(0, 3)) {
                    lines.push(`  â€¢ ${m.modelId} (${m.provider}): ${m.callCount} Calls, ${(m.successRate * 100).toFixed(0)}% Erfolg, âˆ… ${(m.avgLlmLatencyMs / 1000).toFixed(1)}s`)
                }
            }

            if (insights.tools.length > 0) {
                lines.push('\n**Top Tools:**')
                for (const t of insights.tools.slice(0, 5)) {
                    const errPct = (t.errorRate * 100).toFixed(0)
                    lines.push(`  â€¢ ${t.name}: ${t.callCount}x, âˆ… ${t.avgLatencyMs}ms, ${errPct}% Fehler`)
                }
            }

            if (insights.slowestTools.length > 0) lines.push(`\nâ± **Langsamste Tools:** ${insights.slowestTools.join(', ')}`)
            if (insights.mostFailingTools.length > 0) lines.push(`âŒ **FehleranfÃ¤lligste Tools:** ${insights.mostFailingTools.join(', ')}`)
            if (insights.cacheCandidates.length > 0) lines.push(`ðŸ’¾ **Cache-Kandidaten:** ${insights.cacheCandidates.join(', ')}`)

            if (insights.recommendations.length > 0) {
                lines.push('\n**Empfehlungen:**')
                for (const r of insights.recommendations) lines.push(`  â†’ ${r}`)
            }

            return lines.join('\n')
        },
    },
    {
        name: 'nova_introspect',
        description: 'Zeigt Novas eigenen internen Zustand: Ziele, gelernte Regeln, Skills, Performance-Metriken, Erinnerungen und System-Prompt. Nutze dies wenn du verstehen willst wer du bist, was du weiÃŸt, wie du performst oder was deine aktuellen Ziele sind.',
        category: 'system',
        parameters: [
            {
                name: 'type',
                type: 'string',
                description: 'Was soll inspiziert werden? state=Laufzustand, goals=Ziele, skills=Skills+Regeln, performance=Metriken, memories=Erinnerungen, prompt=SystemPrompt, tools=Tool-Inventar, full=Alles (Standard)',
                required: false,
            },
            {
                name: 'search',
                type: 'string',
                description: 'Suchbegriff â€” nur relevant wenn type=tools (z.B. "search", "browser", "memory")',
                required: false,
            },
        ],
        handler: async (params) => {
            return await selfIntrospect(
                (params.type || 'full') as import('./self-introspect.js').IntrospectType,
                params.search as string | undefined,
            )
        },
    },
    {
        name: 'nova_capabilities',
        description: 'Nova fragt ihr eigenes Tool-Inventar ab. Zeigt alle Tools die fÃ¼r ein bestimmtes Thema verfÃ¼gbar sind â€” mit Name, Beschreibung und Kategorie. Nutze das wenn du nicht sicher bist welches Tool du fÃ¼r eine Aufgabe verwenden sollst.',
        category: 'system',
        parameters: [
            {
                name: 'topic',
                type: 'string',
                description: 'Suchbegriff fÃ¼r das Tool-Inventar (z.B. "search", "browser", "file", "ssh", "memory", "agent"). Leer = alle Tools gruppiert nach Kategorie.',
                required: false,
            },
        ],
        handler: async (params) => {
            return await selfIntrospect('tools', params.topic as string | undefined)
        },
    },
]

// ============================================
// Mission Tools (LLM can start/manage missions)
// ============================================

export const missionTools: NovaTool[] = [
    {
        name: 'start_mission',
        description: 'Startet eine autonome Mission. NUTZE DAS wenn du eine komplexe Aufgabe autonom erledigen willst, die mehrere Schritte braucht. Schreibe NICHT nur "Mission gestartet" ï¿½ rufe dieses Tool auf!',
        category: 'system',
        parameters: [
            { name: 'goal', type: 'string', description: 'Das Ziel der Mission ï¿½ was genau soll erreicht werden?', required: true },
        ],
        async handler(params) {
            const { startMission } = await import('../core/autonomous-executor.js')
            const goal = String(params.goal)
            if (!goal || goal.length < 5) return '? Bitte ein konkretes Ziel angeben (min. 5 Zeichen).'
            const mission = await startMission(goal, 'nova-self', 'internal')
            return `?? Mission registriert! ${mission.steps.length} Schritte geplant.\n\nZiel: ${goal.slice(0, 150)}\nSteps: ${mission.steps.map((s: any) => s.description).join(', ')}`
        },
    },
    {
        name: 'mission_status',
        description: 'Zeigt den aktuellen Status der laufenden Mission. Nutze das BEVOR du sagst ob eine Mission lï¿½uft oder nicht.',
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
        description: 'Zeigt oder ï¿½ndert die Mission-Konfiguration (max Continuations, Timeout, Steps, etc.)',
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
            if (isNaN(val) || val < 0) return '? Wert muss eine positive Zahl sein.'
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
        description: 'Listet alle verfï¿½gbaren (online, nicht-busy) Nodes im Mesh auf ï¿½ schnelle ï¿½bersicht fï¿½r Task-Delegation.',
        category: 'system',
        parameters: [],
        handler: async () => {
            const { getAvailableNodes } = await import('../mesh/mesh-registry.js')
            const nodes = await getAvailableNodes()
            if (nodes.length === 0) return 'Keine verfï¿½gbaren Nodes im Mesh. Nur ich bin aktiv.'
            return nodes.map(n => `?? ${n.hostname} (${n.node_id}) ï¿½ ${n.capabilities?.join(', ')}`).join('\n')
        },
    },
    {
        name: 'mesh_delegate',
        description: 'Delegiert eine Aufgabe an einen anderen Nova-Node im Mesh. Der Node bekommt die Aufgabe und arbeitet sie ab.',
        category: 'system',
        parameters: [
            { name: 'node_id', type: 'string', description: 'ID des Ziel-Nodes (z.B. nova-a1b2c3d4)', required: true },
            { name: 'task', type: 'string', description: 'Die Aufgabe die der Node erledigen soll', required: true },
        ],
        handler: async (params) => {
            const { delegateTask } = await import('../mesh/mesh-registry.js')
            const result = await delegateTask(String(params.node_id), String(params.task))
            if (!result) return '? Delegation fehlgeschlagen. Node nicht erreichbar.'
            return `Task delegiert!\nID: ${result.id}\nAn: ${result.to_node}\nStatus: ${result.status}\nTransport: ${result.transport || 'legacy'}`
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
            const config = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf8'))
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
    description: 'LÃ¤dt eine Datei von einem Remote-Mesh-Node (Jetson, Pi, Server) via SSH herunter und speichert sie lokal. Nutze das um Dateien von anderen GerÃ¤ten zu holen bevor du sie mit send_file weiterschickst.',
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
                `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${user}@${host} "base64 '${remotePath}'"`,
                { encoding: 'utf-8', timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }
            )
            const buffer = Buffer.from(b64output.trim(), 'base64')
            writeFileSync(localPath, buffer)
            console.log(`[MeshDownload] âœ… ${remotePath} â†’ ${localPath} (${buffer.length} bytes)`)
            return { success: true, local_path: localPath, size: buffer.length, source: `${user}@${host}:${remotePath}` }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`[MeshDownload] âŒ ${msg}`)
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
            { name: 'section', type: 'string', description: 'Fuer navigate: chat, bots, nodes, modules, security, trust, memory oder settings', required: false },
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
    ...extensionTools,
    ...botTools,
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
    ...printerTools,
    ...minimaxTools,
    apiKeyTool,
    saveConfigTool,
    braveSearchTool,
    tavilySearchTool,
    searxngSearchTool,
    reminderTool,
    listRemindersTool,
    skillSynthesisTool,
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
            { name: 'to', type: 'string', description: 'EmpfÃ¤nger: konfigurierter Alias oder direkte Chat-ID/Nummer', required: true },
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
                    const cfgPath = join(process.cwd(), 'nova.config.json')
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
                const sent = (tg as any).bot?.sendMessage
                    ? await (tg as any).bot.sendMessage(resolvedId, String(params.message))
                    : await tg.send({ to: resolvedId, content: String(params.message), channel: 'telegram' })
                return {
                    success: true, sentTo: resolvedId,
                    messageId: Number((sent as any)?.message_id || 0) || undefined,
                    message: `âœ… Nachricht an ${params.to} (${resolvedId}) gesendet`,
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
        description: 'Spawnt einen fokussierten Subagenten fÃ¼r eine Teilaufgabe. Ideal fÃ¼r parallele Arbeit oder isolierte Recherchen. Der Subagent bekommt nur die erlaubten Tools und lÃ¤uft mit eigenem Timeout.',
        category: 'system',
        parameters: [
            { name: 'task', type: 'string', description: 'Was soll der Subagent tun? Klare, fokussierte Aufgabenbeschreibung.', required: true },
            { name: 'tools', type: 'string', description: 'Kommagetrennte Tool-Namen (optional). Standard: alle sicheren Tools.', required: false },
            { name: 'timeout_seconds', type: 'number', description: 'Timeout in Sekunden (Standard: 60)', required: false },
            { name: 'mesh_node', type: 'string', description: 'Optional: Name des Mesh-Nodes (z.B. "MacMini") fÃ¼r Remote-Delegation', required: false },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { spawnSubagent } = await import('../agents/subagent-orchestrator.js')
                const tools = params.tools ? String(params.tools).split(',').map(t => t.trim()) : undefined
                const result = await spawnSubagent({
                    task: String(params.task),
                    tools,
                    timeoutMs: (Number(params.timeout_seconds) || 60) * 1000,
                    meshNode: params.mesh_node ? String(params.mesh_node) : undefined,
                })
                if (result.status === 'completed') {
                    return `âœ… Subagent ${result.id} fertig (${result.durationMs}ms):\n${result.output}`
                } else {
                    return `âš ï¸ Subagent ${result.id}: ${result.status}${result.error ? ' â€” ' + result.error : ''}`
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
        description: 'Spawnt MEHRERE Subagenten gleichzeitig (echt parallel) und wartet auf alle Ergebnisse. Perfekt fÃ¼r parallele Recherchen, Multi-Node-Analysen oder unabhÃ¤ngige Teilaufgaben.',
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
                if (!tasks.length) return 'Keine Tasks Ã¼bergeben.'
                return await spawnSubagentsParallel(tasks)
            } catch (err) {
                return `Parallel-Spawn-Fehler: ${err}`
            }
        },
    },

    // Knowledge Graph Tools (LLM-unabhÃ¤ngige Faktensuche)
    {
        name: 'kg_search',
        description: 'Durchsucht den Knowledge Graph per Keyword â€” kein LLM nÃ¶tig. Findet Fakten, Beziehungen und Eigenschaften von EntitÃ¤ten.',
        category: 'memory',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchbegriff oder Frage', required: true },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { searchGraph } = await import('../memory/knowledge-graph.js')
                const result = searchGraph(String(params.query))
                return result || 'Keine Treffer im Knowledge Graph.'
            } catch (err) {
                return `KG-Suche Fehler: ${err}`
            }
        },
    },
    {
        name: 'kg_remember',
        description: 'Speichert eine Tatsache direkt im Knowledge Graph. Z.B. "Sample nutzt tmux" â†’ kg_remember("Sample", "uses", "tmux")',
        category: 'memory',
        parameters: [
            { name: 'subject', type: 'string', description: 'EntitÃ¤t (z.B. "Sample", "Nova", "MacMini")', required: true },
            { name: 'relation', type: 'string', description: 'Beziehung (z.B. "uses", "prefers", "owns")', required: true },
            { name: 'object', type: 'string', description: 'Wert oder Ziel-EntitÃ¤t', required: true },
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
            { name: 'models', type: 'string', description: 'Kommagetrennte Modell-IDs (optional â€” werden sonst auto-entdeckt)', required: false },
            { name: 'roles', type: 'string', description: 'Kommagetrennte Rollen: chat,code,vision,embedding (Standard: chat,code)', required: false },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const { registerExternalProvider } = await import('../core/model-resolver.js')
                const models = params.models ? String(params.models).split(',').map(m => m.trim()).filter(Boolean) : undefined
                const roles = params.roles ? String(params.roles).split(',').map(r => r.trim()) as any[] : ['chat', 'code']
                const result = await registerExternalProvider({
                    name: String(params.name),
                    apiKey: String(params.api_key),
                    baseUrl: String(params.base_url).replace(/\/$/, ''),
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
                        `- ${p.name}: ${p.enabled ? 'âœ…' : 'âŒ'} | ${p.models?.length || 0} Modelle | ${p.baseUrl}`
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
                return ok ? `âœ… Provider "${params.name}" entfernt.` : `Provider "${params.name}" nicht gefunden.`
            } catch (err) {
                return `Fehler: ${err}`
            }
        },
    },

    // Capability Router â€” Nova installs missing tools autonomously
    capabilityTool,
]

// ============================================
// ADA V2 / MARK XXXIX Inspired Tools
// ============================================
import { cadGenerateTool } from './cad-tool.js'
import { printerDiscoveryTool, printerStatusTool, printerSliceTool, printerPrintTool } from './printer-tool.js'
import { screenCaptureTool, webcamCaptureTool, faceDetectionTool, handGestureTool, screenAnalysisTool } from './vision-tool.js'
import { toolConfirmationTool } from './tool-confirmation.js'
import { desktopScreenshotTool } from './desktop-screenshot-tool.js'

// Append new tools to ALL_TOOLS via direct assignment (bypass type strictness)
ALL_TOOLS.push(
    cadGenerateTool as any,
    printerDiscoveryTool as any,
    printerStatusTool as any,
    printerSliceTool as any,
    printerPrintTool as any,
    desktopScreenshotTool as any,  // proper desktop capture: vision + auto-send
    screenCaptureTool as any,
    webcamCaptureTool as any,
    faceDetectionTool as any,
    handGestureTool as any,
    screenAnalysisTool as any,
    toolConfirmationTool as any,
)

// ============================================
// Tool Registry
// ============================================

export class NovaToolRegistry {
    private tools: Map<string, NovaTool> = new Map()

    constructor() {
        this.registerAll()
        this.loadCustomToolsFromDisk()
    }

    registerAll(): void {
        for (const tool of ALL_TOOLS) {
            this.tools.set(tool.name, tool)
        }

        // Register the Skill Pack loader (from tool-router) â€” async because ESM
        import('./tool-router.js').then(({ loadSkillPackTool }) => {
            if (loadSkillPackTool) {
                this.tools.set(loadSkillPackTool.name, loadSkillPackTool)
                console.log(`[Tools] âœ… load_skill_pack Tool registriert`)
            }
        }).catch(() => { /* tool-router not yet available */ })

        console.log(`[Tools] ${this.tools.size} Tools registriert`)
    }

    /**
     * Auto-load persisted custom tools from .nova-tools/ on startup.
     * Nova never forgets tools she built!
     */
    private async loadCustomToolsFromDisk(): Promise<void> {
        try {
            const { loadCustomTools, executeCustomTool } = await import('./self-extension.js')
            const customTools = loadCustomTools()

            for (const ct of customTools) {
                // Skip if already registered (built-in overrides custom)
                if (this.tools.has(ct.name)) continue

                this.tools.set(ct.name, {
                    name: ct.name,
                    description: ct.description,
                    category: 'other',
                    parameters: ct.parameters.map(p => ({
                        ...p,
                        type: p.type as 'string' | 'number' | 'boolean' | 'object',
                    })),
                    handler: async (p) => executeCustomTool(ct, p),
                })
            }

            if (customTools.length > 0) {
                console.log(`[Tools] ${customTools.length} Custom-Tools aus .nova-tools/ geladen`)
            }
        } catch (err) {
            // self-extension not available, skip
        }
    }

    register(tool: NovaTool): void {
        this.tools.set(tool.name, tool)
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

        // Execute tool and attempt L0 auto-repair if it fails
        let result = await tool.handler(params)
        result = await executionPipeline.postprocess(name, params, result, isSuccessfulToolResult(result))

        // Check if result indicates an error
        if (!isSuccessfulToolResult(result)) {
            // Track failure by TOOL NAME only ï¿½ not params!
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

            // Try L0 repair first
            try {
                const { getToolAutoRepairEngine } = await import('../layers/L0-tool-autorepair.js')
                const autoRepair = getToolAutoRepairEngine()
                const { result: repairedResult, wasRepaired, repairDetails } = await autoRepair.repairAndRetry(
                    name,
                    params,
                    result as any,
                    tool.handler
                )
                if (wasRepaired) {
                    console.log(`[L0 AutoRepair] ? Tool "${name}" auto-repaired: ${repairDetails}`)
                    this.failureCount.set(key, 0) // Reset on success

                    // Feed L15 (clear health flag on repair success)
                    try {
                        const { reportToolSuccess } = await import('../layers/L15-self-check.js')
                        reportToolSuccess(name)
                    } catch { /* L15 not available */ }

                    const postRepair = await executionPipeline.postprocess(name, params, repairedResult, isSuccessfulToolResult(repairedResult))
                    return executionPipeline.finalize(name, params, postRepair, isSuccessfulToolResult(postRepair))
                }
            } catch (repairErr) {
                console.log(`[L0 AutoRepair] ? Repair engine not available: ${repairErr}`)
            }

            // After 3 failures, trigger L8 Sub-Agent
            if (failures >= 3) {
                console.log(`[Registry?L8] ?? 3 failures reached, triggering sub-agent google search!`)
                try {
                    const { getSubAgentManager } = await import('../layers/L8-sub-agent.js')
                    const manager = getSubAgentManager()
                    const error = (result as any).error || 'Unknown error'

                    await manager.spawnSearchAgent(
                        {
                            problem: `${name} ${error}`,
                            tool: name,
                            params: params,
                        },
                        async (solution) => tool.handler(params),
                        async (msg) => console.log(`[L8 Report] ${msg}`)
                    )

                    // Return with L8 message
                    const escalated = {
                        ...(result as object),
                        l8_triggered: true,
                        l8_message: manager.getFallbackMessage()
                    }
                    return executionPipeline.finalize(name, params, escalated, false)
                } catch (l8Err) {
                    console.log(`[Registry] L8 not available: ${l8Err}`)
                }
            }
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
            console.log(`[ToolRegistry] âœ… ${ALL_TOOLS.length} built-in + ${extras.length} auto-scanned = ${_dynamicTools.length} total tools`)
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







