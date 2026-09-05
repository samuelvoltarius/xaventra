/**
 * Nova - Security Layer
 * 
 * Protects Nova from:
 * 1. Prompt Injection / Jailbreaking
 * 2. System file access (strict sandbox)
 * 3. Command injection
 * 4. Sensitive data leaks
 */

import { normalize, resolve, sep } from 'node:path'

// ============================================
// Blocked System Paths (NEVER access these)
// ============================================

const BLOCKED_PATHS_WINDOWS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\Users\\All Users',
    'C:\\System Volume Information',
    'C:\\$Recycle.Bin',
    'C:\\Recovery',
    'C:\\Boot',
    // Sensitive user folders
    '\\AppData\\Local\\Microsoft',
    '\\AppData\\Roaming\\Microsoft',
    '\\AppData\\Local\\Google\\Chrome\\User Data',
    '\\AppData\\Roaming\\Mozilla\\Firefox',
    '\\.ssh',
    '\\.gnupg',
    '\\.aws',
    '\\.azure',
    '\\.kube',
    '\\Documents\\WindowsPowerShell',
]

const BLOCKED_PATHS_UNIX = [
    '/etc',
    '/var',
    '/usr',
    '/bin',
    '/sbin',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/root',
    '/lib',
    '/lib64',
    '/opt',
    // Sensitive user paths
    '/.ssh',
    '/.gnupg',
    '/.aws',
    '/.azure',
    '/.kube',
    '/.bashrc',
    '/.zshrc',
    '/.profile',
    '/.config/google-chrome',
    '/.mozilla',
]

const BLOCKED_PATHS = process.platform === 'win32'
    ? BLOCKED_PATHS_WINDOWS
    : BLOCKED_PATHS_UNIX

// ============================================
// Blocked File Extensions
// ============================================

const BLOCKED_EXTENSIONS = [
    '.exe', '.dll', '.sys', '.drv',      // Executables
    '.bat', '.cmd', '.ps1', '.vbs',      // Scripts (Windows)
    '.sh', '.bash',                       // Scripts (Unix) - read OK, execute blocked
    '.msi', '.msp',                       // Installers
    '.reg', '.inf',                       // Registry/Config
    '.pem', '.key', '.crt', '.p12',      // Certificates/Keys
    '.kdbx', '.keychain',                 // Password managers
    '.wallet', '.dat',                    // Crypto wallets
]

// ============================================
// Blocked Commands (ALWAYS blocked - destructive)
// ============================================

const ALWAYS_BLOCKED_COMMANDS = [
    // System destructive - NEVER allow
    'rm -rf /',
    'rm -rf /*',
    'del /f /s /q c:\\',
    'format c:',
    'mkfs',
    'dd if=/dev/zero',
    'dd if=/dev/random',
    ':(){:|:&};:',       // Fork bomb

    // Credential theft tools
    'mimikatz',
    'lazagne',
    'secretsdump',
    'hashdump',

    // Crypto mining
    'xmrig',
    'minerd',
    'cgminer',

    // Reverse shells
    'nc -e',
    'ncat -e',
    '/dev/tcp/',
    'powershell -encodedcommand',
    'powershell -e ',
]

// ============================================
// Elevated Commands (only allowed for owner/admin)
// ============================================

const ELEVATED_COMMANDS = [
    // Package managers - OK for admins
    'sudo apt',
    'sudo yum',
    'sudo dnf',
    'sudo pacman',
    'sudo brew',
    'sudo npm',
    'sudo pip',

    // Docker - OK for admins
    'docker',
    'docker-compose',
    'podman',

    // System services - OK for admins
    'sudo systemctl',
    'sudo service',

    // Permission changes - OK for admins (but not 777)
    'sudo chmod',
    'sudo chown',

    // Process management
    'sudo kill',
    'sudo pkill',
]

// ============================================
// Prompt Injection Patterns
// ============================================

