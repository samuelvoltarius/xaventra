/**
 * Nova Security Audit Module
 *
 * Security scanning and auditing:
 * - File permission checks
 * - Config security validation
 * - Dangerous tool detection
 * - Skill code scanning
 * - Secret leak detection
 *
 * Inspired by OpenClaw's security/ (21 files — audit.ts 25KB, fix.ts 14KB, skill-scanner.ts 12KB)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

// ============================================
// Types
// ============================================

export type SeverityLevel = 'info' | 'warning' | 'critical'

export interface AuditFinding {
    severity: SeverityLevel
    category: string
    message: string
    file?: string
    line?: number
    suggestion?: string
}

export interface AuditReport {
    timestamp: number
    duration: number
    findings: AuditFinding[]
    score: number           // 0-100 security score
    summary: {
        critical: number
        warning: number
        info: number
    }
}

// ============================================
// Dangerous Patterns (like OpenClaw's dangerous-tools.ts)
// ============================================

const SECRET_PATTERNS = [
    { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([^'"]{10,})['"]/, name: 'API Key' },
    { pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"]([^'"]{6,})['"]/, name: 'Secret/Password' },
    { pattern: /(?:token)\s*[:=]\s*['"]([^'"]{20,})['"]/, name: 'Token' },
    { pattern: /(?:sk-[a-zA-Z0-9]{20,})/, name: 'OpenAI API Key' },
    { pattern: /(?:ghp_[a-zA-Z0-9]{36,})/, name: 'GitHub Token' },
    { pattern: /(?:AKIA[A-Z0-9]{16})/, name: 'AWS Access Key' },
    { pattern: /(?:xoxb-[0-9]{10,13}-[a-zA-Z0-9-]+)/, name: 'Slack Bot Token' },
]

const DANGEROUS_CODE_PATTERNS = [
    { pattern: /eval\s*\(/, severity: 'critical' as SeverityLevel, message: 'eval() ist gefährlich — Code-Injection möglich' },
    { pattern: /Function\s*\(/, severity: 'warning' as SeverityLevel, message: 'Function constructor — dynamisch ausgeführter Code' },
    { pattern: /child_process.*exec\s*\(/, severity: 'warning' as SeverityLevel, message: 'Ungefilterte Shell-Ausführung — Injection-Risiko' },
    { pattern: /\.innerHTML\s*=/, severity: 'warning' as SeverityLevel, message: 'innerHTML kann XSS ermöglichen' },
    { pattern: /require\s*\(['"]child_process['"]/, severity: 'info' as SeverityLevel, message: 'child_process Import — Shell-Zugang' },
    { pattern: /process\.env\./, severity: 'info' as SeverityLevel, message: 'Environment-Variable — prüfen ob sensitiv' },
]

// ============================================
// Audit Functions
// ============================================

/**
 * Run a full security audit
 */
export function runAudit(targetDir?: string): AuditReport {
    const startTime = Date.now()
    const dir = targetDir || process.cwd()
    const findings: AuditFinding[] = []

    // 1. Scan source files for secrets & dangerous patterns
    const sourceFiles = findSourceFiles(dir)
    for (const file of sourceFiles) {
        scanFileForSecrets(file, findings)
        scanFileForDangerousCode(file, findings)
    }

    // 2. Check config files
    checkConfigSecurity(dir, findings)

    // 3. Check file permissions (Linux/macOS)
    if (process.platform !== 'win32') {
        checkFilePermissions(dir, findings)
    }

    // 4. Check .env files
    checkEnvFiles(dir, findings)

    // 5. Check for exposed ports / debug mode
    checkDebugMode(dir, findings)

    // Calculate score
    const critical = findings.filter(f => f.severity === 'critical').length
    const warnings = findings.filter(f => f.severity === 'warning').length
    const infos = findings.filter(f => f.severity === 'info').length
    const score = Math.max(0, 100 - (critical * 20) - (warnings * 5) - (infos * 1))

    return {
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        findings,
        score,
        summary: { critical, warning: warnings, info: infos },
    }
}

// ============================================
// File Scanning
// ============================================

function findSourceFiles(dir: string, maxDepth = 5): string[] {
    const results: string[] = []
    const extensions = ['.ts', '.js', '.json', '.env', '.yaml', '.yml', '.toml']

    function walk(currentDir: string, depth: number) {
        if (depth > maxDepth) return

        try {
            const entries = readdirSync(currentDir, { withFileTypes: true })
            for (const entry of entries) {
                const fullPath = join(currentDir, entry.name)

                if (entry.isDirectory()) {
                    // Skip common non-source dirs
                    if (['node_modules', '.git', 'dist', '.nova-data', '.next'].includes(entry.name)) continue
                    walk(fullPath, depth + 1)
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).toLowerCase()
                    if (extensions.includes(ext)) {
                        results.push(fullPath)
                    }
                }
            }
        } catch { /* permission denied, etc */ }
    }

    walk(dir, 0)
    return results
}

