/**
 * L15 Security Scanner - Red Team Layer
 * 
 * Automatically scans code for security vulnerabilities:
 * - OWASP Top 10 checks
 * - SQL Injection patterns
 * - XSS vulnerabilities
 * - Hardcoded secrets detection
 * - Insecure dependencies
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { execSync } from 'node:child_process'

// ============================================
// Types
// ============================================

export interface SecurityIssue {
    id: string
    type: SecurityIssueType
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
    file: string
    line?: number
    code?: string
    description: string
    recommendation: string
    owaspCategory?: string
}

export type SecurityIssueType =
    | 'sql_injection'
    | 'xss'
    | 'hardcoded_secret'
    | 'insecure_dependency'
    | 'path_traversal'
    | 'command_injection'
    | 'insecure_random'
    | 'missing_auth'
    | 'sensitive_data_exposure'
    | 'insecure_deserialization'
    | 'broken_access_control'
    | 'security_misconfiguration'

export interface ScanResult {
    timestamp: number
    scannedFiles: number
    issues: SecurityIssue[]
    summary: {
        critical: number
        high: number
        medium: number
        low: number
        info: number
    }
    passed: boolean
}

// ============================================
// Security Patterns
// ============================================

interface SecurityPattern {
    id: string
    type: SecurityIssueType
    severity: SecurityIssue['severity']
    pattern: RegExp
    description: string
    recommendation: string
    owaspCategory?: string
    fileTypes?: string[]
}

const SECURITY_PATTERNS: SecurityPattern[] = [
    // SQL Injection
    {
        id: 'sql-injection-concat',
        type: 'sql_injection',
        severity: 'critical',
        pattern: /query\s*\(\s*['"`].*\$\{|execute\s*\(\s*['"`].*\+\s*\w+/gi,
        description: 'Mögliche SQL-Injection durch String-Konkatenation',
        recommendation: 'Verwende parametrisierte Queries oder Prepared Statements',
        owaspCategory: 'A03:2021 - Injection',
    },
    {
        id: 'sql-raw-query',
        type: 'sql_injection',
        severity: 'high',
        pattern: /\$queryRaw|\.raw\s*\(|rawQuery|executeRaw/gi,
        description: 'Raw SQL Query gefunden - erhöhtes Injection-Risiko',
        recommendation: 'Prüfe alle Eingaben und verwende Prisma-Parameter',
        owaspCategory: 'A03:2021 - Injection',
    },

    // XSS
    {
        id: 'xss-innerhtml',
        type: 'xss',
        severity: 'high',
        pattern: /innerHTML\s*=|dangerouslySetInnerHTML|v-html/gi,
        description: 'Direktes HTML-Einfügen ermöglicht XSS-Angriffe',
        recommendation: 'Sanitize HTML oder verwende textContent',
        owaspCategory: 'A03:2021 - Injection',
    },
    {
        id: 'xss-document-write',
        type: 'xss',
        severity: 'high',
        pattern: /document\.write\s*\(/gi,
        description: 'document.write ist XSS-anfällig',
        recommendation: 'Verwende DOM-Manipulation stattdessen',
        owaspCategory: 'A03:2021 - Injection',
    },

    // Hardcoded Secrets
    {
        id: 'secret-api-key',
        type: 'hardcoded_secret',
        severity: 'critical',
        pattern: /(?:api[_-]?key|apikey|secret[_-]?key|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi,
        description: 'Hardcodierter API-Key oder Secret gefunden',
        recommendation: 'Verwende Environment-Variablen für Secrets',
        owaspCategory: 'A02:2021 - Cryptographic Failures',
    },
    {
        id: 'secret-private-key',
        type: 'hardcoded_secret',
        severity: 'critical',
        pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/gi,
        description: 'Private Key im Code gefunden!',
        recommendation: 'Entferne sofort und rotiere den Key',
        owaspCategory: 'A02:2021 - Cryptographic Failures',
    },
    {
        id: 'secret-jwt',
        type: 'hardcoded_secret',
        severity: 'high',
        pattern: /jwt[_-]?secret\s*[:=]\s*['"][^'"]{8,}['"]/gi,
        description: 'Hardcodiertes JWT Secret',
        recommendation: 'Generiere ein zufälliges Secret und speichere es sicher',
        owaspCategory: 'A02:2021 - Cryptographic Failures',
    },

    // Command Injection
    {
        id: 'command-exec',
        type: 'command_injection',
        severity: 'critical',
        pattern: /exec(?:Sync)?\s*\(\s*['"`].*\$\{|child_process.*exec.*\+\s*\w+/gi,
        description: 'Mögliche Command Injection durch String-Interpolation',
        recommendation: 'Verwende execFile mit Argument-Array statt exec',
        owaspCategory: 'A03:2021 - Injection',
    },

    // Path Traversal
    {
        id: 'path-traversal',
        type: 'path_traversal',
        severity: 'high',
        pattern: /readFile(?:Sync)?\s*\(\s*(?:req\.|params\.|query\.)/gi,
        description: 'Potenzielle Path Traversal - User-Input als Dateipfad',
        recommendation: 'Validiere Pfade und verwende path.resolve + basename',
        owaspCategory: 'A01:2021 - Broken Access Control',
    },

    // Insecure Randomness
    {
        id: 'insecure-random',
        type: 'insecure_random',
        severity: 'medium',
        pattern: /Math\.random\(\)/gi,
        description: 'Math.random() ist nicht kryptografisch sicher',
        recommendation: 'Verwende crypto.randomBytes() für sicherheitskritische Werte',
        owaspCategory: 'A02:2021 - Cryptographic Failures',
        fileTypes: ['.ts', '.js'],
    },

    // Missing Auth
    {
        id: 'no-auth-route',
        type: 'missing_auth',
        severity: 'medium',
        pattern: /app\.(get|post|put|delete|patch)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s*)?\(?(?:req|ctx)/gi,
        description: 'Route ohne sichtbare Authentifizierung',
        recommendation: 'Prüfe ob Auth-Middleware verwendet wird',
        owaspCategory: 'A01:2021 - Broken Access Control',
    },

    // Insecure Deserialization
    {
        id: 'eval-usage',
        type: 'insecure_deserialization',
        severity: 'critical',
        pattern: /eval\s*\(|new\s+Function\s*\(/gi,
        description: 'eval() oder new Function() ermöglicht Code-Injection',
        recommendation: 'Vermeide eval komplett',
        owaspCategory: 'A08:2021 - Software and Data Integrity Failures',
    },

    // Sensitive Data Exposure
    {
        id: 'console-sensitive',
        type: 'sensitive_data_exposure',
        severity: 'medium',
        pattern: /console\.log\s*\(.*(?:password|secret|token|key|auth)/gi,
        description: 'Sensitive Daten werden geloggt',
        recommendation: 'Entferne Logging von sensiblen Daten',
        owaspCategory: 'A02:2021 - Cryptographic Failures',
    },

    // Security Misconfiguration
    {
        id: 'cors-wildcard',
        type: 'security_misconfiguration',
        severity: 'high',
        pattern: /cors\s*\(\s*\{[^}]*origin\s*:\s*['"]?\*['"]?/gi,
        description: 'CORS mit Wildcard Origin',
        recommendation: 'Beschränke CORS auf erlaubte Domains',
        owaspCategory: 'A05:2021 - Security Misconfiguration',
    },
    {
        id: 'http-only-false',
        type: 'security_misconfiguration',
        severity: 'medium',
        pattern: /httpOnly\s*:\s*false/gi,
        description: 'Cookie ohne httpOnly Flag',
        recommendation: 'Setze httpOnly: true für Session-Cookies',
        owaspCategory: 'A05:2021 - Security Misconfiguration',
    },
]

// ============================================
// Security Scanner
// ============================================

export class SecurityScanner {
    private excludeDirs = ['node_modules', 'dist', 'build', '.git', '.next', 'coverage']
    private includeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

    constructor() {
        console.log(`[L15 SecurityScanner] Initialized with ${SECURITY_PATTERNS.length} patterns`)
    }

    /**
     * Scan a directory for security issues
     */
    async scanDirectory(rootPath: string): Promise<ScanResult> {
        console.log(`[L15 SecurityScanner] Scanning: ${rootPath}`)

        const files = this.findFiles(rootPath)
        console.log(`[L15 SecurityScanner] Found ${files.length} files to scan`)

        const issues: SecurityIssue[] = []

        for (const file of files) {
            const fileIssues = await this.scanFile(file, rootPath)
            issues.push(...fileIssues)
        }

        // Sort by severity
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

        const summary = {
            critical: issues.filter(i => i.severity === 'critical').length,
            high: issues.filter(i => i.severity === 'high').length,
            medium: issues.filter(i => i.severity === 'medium').length,
            low: issues.filter(i => i.severity === 'low').length,
            info: issues.filter(i => i.severity === 'info').length,
        }

        const passed = summary.critical === 0 && summary.high === 0

        console.log(`[L15 SecurityScanner] Scan complete: ${issues.length} issues found`)

        return {
            timestamp: Date.now(),
            scannedFiles: files.length,
            issues,
            summary,
            passed,
        }
    }

    /**
     * Scan a single file
     */
    async scanFile(filePath: string, rootPath?: string): Promise<SecurityIssue[]> {
        const issues: SecurityIssue[] = []
        const ext = extname(filePath)

        try {
            const content = readFileSync(filePath, 'utf-8')
            const lines = content.split('\n')
            const relPath = rootPath ? relative(rootPath, filePath) : filePath

            for (const pattern of SECURITY_PATTERNS) {
                // Check file type filter
                if (pattern.fileTypes && !pattern.fileTypes.includes(ext)) {
                    continue
                }

                // Reset regex
                pattern.pattern.lastIndex = 0

                let match
                while ((match = pattern.pattern.exec(content)) !== null) {
                    // Find line number
                    const beforeMatch = content.slice(0, match.index)
                    const lineNumber = beforeMatch.split('\n').length

                    issues.push({
                        id: `${pattern.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        type: pattern.type,
                        severity: pattern.severity,
                        file: relPath,
                        line: lineNumber,
                        code: lines[lineNumber - 1]?.trim().slice(0, 100),
                        description: pattern.description,
                        recommendation: pattern.recommendation,
                        owaspCategory: pattern.owaspCategory,
                    })
                }
            }
        } catch (err) {
            console.error(`[L15 SecurityScanner] Error scanning ${filePath}: ${err}`)
        }

        return issues
    }

    /**
     * Check for insecure dependencies
     */
    async auditDependencies(projectPath: string): Promise<SecurityIssue[]> {
        const issues: SecurityIssue[] = []

        try {
            // Run npm audit
            const output = execSync('npm audit --json 2>/dev/null || true', {
                cwd: projectPath,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            })

            const audit = JSON.parse(output)

            if (audit.vulnerabilities) {
                for (const [pkg, vuln] of Object.entries(audit.vulnerabilities) as any) {
                    const severity = vuln.severity === 'moderate' ? 'medium' : vuln.severity

                    issues.push({
                        id: `npm-audit-${pkg}`,
                        type: 'insecure_dependency',
                        severity: severity as any,
                        file: 'package.json',
                        description: `Unsichere Dependency: ${pkg} (${vuln.via?.[0]?.title || 'Unknown vulnerability'})`,
                        recommendation: vuln.fixAvailable ? `npm audit fix` : `Prüfe manuell auf Updates`,
                        owaspCategory: 'A06:2021 - Vulnerable and Outdated Components',
                    })
                }
            }
        } catch (err) {
            console.error(`[L15 SecurityScanner] npm audit failed: ${err}`)
        }

        return issues
    }

    /**
     * Find all scannable files
     */
    private findFiles(dir: string, files: string[] = []): string[] {
        try {
            const entries = readdirSync(dir)

            for (const entry of entries) {
                if (this.excludeDirs.some(ex => entry.startsWith(ex))) continue

                const fullPath = join(dir, entry)

                try {
                    const stat = statSync(fullPath)

                    if (stat.isDirectory()) {
                        this.findFiles(fullPath, files)
                    } else if (this.includeExtensions.includes(extname(entry))) {
                        files.push(fullPath)
                    }
                } catch { }
            }
        } catch { }

        return files
    }

    /**
     * Format scan result for display
     */
    formatResult(result: ScanResult): string {
        const passIcon = result.passed ? '✅' : '❌'

        let msg = `🔒 **Security Scan ${passIcon}**\n\n`
        msg += `📁 ${result.scannedFiles} Dateien gescannt\n`
        msg += `⏱️ ${new Date(result.timestamp).toLocaleTimeString('de-DE')}\n\n`

        msg += `**Gefundene Probleme:**\n`
        msg += `• 🔴 Kritisch: ${result.summary.critical}\n`
        msg += `• 🟠 Hoch: ${result.summary.high}\n`
        msg += `• 🟡 Mittel: ${result.summary.medium}\n`
        msg += `• 🟢 Niedrig: ${result.summary.low}\n\n`

        if (result.issues.length > 0) {
            msg += `**Top Issues:**\n`
            for (const issue of result.issues.slice(0, 5)) {
                const icon = {
                    critical: '🔴',
                    high: '🟠',
                    medium: '🟡',
                    low: '🟢',
                    info: 'ℹ️',
                }[issue.severity]

                msg += `${icon} **${issue.file}${issue.line ? `:${issue.line}` : ''}**\n`
                msg += `   ${issue.description}\n`
            }

            if (result.issues.length > 5) {
                msg += `\n... und ${result.issues.length - 5} weitere`
            }
        } else {
            msg += `✅ Keine Sicherheitsprobleme gefunden!`
        }

        return msg
    }
}

// ============================================
// Singleton
// ============================================

let securityScanner: SecurityScanner | null = null

export function getSecurityScanner(): SecurityScanner {
    if (!securityScanner) {
        securityScanner = new SecurityScanner()
    }
    return securityScanner
}

export default { SecurityScanner, getSecurityScanner }