const INJECTION_PATTERNS = [
    // Direct instructions to ignore
    /ignore\s+(all\s+)?(previous|prior|above)/gi,
    /disregard\s+(all\s+)?(previous|prior|above)/gi,
    /forget\s+(all\s+)?(previous|prior|above|everything)/gi,

    // Role switching
    /you\s+are\s+(now|actually)\s+/gi,
    /act\s+as\s+(if\s+you\s+were|a)\s+/gi,
    /pretend\s+(to\s+be|you\s+are)/gi,
    /roleplay\s+as/gi,

    // System prompt extraction
    /what\s+(is|are)\s+your\s+(system\s+)?prompt/gi,
    /show\s+(me\s+)?your\s+(system\s+)?instructions/gi,
    /repeat\s+(back\s+)?your\s+(initial\s+)?instructions/gi,
    /print\s+your\s+(system\s+)?prompt/gi,

    // DAN/Jailbreak
    /\bdan\b.*mode/gi,
    /jailbreak/gi,
    /bypass\s+(your\s+)?(restrictions|filters|rules)/gi,
    /developer\s+mode/gi,
    /god\s+mode/gi,

    // Hidden instructions
    /\[system\]/gi,
    /\[instructions?\]/gi,
    /\[override\]/gi,
    /<\|im_start\|>/gi,
    /<\|im_end\|>/gi,
]

// ============================================
// Security Check Results
// ============================================

export interface SecurityCheckResult {
    allowed: boolean
    reason?: string
    severity: 'info' | 'warning' | 'critical'
    blocked?: string
}

// ============================================
// Security Layer Class
// ============================================

export class SecurityLayer {
    private allowedBasePaths: string[] = []
    private strictMode: boolean
    private logBlocked: boolean

    constructor(options: {
        allowedBasePaths?: string[]
        strictMode?: boolean
        logBlocked?: boolean
    } = {}) {
        this.allowedBasePaths = options.allowedBasePaths || [process.cwd()]
        this.strictMode = options.strictMode ?? true
        this.logBlocked = options.logBlocked ?? true
    }

    // ============================================
    // Path Security
    // ============================================

    /**
     * Check if a file path is safe to access.
     */
    checkPath(filePath: string): SecurityCheckResult {
        const normalizedPath = normalize(resolve(filePath))

        // Check against blocked system paths
        for (const blocked of BLOCKED_PATHS) {
            if (normalizedPath.toLowerCase().includes(blocked.toLowerCase())) {
                this.logBlock('path', filePath, `Matches blocked path: ${blocked}`)
                return {
                    allowed: false,
                    reason: `Zugriff auf Systempfad nicht erlaubt: ${blocked}`,
                    severity: 'critical',
                    blocked: blocked,
                }
            }
        }

        // Check file extension
        const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
        if (BLOCKED_EXTENSIONS.includes(ext)) {
            this.logBlock('extension', filePath, `Blocked extension: ${ext}`)
            return {
                allowed: false,
                reason: `Dateityp nicht erlaubt: ${ext}`,
                severity: 'critical',
                blocked: ext,
            }
        }

        // In strict mode, must be within allowed base paths
        if (this.strictMode) {
            const isAllowed = this.allowedBasePaths.some(basePath => {
                const normalizedBase = normalize(resolve(basePath))
                return normalizedPath.startsWith(normalizedBase + sep) ||
                    normalizedPath === normalizedBase
            })

            if (!isAllowed) {
                this.logBlock('sandbox', filePath, 'Outside allowed paths')
                return {
                    allowed: false,
                    reason: 'Pfad ist außerhalb des erlaubten Arbeitsbereichs',
                    severity: 'warning',
                }
            }
        }

        return { allowed: true, severity: 'info' }
    }

