/**
 * Layer 8 - Sub-Agent Google Fallback
 * 
 * When Nova is stuck (too many failures), she:
 * 1. Says "Ich kann das gerade nicht - ein Agent sucht schon nach einer Lösung!"
 * 2. Spawns a background sub-agent that googles the problem
 * 3. Sub-agent tries solutions automatically
 * 4. Reports back when found
 */

import { EventEmitter } from 'node:events'

export const RUNTIME_STATUS = 'compatibility-only' as const
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// ============================================
// Types
// ============================================

export interface SubAgentTask {
    id: string
    query: string
    status: 'searching' | 'trying' | 'success' | 'failed'
    startedAt: number
    results: string[]
    solution?: string
}

// ============================================
// Sub-Agent Manager
// ============================================

class SubAgentManager extends EventEmitter {
    private activeTasks: Map<string, SubAgentTask> = new Map()
    private maxConcurrent: number = 2

    // ============================================
    // LEARNING CACHE - Remember solutions for errors
    // ============================================
    private learnedSolutions: Map<string, string> = new Map()
    private readonly SOLUTIONS_FILE = '.nova-data/learned-solutions.json'

    /**
     * Load learned solutions from disk
     */
    private loadLearnedSolutions(): void {
        try {
            if (existsSync(this.SOLUTIONS_FILE)) {
                const data = JSON.parse(readFileSync(this.SOLUTIONS_FILE, 'utf-8'))
                this.learnedSolutions = new Map(Object.entries(data))
                console.log(`[L8 Learning] Loaded ${this.learnedSolutions.size} learned solutions`)
            }
        } catch (err) {
            console.log(`[L8 Learning] Could not load solutions: ${err}`)
        }
    }

    /**
     * Save learned solutions to disk
     */
    private saveLearnedSolutions(): void {
        try {
            const dir = '.nova-data'
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            const data = Object.fromEntries(this.learnedSolutions)
            writeFileSync(this.SOLUTIONS_FILE, JSON.stringify(data, null, 2))
            console.log(`[L8 Learning] Saved ${this.learnedSolutions.size} solutions`)
        } catch (err) {
            console.log(`[L8 Learning] Could not save solutions: ${err}`)
        }
    }