function scanFileForSecrets(filePath: string, findings: AuditFinding[]): void {
    // Skip known safe files
    const filename = filePath.split(/[\\/]/).pop() || ''
    if (filename.endsWith('.d.ts') || filename.endsWith('.test.ts') || filename.endsWith('.test.js')) return

    try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]

            for (const pattern of SECRET_PATTERNS) {
                if (pattern.pattern.test(line)) {
                    // Check if it's in a comment or example
                    const trimmed = line.trim()
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue
                    if (trimmed.includes('example') || trimmed.includes('placeholder') || trimmed.includes('xxx')) continue

                    findings.push({
                        severity: 'critical',
                        category: 'secret-leak',
                        message: `Mögliches ${pattern.name} im Code gefunden`,
                        file: filePath,
                        line: i + 1,
                        suggestion: 'In Environment-Variable oder Secrets-Manager verschieben',
                    })
                }
            }
        }
    } catch { /* file read error */ }
}

function scanFileForDangerousCode(filePath: string, findings: AuditFinding[]): void {
    try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]

            for (const pattern of DANGEROUS_CODE_PATTERNS) {
                if (pattern.pattern.test(line)) {
                    findings.push({
                        severity: pattern.severity,
                        category: 'dangerous-code',
                        message: pattern.message,
                        file: filePath,
                        line: i + 1,
                    })
                }
            }
        }
    } catch { /* file read error */ }
}

// ============================================
// Config Checks
// ============================================

function checkConfigSecurity(dir: string, findings: AuditFinding[]): void {
    // Check nova.config.json
    const configPath = join(dir, 'nova.config.json')
    if (existsSync(configPath)) {
        try {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))

            // Check for hardcoded keys
            if (config.openai?.apiKey && !config.openai.apiKey.startsWith('$')) {
                findings.push({
                    severity: 'critical',
                    category: 'config',
                    message: 'OpenAI API Key direkt in Config statt via Environment-Variable',
                    file: configPath,
                    suggestion: 'Verwende OPENAI_API_KEY Environment-Variable',
                })
            }

            if (config.telegram?.token && !config.telegram.token.startsWith('$')) {
                findings.push({
                    severity: 'critical',
                    category: 'config',
                    message: 'Telegram Bot Token direkt in Config',
                    file: configPath,
                    suggestion: 'Verwende TELEGRAM_BOT_TOKEN Environment-Variable',
                })
            }
        } catch { /* invalid JSON */ }
    }

    // Check package.json for vulnerable scripts
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
            const scripts = pkg.scripts || {}

            for (const [name, cmd] of Object.entries(scripts)) {
                if (typeof cmd === 'string' && (cmd.includes('curl') || cmd.includes('wget'))) {
                    findings.push({
                        severity: 'warning',
                        category: 'config',
                        message: `Script "${name}" lädt externe Resourcen herunter`,
                        file: pkgPath,
                    })
                }
            }
        } catch { /* invalid JSON */ }
    }
}

function checkEnvFiles(dir: string, findings: AuditFinding[]): void {
    const envFiles = ['.env', '.env.local', '.env.production']

    for (const envFile of envFiles) {
        const envPath = join(dir, envFile)
        if (existsSync(envPath)) {
            // Check if .gitignore contains this file
            const gitignorePath = join(dir, '.gitignore')
            if (existsSync(gitignorePath)) {
                const gitignore = readFileSync(gitignorePath, 'utf-8')
                if (!gitignore.includes(envFile) && !gitignore.includes('.env')) {
                    findings.push({
                        severity: 'critical',
                        category: 'env',
                        message: `${envFile} ist NICHT in .gitignore — Secrets könnten committed werden!`,
                        file: envPath,
                        suggestion: `echo "${envFile}" >> .gitignore`,
                    })
                }
            }
        }
    }
}

function checkFilePermissions(dir: string, findings: AuditFinding[]): void {
    const sensitiveFiles = ['nova.config.json', '.env', '.env.local', '.env.production']

    for (const file of sensitiveFiles) {
        const filePath = join(dir, file)
        if (existsSync(filePath)) {
            try {
                const stat = statSync(filePath)
                const mode = stat.mode & 0o777

                // Check if world-readable
                if (mode & 0o004) {
                    findings.push({
                        severity: 'warning',
                        category: 'permissions',
                        message: `${file} ist world-readable (${mode.toString(8)})`,
                        file: filePath,
                        suggestion: `chmod 600 "${filePath}"`,
                    })
                }
            } catch { /* stat error */ }
        }
    }
}

function checkDebugMode(dir: string, findings: AuditFinding[]): void {
    // Check for debug mode in config
    const configPath = join(dir, 'nova.config.json')
    if (existsSync(configPath)) {
        try {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.debug === true) {
                findings.push({
                    severity: 'warning',
                    category: 'config',
                    message: 'Debug-Modus ist aktiviert — mehr Informationen werden geloggt',
                    file: configPath,
                    suggestion: 'Für Produktion debug: false setzen',
                })
            }
        } catch { /* */ }
    }
}

// ============================================
// Quick Scan (lighter version)
// ============================================

/**
 * Quick security scan — only checks critical items
 */
export function quickScan(dir?: string): {
    safe: boolean
    criticalFindings: AuditFinding[]
} {
    const report = runAudit(dir)
    const criticalFindings = report.findings.filter(f => f.severity === 'critical')
    return {
        safe: criticalFindings.length === 0,
        criticalFindings,
    }
}

export default {
    runAudit,
    quickScan,
}