    /**
     * Sanitize a file path (remove traversal attempts).
     */
    sanitizePath(filePath: string): string {
        // Remove null bytes
        let sanitized = filePath.replace(/\0/g, '')

        // Remove path traversal
        sanitized = sanitized.replace(/\.\.[/\\]/g, '')
        sanitized = sanitized.replace(/[/\\]\.\./g, '')

        // Remove leading slashes that could escape sandbox
        sanitized = sanitized.replace(/^[/\\]+/, '')

        return sanitized
    }

    // ============================================
    // Command Security
    // ============================================

    /**
     * Check if a command is safe to execute.
     * @param command The command to check
     * @param isElevatedUser If true, allow sudo/docker etc. (owner/admin only)
     */
    checkCommand(command: string, isElevatedUser = false): SecurityCheckResult {
        const commandLower = command.toLowerCase()

        // Always blocked - even for admins (destructive commands)
        for (const blocked of ALWAYS_BLOCKED_COMMANDS) {
            if (commandLower.includes(blocked.toLowerCase())) {
                this.logBlock('command', command, `Matches always-blocked command: ${blocked}`)
                return {
                    allowed: false,
                    reason: `Destruktiver Befehl blockiert`,
                    severity: 'critical',
                    blocked: blocked,
                }
            }
        }

        // Check for chmod 777 (dangerous even for admins)
        if (/chmod\s+777/.test(command)) {
            this.logBlock('command', command, 'chmod 777 is too permissive')
            return {
                allowed: false,
                reason: 'chmod 777 ist nicht erlaubt (zu unsicher)',
                severity: 'critical',
            }
        }

        // Elevated commands - only for owner/admin
        if (!isElevatedUser) {
            for (const elevated of ELEVATED_COMMANDS) {
                if (commandLower.includes(elevated.toLowerCase())) {
                    this.logBlock('command', command, `Elevated command requires admin: ${elevated}`)
                    return {
                        allowed: false,
                        reason: `Befehl erfordert Admin-Rechte: ${elevated}`,
                        severity: 'warning',
                        blocked: elevated,
                        requiresElevation: true,
                    } as SecurityCheckResult
                }
            }
        }

        // Check for pipe to shell (from untrusted source)
        if (/curl.*\|.*sh|wget.*\|.*sh/i.test(command)) {
            this.logBlock('command', command, 'Pipe from internet to shell detected')
            return {
                allowed: false,
                reason: 'Pipe von URL zu Shell nicht erlaubt',
                severity: 'critical',
            }
        }

        // Check for base64 encoded commands (obfuscation attempt)
        if (/base64\s+-d|echo\s+.*\|\s*base64\s+-d/i.test(command)) {
            this.logBlock('command', command, 'Base64 obfuscation detected')
            return {
                allowed: false,
                reason: 'Verschleierte Befehle nicht erlaubt',
                severity: 'critical',
            }
        }

        return { allowed: true, severity: 'info' }
    }

    // ============================================
    // Input Security (Anti-Injection)
    // ============================================