    /**
     * Normalize error for matching (remove variable parts)
     */
    private normalizeError(error: string): string {
        return error
            .replace(/['"]/g, '')           // Remove quotes
            .replace(/\d+/g, 'N')            // Replace numbers
            .replace(/\s+/g, ' ')            // Normalize whitespace
            .slice(0, 100)                   // Limit length
            .toLowerCase()
            .trim()
    }

    /**
     * Learn a solution for an error
     */
    learnSolution(error: string, solution: string): void {
        const key = this.normalizeError(error)
        this.learnedSolutions.set(key, solution)
        console.log(`[L8 Learning] 📚 Learned solution for: "${key.slice(0, 50)}"`)
        this.saveLearnedSolutions()
    }

    /**
     * Get a known solution for an error (if we've seen it before)
     */
    getKnownSolution(error: string): string | null {
        const key = this.normalizeError(error)
        const solution = this.learnedSolutions.get(key)
        if (solution) {
            console.log(`[L8 Learning] 💡 Found known solution for: "${key.slice(0, 50)}"`)
        }
        return solution || null
    }

    // ============================================
    // SAFETY GUARDS - Prevent dangerous operations
    // ============================================

    private readonly DANGEROUS_COMMANDS = [
        // Delete operations
        'rm -rf', 'rm -r', 'rmdir /s', 'del /f', 'del /s',
        'Remove-Item -Recurse -Force', 'rd /s /q',
        // Format/Disk operations  
        'format', 'diskpart', 'fdisk', 'mkfs',
        // System modification
        'reg delete', 'regedit', 'sfc', 'dism',
        'chmod 777', 'chown root',
        // Network attacks
        'netsh', 'iptables -F',
        // Crypto/ransomware patterns
        'cipher /w', 'gpg --encrypt',
        // Download & execute patterns
        'curl | bash', 'wget | sh', 'iex(', 'Invoke-Expression',
        '-ExecutionPolicy Bypass', 'powershell -enc',
    ]

    private readonly PROTECTED_PATHS = [
        // Windows
        'C:\\Windows', 'C:\\Program Files', 'C:\\System32',
        '%SystemRoot%', '%WinDir%', '%ProgramFiles%',
        // Unix
        '/etc', '/bin', '/sbin', '/usr', '/boot', '/root', '/sys', '/proc',
        // User sensitive
        '.ssh', '.gnupg', 'credentials', 'secrets',
    ]

    // SELF-PROTECTION: Nova cannot modify her own security code!
    private readonly PROTECTED_SOURCE_FILES = [
        'L0-', 'L8-', // Layer 0 and 8 (security layers)
        'self-repair', 'autorepair', 'supervisor',
        'security', 'safety', 'guard',
        'daemon.ts', // Core runtime
        'config.ts', // Configuration
        // NOTE: soul.ts is NOT protected - Nova can evolve her personality
    ]

    private readonly ALLOWED_PACKAGE_MANAGERS = [
        'npm install', 'npm i', 'npm ci',
        'yarn add', 'yarn install',
        'pnpm install', 'pnpm add',
        'pip install', 'pip3 install', 'python -m pip', 'py -m pip',
        'cargo install',
        'go install',
        'gem install',
        'nuget install',
    ]

    /**
     * Check if a solution is safe to execute
     */
    isSolutionSafe(solution: string): { safe: boolean; reason?: string } {
        const lowerSolution = solution.toLowerCase()

        // Check for dangerous commands
        for (const dangerous of this.DANGEROUS_COMMANDS) {
            if (lowerSolution.includes(dangerous.toLowerCase())) {
                console.log(`[L8 Safety] ❌ BLOCKED dangerous command: ${dangerous}`)
                return { safe: false, reason: `Gefährlicher Befehl: ${dangerous}` }
            }
        }

        // Check for protected paths
        for (const path of this.PROTECTED_PATHS) {
            if (solution.includes(path) || lowerSolution.includes(path.toLowerCase())) {
                console.log(`[L8 Safety] ❌ BLOCKED protected path: ${path}`)
                return { safe: false, reason: `Geschützter Pfad: ${path}` }
            }
        }

        // If it's an install command, make sure it's from a known package manager
        if (lowerSolution.includes('install') || lowerSolution.includes('.exe') || lowerSolution.includes('.msi')) {
            const isKnownPM = this.ALLOWED_PACKAGE_MANAGERS.some(pm =>
                lowerSolution.includes(pm.toLowerCase())
            )
            if (!isKnownPM && (lowerSolution.includes('.exe') || lowerSolution.includes('.msi'))) {
                console.log(`[L8 Safety] ❌ BLOCKED unknown installer`)
                return { safe: false, reason: 'Unbekannter Installer - nur bekannte Package Manager erlaubt' }
            }
        }

        // SELF-PROTECTION: Block any attempt to modify security-critical source files
        const isWriteAttempt = lowerSolution.includes('write_file') ||
            lowerSolution.includes('echo') || lowerSolution.includes('cat >') ||
            lowerSolution.includes('sed -i') || lowerSolution.includes('modify') ||
            lowerSolution.includes('edit') || lowerSolution.includes('replace')

        if (isWriteAttempt) {
            for (const protectedFile of this.PROTECTED_SOURCE_FILES) {
                if (solution.includes(protectedFile) || lowerSolution.includes(protectedFile.toLowerCase())) {
                    console.log(`[L8 Safety] ⛔ BLOCKED self-modification attempt: ${protectedFile}`)
                    return { safe: false, reason: `Selbstschutz: Änderung an ${protectedFile} nicht erlaubt` }
                }
            }
        }

        console.log(`[L8 Safety] ✅ Solution passed safety check`)
        return { safe: true }
    }

    constructor() {
        super()
        this.loadLearnedSolutions()
        console.log('[L8 SubAgent] Manager initialized with safety guards')
    }

    /**
     * Check if we should trigger fallback (too many failures)
     */
    shouldTriggerFallback(failureCount: number, threshold: number = 3): boolean {
        return failureCount >= threshold
    }

    /**
     * Get Nova's response when triggering fallback
     */
    getFallbackMessage(): string {
        return `🔍 Das funktioniert gerade nicht wie erwartet. Ich schicke einen Agenten los, der nach einer Lösung sucht! Du bekommst Bescheid sobald er was findet.`
    }

    // ============================================
    // LLM CONSULTATION - Ask Nova's brain for ideas!
    // ============================================

    // ============================================
    // TOOL-AWARE SELF-DIAGNOSIS (Phase 5)
    // Before googling, run diagnostics specific to the failing tool
    // ============================================

    private readonly TOOL_DIAGNOSTICS: Record<string, { checks: string[]; hints: string[] }> = {
        ssh_command: {
            checks: [
                'where plink 2>nul || echo PLINK_NOT_FOUND',
                'where ssh 2>nul || echo SSH_NOT_FOUND',
                'ssh -V 2>&1',
            ],
            hints: [
                'Wenn plink fehlt: choco install putty oder SSH-Keys nutzen',
                'Wenn SSH vorhanden: Key-basiert verbinden statt Passwort',
            ],
        },
        run_command: {
            checks: [
                'echo %COMSPEC%',
                'powershell -Command "$PSVersionTable.PSVersion"',
            ],
            hints: [
                'Prüfe ob der Befehl im PATH ist',
                'Auf Windows cmd vs powershell Syntax achten',
            ],
        },
        web_search: {
            checks: [],
            hints: [
                'Prüfe ob API-Key gesetzt ist: /apikey',
                'Tavily oder Brave API funktioniert möglicherweise nicht',
            ],
        },
    }

    /**
     * Run tool-specific diagnostics before searching
     * Returns diagnostic results that enhance the LLM query
     * Now accepts params so it can run host-specific checks (e.g., ping the SSH target)
     */
    async runToolDiagnostics(toolName: string, params?: Record<string, unknown>): Promise<string[]> {
        const diagnostics = this.TOOL_DIAGNOSTICS[toolName]
        if (!diagnostics || diagnostics.checks.length === 0) {
            return diagnostics?.hints || []
        }

        const results: string[] = [...diagnostics.hints]

        try {
            const { execSync } = await import('node:child_process')
            const { platform } = await import('node:os')
            const isWindows = platform() === 'win32'

            // Run static checks (tool availability)
            for (const check of diagnostics.checks) {
                try {
                    const output = execSync(check, {
                        encoding: 'utf-8',
                        timeout: 5000,
                        shell: isWindows ? 'cmd.exe' : '/bin/sh',
                        windowsHide: true,
                    }).trim()

                    if (output) {
                        results.push(`[Diagnose] ${check}: ${output.slice(0, 100)}`)
                    }
                } catch (err: any) {
                    const errMsg = err.message || String(err)
                    if (errMsg.includes('NOT_FOUND') || errMsg.includes('not recognized')) {
                        results.push(`[Diagnose] ⚠️ ${check}: NICHT GEFUNDEN`)
                    }
                }
            }

            // === DYNAMIC HOST-SPECIFIC CHECKS ===
            // For SSH: actually ping the target host and test connectivity
            if (toolName === 'ssh_command' && params?.host) {
                const host = String(params.host)
                console.log(`[L8 Diagnose] 🏓 Pinging ${host}...`)

                // 1. Ping the host
                try {
                    const pingCmd = isWindows
                        ? `ping -n 1 -w 3000 ${host}`
                        : `ping -c 1 -W 3 ${host}`
                    const pingOut = execSync(pingCmd, {
                        encoding: 'utf-8',
                        timeout: 5000,
                        windowsHide: true,
                    }).trim()

                    if (pingOut.includes('TTL=') || pingOut.includes('ttl=') || pingOut.includes('bytes from')) {
                        results.push(`[Diagnose] ✅ Host ${host} erreichbar (Ping OK)`)
                    } else {
                        results.push(`[Diagnose] ❌ Host ${host} NICHT erreichbar (Ping failed)`)
                        results.push(`[Diagnose] 💡 Ist der Server eingeschaltet? Ist Tailscale/VPN aktiv?`)
                    }
                } catch {
                    results.push(`[Diagnose] ❌ Host ${host} NICHT erreichbar (Ping timeout)`)
                    results.push(`[Diagnose] 💡 Server möglicherweise aus, oder kein Netzwerk/VPN`)
                }

                // 2. Try SSH port check (TCP connect to port 22)
                try {
                    const portCmd = isWindows
                        ? `powershell -Command "(Test-NetConnection ${host} -Port 22 -WarningAction SilentlyContinue).TcpTestSucceeded"`
                        : `nc -z -w 3 ${host} 22 && echo true || echo false`
                    const portOut = execSync(portCmd, {
                        encoding: 'utf-8',
                        timeout: 8000,
                        windowsHide: true,
                    }).trim()

                    if (portOut.includes('True') || portOut.includes('true')) {
                        results.push(`[Diagnose] ✅ SSH Port 22 auf ${host} offen`)
                    } else {
                        results.push(`[Diagnose] ❌ SSH Port 22 auf ${host} GESCHLOSSEN`)
                        results.push(`[Diagnose] 💡 SSH-Dienst läuft nicht oder Firewall blockiert Port 22`)
                    }
                } catch {
                    results.push(`[Diagnose] ⚠️ Port-Check fehlgeschlagen (Port 22 wahrscheinlich blockiert)`)
                }
            }

            if (results.length > diagnostics.hints.length) {
                console.log(`[L8 Delegation] 🔬 Tool "${toolName}" diagnostics: ${results.length} findings`)
            }
        } catch {
            console.log(`[L8 Delegation] Could not run diagnostics for ${toolName}`)
        }

        return results
    }

    /**
     * Ask the LLM for solution ideas (parallel to Google)
     * Nova uses her own knowledge to suggest fixes
     */
    async askLLM(problem: string, context?: string): Promise<string[]> {
        const suggestions: string[] = []

        try {
            const { getNovaLLM } = await import('../llm/nova-llm-sdk.js')
            const llm = getNovaLLM()

            const prompt = `Du bist ein System-Administrator der einen Fehler lösen muss.
Fehler: ${problem}
${context ? `Kontext: ${context}` : ''}

Gib mir 3-5 KONKRETE Lösungsvorschläge als kurze Befehle oder Aktionen.
Antworte NUR mit den Lösungen, eine pro Zeile, ohne Nummerierung.
Beispiel-Format:
ssh -o StrictHostKeyChecking=no user@host
Erhöhe Timeout: timeout 60 command
Nutze alternative: scp statt pscp`

            console.log('[L8 SubAgent] 🧠 Asking LLM for solution ideas...')

            const response = await llm.complete([
                { role: 'system', content: 'Du bist ein erfahrener System-Administrator. Antworte nur mit konkreten Lösungen.' },
                { role: 'user', content: prompt }
            ])

            if (response.content) {
                // Parse LLM response into individual suggestions
                const lines = response.content.split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 5 && !l.startsWith('#') && !l.startsWith('//'))

                for (const line of lines.slice(0, 5)) {
                    suggestions.push(line)
                }

                console.log(`[L8 SubAgent] 🧠 LLM suggested ${suggestions.length} solutions`)
            }
        } catch (err) {
            console.log(`[L8 SubAgent] LLM consultation failed: ${err}`)
        }

        return suggestions
    }

    /**
     * Check if an error is googleable (can be solved by searching)
     * NOTE: More permissive now - tries to find solutions even for network errors
     */
    private isGoogleableError(problem: string): { googleable: boolean; localFixes?: string[]; autoRetryCommand?: string } {
        const networkErrors = /connection (refused|abort|reset|timeout)|ECONNREFUSED/i  // Removed ETIMEDOUT here
        const fileErrors = /file not found|ENOENT|no such file or directory/i
        const permissionErrors = /permission denied|access denied|EACCES/i
        const authErrors = /authentication failed|invalid credentials/i

        // === LOCAL PROCESS TIMEOUTS (spawnSync, execSync) ===
        // These are NOT googleable - the process itself timed out locally
        // Also catch plain ETIMEDOUT from Windows cmd.exe spawn
        const localSpawnTimeout = /spawnSync.*ETIMEDOUT|execSync.*ETIMEDOUT|spawn.*timeout|cmd\.exe.*ETIMEDOUT|ETIMEDOUT.*cmd\.exe|run_command.*ETIMEDOUT/i
        if (localSpawnTimeout.test(problem)) {
            console.log(`[L8 SubAgent] 🛑 Local spawn timeout detected - NOT googleable!`)
            return {
                googleable: false,
                localFixes: [
                    'Der lokale Prozess ist abgelaufen (Timeout)',
                    'Versuche einen kürzeren Befehl oder teile ihn auf',
                    'Prüfe ob ein anderer Prozess blockiert (z.B. offenes cmd-Fenster)',
                    'Erhöhe das Timeout in den Optionen',
                    'Starte Terminal/PowerShell neu',
                    'Nutze rsync/scp statt lokaler Befehle für große Dateien',
                ],
            }
        }

        // === SSH/Network ETIMEDOUT ===
        // NOW GOOGLEABLE: Nova should search for alternative SSH methods
        // (e.g., "windows ssh password without plink", "openssh password stdin")
        const sshTimeout = /ssh.*ETIMEDOUT|ETIMEDOUT.*ssh|connection timed out/i
        if (sshTimeout.test(problem)) {
            return {
                googleable: true,  // Let Nova search for solutions!
                localFixes: [
                    'Prüfe ob der Server erreichbar ist: ping HOST',
                    'Prüfe ob plink.exe installiert ist: where plink',
                    'Alternative: SSH-Key statt Passwort einrichten',
                    'Prüfe ob SSH-Port offen ist: Test-NetConnection HOST -Port 22',
                ],
            }
        }

        // === stdin/interactive prompt errors ===
        // IMPORTANT: Googleable = TRUE so Nova learns the solution herself!
        // She should search "unrar stdin batch prompt fix" and discover -o+ on her own
        const stdinErrors = /stdin|IOCTL|Read error.*file|\[Y\]es.*\[N\]o|\[A\]ll.*\[Q\]uit/i
        const archiveErrors = /Unexpected end of archive|corrupted|checksum error|archive is broken/i
        const bufferErrors = /ENOBUFS|buffer.*overflow|too much data/i

        // For stdin/interactive prompt errors - LET HER GOOGLE AND LEARN!
        if (stdinErrors.test(problem)) {
            return {
                googleable: true,  // Nova will search and learn the solution!
            }
        }

        // For corrupt/incomplete archive errors - still googleable
        if (archiveErrors.test(problem)) {
            return {
                googleable: true,  // Nova will find "check file size" or "re-upload" herself
            }
        }

        // For buffer overflow errors
        if (bufferErrors.test(problem)) {
            return {
                googleable: false,
                localFixes: [
                    'Zu viel Output - der Buffer ist voll',
                    'Leite Output in Datei um: command > output.txt 2>&1',
                    'Oder unterdrücke Output: command > /dev/null 2>&1',
                    'Warte kurz und versuche es erneut',
                ],
            }
        }

        // For network errors, suggest local fixes first
        if (networkErrors.test(problem)) {
            return {
                googleable: false,
                localFixes: [
                    'Prüfe ob der Zielrechner eingeschaltet und erreichbar ist (ping)',
                    'Prüfe ob der richtige Port verwendet wird',
                    'Prüfe ob Firewall den Zugang blockiert',
                    'Versuche es in ein paar Minuten nochmal',
                ]
            }
        }

        // For file errors, try to find or create the file
        if (fileErrors.test(problem)) {
            return {
                googleable: true, // Still google - might find how to install missing tool
                localFixes: [
                    'Prüfe ob der Pfad korrekt ist',
                    'Prüfe ob die Datei/das Tool installiert ist',
                ]
            }
        }

        // For permission errors
        if (permissionErrors.test(problem)) {
            return {
                googleable: true,
                localFixes: [
                    'Versuche mit Administrator-Rechten',
                    'Prüfe Datei-Berechtigungen',
                ]
            }
        }

        // For auth errors
        if (authErrors.test(problem)) {
            return {
                googleable: false,
                localFixes: [
                    'Prüfe Benutzername und Passwort',
                    'Prüfe ob SSH-Keys konfiguriert sind',
                ]
            }
        }

        return { googleable: true }
    }

    /**
     * Build a rich, detailed query from error context
     * Prioritizes the actual command over internal Nova errors
     */
    private buildRichQuery(context: {
        problem: string
        tool?: string
        params?: Record<string, unknown>
        errorChain?: string[]
        originalIntent?: string
    }): string | null {
        // Check if googleable
        const googleCheck = this.isGoogleableError(context.problem)
        if (!googleCheck.googleable) {
            console.log(`[L8 SubAgent] ⚠️ Environment issue: ${context.problem.slice(0, 50)}`)
            if (googleCheck.localFixes && googleCheck.localFixes.length > 0) {
                console.log(`[L8 SubAgent] 💡 Suggesting ${googleCheck.localFixes.length} local fixes`)
            }
            // STOP HERE - don't google local problems!
            return null
        }

        // === EXTRACT ACTUAL ERROR MESSAGE ===
        // Focus on the ACTUAL error, not the command that caused it
        // NEVER include passwords or credentials in search queries!
        const errorPatterns = [
            // Interactive prompt errors - HIGH PRIORITY (stdin issues)
            /Read error in.*stdin/i,
            /\[Y\]es.*\[N\]o.*\[A\]ll/i,
            /Unexpected end of archive/i,
            /IOCTL/i,
            /stdin.*error/i,
            /interactive.*mode/i,
            // SSH/SCP specific errors
            /Connection refused/i,
            /Connection (reset|closed|timeout)/i,
            /Access denied/i,
            /Permission denied/i,
            /Authentication failed/i,
            /password was not accepted/i,
            /Could not resolve hostname/i,
            /No route to host/i,
            /Host key verification failed/i,
            /FATAL ERROR:\s*(.+?)(?:\n|$)/i,
            // Network errors
            /ETIMEDOUT/i,
            /ENOBUFS/i,
            /ECONNREFUSED/i,
            /ECONNRESET/i,
            // File/command errors
            /'([^']+)' is not recognized/i,
            /command '([^']+)' not found/i,
            /Cannot find module/i,
            /No such file or directory/i,
            // Generic errors
            /Error:\s*(.+?)(?:\n|$)/i,
        ]

        let extractedError = ''
        for (const pattern of errorPatterns) {
            const match = context.problem.match(pattern)
            if (match) {
                // Prefer full match for simple errors, group for complex ones
                extractedError = match[1] || match[0]
                // Clean up the extracted error
                extractedError = extractedError
                    .replace(/["']/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 80)
                console.log(`[L8 SubAgent] Extracted error: "${extractedError}" from pattern`)
                break
            }
        }

        // If no pattern matched, look for error-like lines (NOT commands)
        if (!extractedError) {
            const lines = context.problem.split('\n').filter(l => l.trim())
            for (const line of lines) {
                // Skip lines that contain credentials or are commands
                if (line.includes('Command failed:') ||
                    line.includes('-pw ') || line.includes('-p ') ||
                    line.includes('password') || line.includes('Password') ||
                    line.includes('ssh ') || line.includes('scp ') ||
                    line.includes('plink ') || line.includes('pscp ') ||
                    line.includes('sshpass') ||
                    line.match(/^[A-Z]:\\/) || line.match(/^\//)) {
                    continue
                }
                // Found a meaningful error line
                if (line.toLowerCase().includes('error') ||
                    line.toLowerCase().includes('denied') ||
                    line.toLowerCase().includes('refused') ||
                    line.toLowerCase().includes('failed') ||
                    line.toLowerCase().includes('stdin') ||
                    line.toLowerCase().includes('ioctl') ||
                    line.toLowerCase().includes('timeout')) {
                    extractedError = line.slice(0, 80)
                    console.log(`[L8 SubAgent] Using line as error: "${extractedError}"`)
                    break
                }
            }
        }

        // Build the search query from the ACTUAL error
        if (!extractedError) {
            console.log(`[L8 SubAgent] ⚠️ Could not extract error from: ${context.problem.slice(0, 100)}`)
            return null
        }

        // === SANITIZE: Remove ANY sensitive data ===
        const sanitizedError = extractedError
            .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '')  // Remove IPs
            .replace(/[A-Z]:\\[^\s]*/gi, '')                      // Remove Windows paths
            .replace(/\/[^\s]*\/[^\s]*/g, '')                     // Remove Unix paths
            .replace(/-pw\s+["']?[^\s"']+["']?/gi, '')            // Remove -pw password
            .replace(/-p\s+["']?[^\s"']+["']?/gi, '')             // Remove -p password
            .replace(/password[=:]\s*["']?[^\s"']+["']?/gi, '')   // Remove password=xxx
            .replace(/[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+/g, '')      // Remove emails/user@host
            .replace(/\s+/g, ' ')
            .trim()

        const query = `${sanitizedError} Windows fix solution`
        console.log(`[L8 SubAgent] Search query: ${query.slice(0, 100)}`)
        return query
    }

    /**
     * Spawn a sub-agent to google and try solutions
     * Supports both old (problem, params, tryFn, reportFn) and new (context, tryFn, reportFn) signatures
     */
    async spawnSearchAgent(
        contextOrProblem: string | {
            problem: string
            tool?: string
            params?: Record<string, unknown>
            errorChain?: string[]
            originalIntent?: string
        },
        paramsOrTryFn: Record<string, unknown> | ((solution: string) => Promise<unknown>),
        tryFnOrReportFn: ((solution: string) => Promise<unknown>) | ((message: string) => Promise<void>),
        maybeReportFn?: (message: string) => Promise<void>
    ): Promise<SubAgentTask> {
        // Normalize to new format
        let context: { problem: string; params?: Record<string, unknown>; tool?: string }
        let tryFn: (solution: string) => Promise<unknown>
        let reportFn: (message: string) => Promise<void>

        if (typeof contextOrProblem === 'string') {
            // Old signature: (problem, params, tryFn, reportFn)
            context = { problem: contextOrProblem, params: paramsOrTryFn as Record<string, unknown> }
            tryFn = tryFnOrReportFn as (solution: string) => Promise<unknown>
            reportFn = maybeReportFn!
        } else {
            // New signature: (context, tryFn, reportFn)
            context = contextOrProblem
            tryFn = paramsOrTryFn as (solution: string) => Promise<unknown>
            reportFn = tryFnOrReportFn as (message: string) => Promise<void>
        }

        const taskId = `task_${Date.now()}`

        // === CHECK LEARNING CACHE FIRST ===
        const knownSolution = this.getKnownSolution(context.problem)
        if (knownSolution) {
            console.log(`[L8 SubAgent] 💡 Using known solution instead of googling!`)
            await reportFn(`💡 Ich kenne diesen Fehler schon! Versuche die gelernte Lösung...`)

            try {
                const result = await tryFn(knownSolution)
                if (result && typeof result === 'object' && !('error' in result)) {
                    await reportFn(`✅ Gelernte Lösung hat funktioniert!`)
                    return {
                        id: taskId,
                        query: 'known_solution',
                        status: 'success' as const,
                        startedAt: Date.now(),
                        results: [knownSolution],
                        solution: knownSolution,
                    }
                }
            } catch {
                console.log(`[L8 SubAgent] Known solution failed, will google instead`)
            }
        }

        // Build rich query from context
        const richQuery = this.buildRichQuery(context)

        // If not googleable (network errors, auth errors), report and return
        if (!richQuery) {
            console.log(`[L8 SubAgent] ⚠️ Skipping search - environment issue, not googleable`)

            // Check if there are any local hints
            const googleCheck = this.isGoogleableError(context.problem)

            if (googleCheck.localFixes && googleCheck.localFixes.length > 0) {
                const fixList = googleCheck.localFixes.map((f, i) => `${i + 1}. ${f}`).join('\n')
                await reportFn(`⚠️ Umgebungs-Problem - hier sind mögliche Lösungen:\n${fixList}`)
            } else {
                await reportFn('⚠️ Das ist ein Umgebungs-Problem (Netzwerk/Datei/Berechtigung) - Google kann da nicht helfen. Bitte prüfe deine Einstellungen.')
            }

            return {
                id: taskId,
                query: 'skipped',
                status: 'success' as const,
                startedAt: Date.now(),
                results: [],
            }
        }

        const task: SubAgentTask = {
            id: taskId,
            query: richQuery,
            status: 'searching',
            startedAt: Date.now(),
            results: [],
        }

        this.activeTasks.set(taskId, task)
        console.log(`[L8 SubAgent] Spawned agent for: ${context.problem.slice(0, 100)}`)

        // Run in background (don't await)
        this.runSearchAgent(task, context.params || {}, tryFn, reportFn)
            .catch(err => console.error(`[L8 SubAgent] Error: ${err}`))

        return task
    }

    /**
     * Background agent execution
     */
    private async runSearchAgent(
        task: SubAgentTask,
        originalParams: Record<string, unknown>,
        tryFn: (solution: string) => Promise<unknown>,
        reportFn: (message: string) => Promise<void>
    ): Promise<void> {
        try {
            // Step 1: PARALLEL - Ask LLM AND Google AND run tool diagnostics at the same time!
            console.log(`[L8 SubAgent] 🚀 Searching PARALLEL: LLM + Google + Tool Diagnostics`)
            task.status = 'searching'

            // Detect tool from the query context
            const toolName = originalParams.tool as string || ''

            // Run all searches + diagnostics in parallel
            const [searchResults, llmSuggestions, diagnostics] = await Promise.all([
                this.googleSearch(task.query),
                this.askLLM(task.query),
                toolName ? this.runToolDiagnostics(toolName, originalParams) : Promise.resolve([]),
            ])

            // Combine: diagnostics first (most specific), then LLM, then Google
            const combinedResults = [...diagnostics, ...llmSuggestions, ...searchResults]
            task.results = combinedResults

            console.log(`[L8 SubAgent] 📊 Got ${diagnostics.length} diag + ${llmSuggestions.length} LLM + ${searchResults.length} Google`)

            if (combinedResults.length === 0) {
                task.status = 'failed'
                await reportFn(`❌ Agent konnte keine Lösung finden für: ${task.query}`)
                return
            }

            // Step 2: Try solutions RECURSIVELY - keep going until success or max depth
            const MAX_RECURSION_DEPTH = 8  // More persistent! (was 5)
            const SOLUTIONS_PER_ROUND = 5   // Try more solutions (was 3)
            let currentError = task.query
            let currentResults = combinedResults
            let depth = 0

            while (depth < MAX_RECURSION_DEPTH) {
                depth++
                task.status = 'trying'
                console.log(`[L8 SubAgent] Round ${depth}/${MAX_RECURSION_DEPTH}: ${currentResults.length} potential solutions`)

                let foundNewError = false

                for (const solution of currentResults.slice(0, SOLUTIONS_PER_ROUND)) {
                    console.log(`[L8 SubAgent] Checking: ${solution.slice(0, 80)}...`)

                    // SAFETY CHECK - Block dangerous solutions
                    const safetyCheck = this.isSolutionSafe(solution)
                    if (!safetyCheck.safe) {
                        console.log(`[L8 SubAgent] ⛔ BLOCKED: ${safetyCheck.reason}`)
                        continue // Skip this solution, try next one
                    }

                    console.log(`[L8 SubAgent] Trying safe solution...`)

                    try {
                        const result = await tryFn(solution)

                        // Check if it worked (no error)
                        if (result && typeof result === 'object' && !('error' in result) && !('action' in result)) {
                            task.status = 'success'
                            task.solution = solution

                            // === LEARN FROM SUCCESS ===
                            this.learnSolution(task.query, solution)

                            await reportFn(`✅ Agent hat eine Lösung gefunden nach ${depth} Runden!\\n\\n**Was funktioniert hat:**\\n${solution}\\n\\n**Ergebnis:**\\n${JSON.stringify(result).slice(0, 500)}`)

                            this.emit('solution_found', task)
                            return
                        }

                        // Check if there's a NEW error we can try to solve
                        if (result && typeof result === 'object' && (result as any).error) {
                            const newError = (result as any).error as string
                            console.log(`[L8 SubAgent] New error from solution: ${newError.slice(0, 100)}`)

                            // Search for solution to the new error
                            currentError = newError
                            foundNewError = true
                            break
                        }
                    } catch (err: any) {
                        console.log(`[L8 SubAgent] Solution threw: ${err.message || err}`)
                        currentError = err.message || String(err)
                        foundNewError = true
                        break
                    }
                }

                // If we found a new error, search for its solution
                if (foundNewError) {
                    console.log(`[L8 SubAgent] Searching for solution to new error: ${currentError.slice(0, 100)}`)
                    currentResults = await this.googleSearch(currentError)

                    if (currentResults.length === 0) {
                        console.log(`[L8 SubAgent] No solutions found for new error, stopping`)
                        break
                    }
                } else {
                    // No new error but nothing worked either
                    break
                }
            }

            // Ran out of attempts
            task.status = 'failed'
            await reportFn(`🤔 Agent hat ${depth} Runden probiert aber keine endgültige Lösung gefunden.\\n\\nLetzter Fehler: ${currentError.slice(0, 200)}`)

            // === PROACTIVE LEARNING: Add this error as a topic to learn about later ===
            try {
                const { addTopicFromError } = await import('../intelligence/proactive-learning.js')
                addTopicFromError(currentError, task.query)
                console.log('[L8 SubAgent] 📚 Added error to proactive learning queue')
            } catch { /* Proactive learning not available */ }

        } catch (err) {
            task.status = 'failed'
            console.error(`[L8 SubAgent] Critical error: ${err}`)
            await reportFn(`❌ Agent ist auf einen Fehler gestoßen: ${err}`)
        } finally {
            this.activeTasks.delete(task.id)
        }
    }

    /**
     * Sanitize query - remove sensitive data like passwords, IPs, specific paths
     */
    private sanitizeQuery(query: string): string {
        return query
            // Remove passwords
            .replace(/-pw\s*"[^"]*"/gi, '')
            .replace(/password\s*=\s*\S+/gi, '')
            .replace(/\babc\b/gi, 'user') // Replace common test passwords
            // Remove IP addresses
            .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, 'host')
            // Remove port numbers in context
            .replace(/-[pP]\s*\d+/g, '')
            // Remove file paths
            .replace(/[A-Z]:\\[^\s]*/gi, '')
            .replace(/\/[^\s]*\/[^\s]*/g, '')
            // Clean up multiple spaces
            .replace(/\s+/g, ' ')
            .trim()
    }

    /**
     * Extract the core error from a message - captures meaningful error text for searching
     */
    private extractCoreError(query: string): string {
        // Clean up the query first
        const cleaned = query.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

        // === NOVA INTERNAL ERRORS - Extract the ACTUAL command and google it ===
        // Nova's "Script fehlt" error means a command/file is missing - find out WHAT and google how to get it
        if (/Script fehlt|Will Datei ausführen die nicht existiert/i.test(cleaned)) {
            console.log(`[L8] Nova internal error - extracting actual command to google`)
            // Try to find the actual command that failed from the context
            const cmdPatterns = [
                /python\s+-m\s+([\w_]+)/i,      // python -m edge_tts
                /pip\s+install\s+([\w_-]+)/i,   // pip install something  
                /npm\s+(?:run|install)\s+([\w_-]+)/i,  // npm run/install
                /node\s+([\w./]+)/i,            // node script.js
                /([\w_-]+\.(?:py|sh|bat|exe|ps1))/i,  // script.py, run.sh, etc.
            ]
            for (const cmdPat of cmdPatterns) {
                const cmdMatch = cleaned.match(cmdPat)
                if (cmdMatch) {
                    const cmd = cmdMatch[1] || cmdMatch[0]
                    console.log(`[L8] Found command: "${cmd}" - searching how to install`)
                    return `${cmd} Windows install`
                }
            }
            // No specific command found - search generically
            return 'Windows command script not found install'
        }

        // Look for common error patterns - capture the full error message
        const patterns = [
            // Windows-specific
            /Der Befehl "([^"]+)" ist .*(nicht gefunden|falsch geschrieben)/i,
            /command "([^"]+)" (not found|is not recognized)/i,
            /'([^']+)' is not recognized as/i,
            // Python/pip
            /(pip|python|py) .*(not found|nicht gefunden|not recognized)/i,
            // Generic errors
            /FATAL ERROR:\s*(.+?)(\n|$)/i,
            /Error:\s*(.+?)(\n|$)/i,
            /failed:\s*(.+?)(\n|$)/i,
            /Cannot find module '([^']+)'/i,
            /No such file or directory/i,
            /Permission denied/i,
            /Connection (refused|aborted|timeout)/i,
            /Network error/i,
        ]

        for (const pattern of patterns) {
            const match = cleaned.match(pattern)
            if (match) {
                // Return the captured group or full match, cleaned up
                const result = (match[1] || match[0]).trim()
                console.log(`[L8] Extracted error: "${result}" from pattern ${pattern}`)
                return result
            }
        }

        // Fallback: get the most relevant line (first error-like line)
        const lines = cleaned.split('\n').filter(l => l.trim())
        for (const line of lines) {
            if (line.includes('error') || line.includes('Error') ||
                line.includes('failed') || line.includes('not found') ||
                line.includes('nicht gefunden')) {
                return line.slice(0, 150)
            }
        }

        // Last resort: first meaningful line
        return lines[0]?.slice(0, 100) || query.slice(0, 100)
    }

    /**
     * Search for solutions - prioritizes Tavily/Brave over broken Google
     */
    private async googleSearch(query: string): Promise<string[]> {
        try {
            // Try to import search tools - prioritize API-based ones that work
            const { tavilySearchTool } = await import('../tools/tavily-search.js').catch(() => ({ tavilySearchTool: null }))
            const { braveSearchTool } = await import('../tools/brave-search.js').catch(() => ({ braveSearchTool: null }))
            const { browserTools } = await import('../tools/complete-registry.js')

            // Prioritize: Tavily > Brave > web_search (DuckDuckGo) > google_search (broken)
            const searchTool = tavilySearchTool || braveSearchTool ||
                browserTools.find(t => t.name === 'web_search') ||
                browserTools.find(t => t.name === 'google_search')

            if (!searchTool) {
                console.log('[L8 SubAgent] No search tool available')
                return []
            }

            console.log(`[L8 SubAgent] Using search tool: ${searchTool.name}`)

            // Extract core error FIRST (before sanitizing removes it)
            const coreError = this.extractCoreError(query)
            const sanitized = this.sanitizeQuery(coreError)

            // Fallback if sanitized is empty
            const errorText = sanitized.trim() || coreError || query.slice(0, 50)

            console.log(`[L8 SubAgent] Core error: "${errorText}"`)

            // Build DYNAMIC search queries based on the actual error
            const searches = [
                `${errorText} Windows solution`,
                `${errorText} fix how to`,
                `"${errorText}" workaround`,
                `${errorText} alternative command Windows`,
                // If it's a "command not found" type error, add specific searches
                errorText.includes('pip') ? 'Windows pip not found python -m pip solution' : null,
                errorText.includes('python') ? 'Windows python not found install path' : null,
                errorText.includes('npm') ? 'Windows npm not found nodejs path' : null,
                errorText.includes('ssh') || errorText.includes('plink') ? 'Windows ssh password openssh alternative' : null,
            ].filter(Boolean) as string[]

            const allResults: string[] = []

            for (const searchQuery of searches) {
                console.log(`[L8 SubAgent] Searching: ${searchQuery}`)

                try {
                    const result = await searchTool.handler({ query: searchQuery, count: 3 }) as any
                    const results = result.results?.map((r: any) =>
                        `${r.title}: ${r.snippet || r.url}`.slice(0, 200)
                    ) || []

                    if (results.length > 0) {
                        console.log(`[L8 SubAgent] Found ${results.length} results for: ${searchQuery.slice(0, 50)}`)
                        allResults.push(...results)
                    }
                } catch (err) {
                    console.log(`[L8 SubAgent] Search failed: ${err}`)
                }

                // Stop if we have enough results
                if (allResults.length >= 5) break
            }

            return allResults

        } catch (err) {
            console.error(`[L8 SubAgent] Google search failed: ${err}`)
            return []
        }
    }

    /**
     * Get active tasks
     */
    getActiveTasks(): SubAgentTask[] {
        return Array.from(this.activeTasks.values())
    }

    /**
     * Check if agent is working on similar problem
     */
    isWorkingOn(query: string): boolean {
        const words = query.toLowerCase().split(/\s+/)
        return Array.from(this.activeTasks.values()).some(t => {
            const taskWords = t.query.toLowerCase().split(/\s+/)
            const common = words.filter(w => taskWords.includes(w)).length
            return common / Math.max(words.length, taskWords.length) > 0.5
        })
    }
}

// ============================================
// Singleton
// ============================================

let manager: SubAgentManager | null = null

export function getSubAgentManager(): SubAgentManager {
    if (!manager) {
        manager = new SubAgentManager()
    }
    return manager
}

// ============================================
// Helper: Quick check and spawn
// ============================================

export async function triggerFallbackIfNeeded(
    failureCount: number,
    problem: string,
    originalParams: Record<string, unknown>,
    tryFn: (solution: string) => Promise<unknown>,
    reportFn: (message: string) => Promise<void>
): Promise<{ triggered: boolean; message: string }> {
    const mgr = getSubAgentManager()

    if (!mgr.shouldTriggerFallback(failureCount)) {
        return { triggered: false, message: '' }
    }

    if (mgr.isWorkingOn(problem)) {
        return { triggered: false, message: '🔍 Ein Agent arbeitet bereits daran...' }
    }

    await mgr.spawnSearchAgent({ problem, params: originalParams }, tryFn, reportFn)

    return {
        triggered: true,
        message: mgr.getFallbackMessage(),
    }
}

export default {
    SubAgentManager,
    getSubAgentManager,
    triggerFallbackIfNeeded,
}
