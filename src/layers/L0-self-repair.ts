/**
 * Nova Layer 0 - Self-Repair System
 * 
 * Enables Nova to detect and fix its own code issues.
 * 
 * Features:
 * - Detect runtime errors and patterns
 * - Suggest fixes based on error patterns
 * - Auto-apply safe fixes
 * - Learn from successful repairs
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface CodeIssue {
    id: string
    file: string
    line?: number
    errorType: 'syntax' | 'runtime' | 'logic' | 'import' | 'type'
    message: string
    stackTrace?: string
    detectedAt: number
    fixedAt?: number
    fixApplied?: string
}

export interface RepairAction {
    id: string
    issueId: string
    action: 'backup' | 'patch' | 'rollback' | 'restart'
    description: string
    code?: string
    success: boolean
    timestamp: number
}

// ============================================
// Known Fix Patterns
// ============================================

const FIX_PATTERNS: Array<{
    pattern: RegExp
    fixType: string
    autoFix: boolean
    generator: (match: RegExpMatchArray, file: string, content: string) => string | null
}> = [
        // Missing import
        {
            pattern: /Cannot find module '([^']+)'/,
            fixType: 'missing_import',
            autoFix: false,
            generator: (match) => `npm install ${match[1]}`,
        },

        // Undefined variable
        {
            pattern: /(\w+) is not defined/,
            fixType: 'undefined_var',
            autoFix: false,
            generator: (match) => `Check if '${match[1]}' is imported or declared`,
        },

        // Property undefined
        {
            pattern: /Cannot read propert(?:y|ies) of undefined/,
            fixType: 'null_check',
            autoFix: false,
            generator: () => `Add null check with optional chaining (?.)`,
        },

        // Type error - flatMap
        {
            pattern: /(\w+)\.flatMap is not a function/,
            fixType: 'array_check',
            autoFix: true,
            generator: (match, file, content) => {
                // Replace .flatMap with Array.isArray check
                const varName = match[1]
                return content.replace(
                    new RegExp(`${varName}\\.flatMap\\(`),
                    `(Array.isArray(${varName}) ? ${varName} : []).flatMap(`
                )
            },
        },

        // Syntax error - unexpected token
        {
            pattern: /Unexpected token '([^']+)'/,
            fixType: 'syntax',
            autoFix: false,
            generator: (match) => `Check syntax near '${match[1]}' - likely missing bracket or semicolon`,
        },
    ]

// ============================================
// Self-Repair Engine
// ============================================

export class SelfRepairEngine {
    private issues: CodeIssue[] = []
    private repairs: RepairAction[] = []
    private backupDir: string

    constructor(dataDir: string) {
        this.backupDir = join(dataDir, 'backups')
    }

    // ============================================
    // Error Detection
    // ============================================

    detectIssue(error: Error, file?: string): CodeIssue {
        const issue: CodeIssue = {
            id: crypto.randomUUID(),
            file: file || this.extractFileFromStack(error.stack),
            errorType: this.classifyError(error),
            message: error.message,
            stackTrace: error.stack,
            detectedAt: Date.now(),
        }

        // Extract line number
        const lineMatch = error.stack?.match(/:(\d+):\d+/)
        if (lineMatch) {
            issue.line = parseInt(lineMatch[1])
        }

        this.issues.push(issue)
        console.log(`[L0 Self-Repair] Issue erkannt: ${issue.errorType} in ${issue.file}`)

        return issue
    }

    private extractFileFromStack(stack?: string): string {
        if (!stack) return 'unknown'

        const match = stack.match(/at .+ \((.+):\d+:\d+\)/) ||
            stack.match(/at (.+):\d+:\d+/)
        return match?.[1] || 'unknown'
    }

    private classifyError(error: Error): CodeIssue['errorType'] {
        const msg = error.message.toLowerCase()

        if (msg.includes('syntax') || msg.includes('unexpected token')) return 'syntax'
        if (msg.includes('cannot find module') || msg.includes('import')) return 'import'
        if (msg.includes('type') || msg.includes('is not a function')) return 'type'
        if (error.name === 'ReferenceError') return 'runtime'
        return 'logic'
    }

    // ============================================
    // Fix Generation
    // ============================================

    suggestFix(issue: CodeIssue): { fix: string; canAutoApply: boolean } | null {
        for (const pattern of FIX_PATTERNS) {
            const match = issue.message.match(pattern.pattern)
            if (match) {
                let fileContent = ''
                if (existsSync(issue.file)) {
                    fileContent = readFileSync(issue.file, 'utf-8')
                }

                const fix = pattern.generator(match, issue.file, fileContent)
                if (fix) {
                    return {
                        fix,
                        canAutoApply: pattern.autoFix,
                    }
                }
            }
        }

        return null
    }

    // ============================================
    // Auto-Repair
    // ============================================

    async autoRepair(issue: CodeIssue): Promise<RepairAction | null> {
        const suggestion = this.suggestFix(issue)
        if (!suggestion?.canAutoApply) {
            console.log(`[L0 Self-Repair] Kein Auto-Fix verfügbar für: ${issue.message}`)
            return null
        }

        if (!existsSync(issue.file)) return null
        const current = readFileSync(issue.file, 'utf-8')
        const { evolve } = await import('../synthesis/self-evolution.js')
        const outcome = await evolve({
            file: issue.file.replace(process.cwd(), '').replace(/^[\\/]+/, '').replace(/\\/g, '/'),
            description: `L0 self-repair proposal: ${issue.errorType}`,
            reason: issue.message,
            search: current,
            replace: suggestion.fix,
        })
        const proposal: RepairAction = {
            id: crypto.randomUUID(),
            issueId: issue.id,
            action: 'patch',
            description: outcome.queued
                ? `Sandbox verified; waiting at PATCH_GATE (${outcome.proposalId})`
                : `Self-repair proposal rejected: ${outcome.error || 'unknown error'}`,
            success: false,
            timestamp: Date.now(),
        }
        this.repairs.push(proposal)
        return proposal
    }

    // ============================================
    // Backup & Rollback
    // ============================================

    async backupFile(filePath: string): Promise<RepairAction> {
        const action: RepairAction = {
            id: crypto.randomUUID(),
            issueId: '',
            action: 'backup',
            description: `Backup: ${filePath}`,
            success: false,
            timestamp: Date.now(),
        }

        try {
            if (!existsSync(this.backupDir)) {
                const { mkdirSync } = await import('node:fs')
                mkdirSync(this.backupDir, { recursive: true })
            }

            const backupPath = join(
                this.backupDir,
                `${Date.now()}_${filePath.replace(/[\\/:]/g, '_')}`
            )

            copyFileSync(filePath, backupPath)
            action.success = true
            action.description = `Backup erstellt: ${backupPath}`

        } catch (err) {
            action.description = `Backup fehlgeschlagen: ${err}`
        }

        this.repairs.push(action)
        return action
    }

    async rollback(filePath: string): Promise<boolean> {
        // Find latest backup
        const backups = this.repairs
            .filter(r => r.action === 'backup' && r.description.includes(filePath) && r.success)
            .sort((a, b) => b.timestamp - a.timestamp)

        if (backups.length === 0) {
            console.log(`[L0 Self-Repair] Kein Backup gefunden für: ${filePath}`)
            return false
        }

        try {
            const latestBackup = backups[0].description.match(/Backup erstellt: (.+)/)?.[1]
            if (latestBackup && existsSync(latestBackup)) {
                copyFileSync(latestBackup, filePath)
                console.log(`[L0 Self-Repair] ✅ Rollback erfolgreich: ${filePath}`)
                return true
            }
        } catch (err) {
            console.error(`[L0 Self-Repair] ❌ Rollback fehlgeschlagen:`, err)
        }

        return false
    }

    // ============================================
    // Learning from Repairs
    // ============================================

    recordSuccessfulRepair(issue: CodeIssue, wasHelpful: boolean): void {
        if (wasHelpful) {
            // This could feed into the SkillSynthesizer for future similar issues
            console.log(`[L0 Self-Repair] Erfolgreiche Reparatur gespeichert für Lernen`)
        }
    }

    async diagnoseIssue(issue: CodeIssue): Promise<import('../intelligence/doctor-client.js').DiagnoseResult> {
        const { diagnose } = await import('../intelligence/doctor-client.js')
        return diagnose({
            error: issue.stackTrace || issue.message,
            file: issue.file,
            context: { errorType: issue.errorType },
        })
    }

    // ============================================
    // Stats
    // ============================================

    getStats() {
        return {
            totalIssues: this.issues.length,
            fixedIssues: this.issues.filter(i => i.fixedAt).length,
            totalRepairs: this.repairs.length,
            successfulRepairs: this.repairs.filter(r => r.success).length,
        }
    }

    getRecentIssues(limit = 10): CodeIssue[] {
        return this.issues
            .sort((a, b) => b.detectedAt - a.detectedAt)
            .slice(0, limit)
    }
}

// ============================================
// Global Instance
// ============================================

let repairEngine: SelfRepairEngine | null = null

export function getSelfRepairEngine(dataDir?: string): SelfRepairEngine {
    if (!repairEngine) {
        const dir = dataDir || join(process.cwd(), '.nova-repair')
        repairEngine = new SelfRepairEngine(dir)
    }
    return repairEngine
}

// ============================================
// Error Handler Integration
// ============================================

export function handleUncaughtError(error: Error): void {
    const engine = getSelfRepairEngine()
    const issue = engine.detectIssue(error)
    engine.diagnoseIssue(issue).then(result => {
        console.log(`[L0 Self-Repair] Nova Doctor: ${result.diagnosis}`)
        console.log(`[L0 Self-Repair] Vorschlag (PATCH_GATE): ${result.fix}`)
    }).catch(err => console.warn(`[L0 Self-Repair] Doctor diagnosis failed: ${err}`))

    const suggestion = engine.suggestFix(issue)
    if (suggestion) {
        console.log(`[L0 Self-Repair] Vorgeschlagener Fix: ${suggestion.fix}`)

        if (suggestion.canAutoApply) {
            engine.autoRepair(issue).catch(console.error)
        }
    }
}

export default {
    SelfRepairEngine,
    getSelfRepairEngine,
    handleUncaughtError,
}