    /**
     * Check user input for prompt injection attempts.
     */
    checkInput(input: string): SecurityCheckResult {
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(input)) {
                this.logBlock('injection', input.slice(0, 100), `Pattern match: ${pattern}`)
                return {
                    allowed: false,
                    reason: 'Verdächtige Eingabe erkannt',
                    severity: 'warning',
                    blocked: pattern.toString(),
                }
            }
        }

        // Check for hidden Unicode characters
        if (/[\u200B-\u200D\uFEFF\u2028\u2029]/.test(input)) {
            this.logBlock('injection', 'Hidden Unicode detected', 'Zero-width chars')
            return {
                allowed: false,
                reason: 'Versteckte Zeichen erkannt',
                severity: 'warning',
            }
        }

        return { allowed: true, severity: 'info' }
    }

    /**
     * Sanitize user input (remove dangerous patterns).
     */
    sanitizeInput(input: string): string {
        let sanitized = input

        // Remove hidden Unicode
        sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF\u2028\u2029]/g, '')

        // Remove control characters (except newline, tab)
        sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

        return sanitized
    }

    // ============================================
    // Output Security
    // ============================================

    /**
     * Check if output contains sensitive data.
     */
    checkOutput(output: string): SecurityCheckResult {
        // Check for potential secrets
        const secretPatterns = [
            /password\s*[:=]\s*['"]?[^'"}\s]{8,}/gi,
            /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9]{20,}/gi,
            /secret\s*[:=]\s*['"]?[^'"}\s]{10,}/gi,
            /token\s*[:=]\s*['"]?[a-zA-Z0-9._-]{20,}/gi,
            /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
            /-----BEGIN\s+CERTIFICATE-----/i,
        ]

        for (const pattern of secretPatterns) {
            if (pattern.test(output)) {
                return {
                    allowed: false,
                    reason: 'Output enthält sensible Daten',
                    severity: 'critical',
                }
            }
        }

        return { allowed: true, severity: 'info' }
    }

    /**
     * Redact sensitive data from output.
     */
    redactOutput(output: string): string {
        let redacted = output

        // Redact API keys
        redacted = redacted.replace(
            /(api[_-]?key\s*[:=]\s*['"]?)[a-zA-Z0-9]{20,}/gi,
            '$1[REDACTED]'
        )

        // Redact passwords
        redacted = redacted.replace(
            /(password\s*[:=]\s*['"]?)[^'"}\s]{8,}/gi,
            '$1[REDACTED]'
        )

        // Redact tokens
        redacted = redacted.replace(
            /(token\s*[:=]\s*['"]?)[a-zA-Z0-9._-]{20,}/gi,
            '$1[REDACTED]'
        )

        return redacted
    }

    // ============================================
    // Configuration
    // ============================================

    /**
     * Add an allowed base path.
     */
    addAllowedPath(basePath: string): void {
        const normalized = normalize(resolve(basePath))
        if (!this.allowedBasePaths.includes(normalized)) {
            this.allowedBasePaths.push(normalized)
        }
    }

    /**
     * Get current configuration.
     */
    getConfig(): {
        allowedPaths: string[]
        strictMode: boolean
        blockedPathsCount: number
        blockedExtensionsCount: number
        blockedCommandsCount: number
        elevatedCommandsCount: number
    } {
        return {
            allowedPaths: this.allowedBasePaths,
            strictMode: this.strictMode,
            blockedPathsCount: BLOCKED_PATHS.length,
            blockedExtensionsCount: BLOCKED_EXTENSIONS.length,
            blockedCommandsCount: ALWAYS_BLOCKED_COMMANDS.length,
            elevatedCommandsCount: ELEVATED_COMMANDS.length,
        }
    }

    // ============================================
    // Logging
    // ============================================

    private logBlock(type: string, target: string, reason: string): void {
        if (this.logBlocked) {
            console.log(`[Security] 🛡️ BLOCKED ${type.toUpperCase()}: ${reason}`)
            console.log(`[Security]    Target: ${target.slice(0, 100)}`)
        }
    }
}

// ============================================
// Global Instance
// ============================================

let securityInstance: SecurityLayer | null = null

export function getSecurity(): SecurityLayer {
    if (!securityInstance) {
        securityInstance = new SecurityLayer()
    }
    return securityInstance
}

export function createSecurity(options?: ConstructorParameters<typeof SecurityLayer>[0]): SecurityLayer {
    return new SecurityLayer(options)
}

// ============================================
// Convenience Functions
// ============================================

export function isPathSafe(path: string): boolean {
    return getSecurity().checkPath(path).allowed
}

export function isCommandSafe(command: string): boolean {
    return getSecurity().checkCommand(command).allowed
}

export function isInputSafe(input: string): boolean {
    return getSecurity().checkInput(input).allowed
}

export default {
    SecurityLayer,
    getSecurity,
    createSecurity,
    isPathSafe,
    isCommandSafe,
    isInputSafe,
}
