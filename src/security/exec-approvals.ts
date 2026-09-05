/**
 * Nova Exec-Approvals System
 *
 * Safety layer that validates commands before execution.
 * Inspired by OpenClaw's exec-approvals (87KB+ across 5 files).
 *
 * Features:
 * - Dangerous command detection
 * - Allowlist/blocklist management
 * - Approval history logging
 * - Risk scoring
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical'

export interface ApprovalRequest {
    command: string
    args?: string[]
    cwd?: string
    source: string           // Who requested: 'user', 'tool', 'self-evolution', 'plugin'
    timestamp: number
}

export interface ApprovalResult {
    approved: boolean
    risk: RiskLevel
    reason: string
    requiresUserConfirm?: boolean
    matchedRule?: string
}

interface ApprovalRule {
    pattern: string          // Regex pattern
    action: 'allow' | 'deny' | 'confirm'
    risk: RiskLevel
    reason: string
}

interface ApprovalLogEntry {
    timestamp: number
    request: ApprovalRequest
    result: ApprovalResult
}

// ============================================
// Configuration
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const RULES_FILE = join(DATA_DIR, 'exec-rules.json')
const HISTORY_FILE = join(DATA_DIR, 'exec-history.json')

// ============================================
// Built-in Dangerous Patterns (like OpenClaw's dangerous-tools.ts)
// ============================================

const DANGEROUS_PATTERNS: ApprovalRule[] = [
    // Critical — never auto-approve
    { pattern: 'rm\\s+-rf\\s+/', action: 'deny', risk: 'critical', reason: 'Rekursives Löschen ab Root — extrem gefährlich' },
    { pattern: 'rm\\s+-rf\\s+~', action: 'deny', risk: 'critical', reason: 'Rekursives Löschen im Home-Verzeichnis' },
    { pattern: 'mkfs', action: 'deny', risk: 'critical', reason: 'Dateisystem formatieren' },
    { pattern: ':(){:|:&};:', action: 'deny', risk: 'critical', reason: 'Fork Bomb erkannt' },
    { pattern: 'dd\\s+if=.*of=/dev/', action: 'deny', risk: 'critical', reason: 'Direktes Schreiben auf Block-Device' },
    { pattern: 'format\\s+[a-zA-Z]:', action: 'deny', risk: 'critical', reason: 'Windows-Laufwerk formatieren' },
    { pattern: '> /dev/sda', action: 'deny', risk: 'critical', reason: 'Direktes Schreiben auf Festplatte' },
    { pattern: 'chmod\\s+-R\\s+777\\s+/', action: 'deny', risk: 'critical', reason: 'Rekursive Permission-Änderung ab Root' },

    // High risk — require confirmation
    { pattern: 'rm\\s+-rf', action: 'confirm', risk: 'high', reason: 'Rekursives Löschen — bitte bestätigen' },
    { pattern: 'rm\\s+-r', action: 'confirm', risk: 'high', reason: 'Rekursives Löschen — bitte bestätigen' },
    { pattern: 'sudo\\s+rm', action: 'confirm', risk: 'high', reason: 'Root-Löschung — bitte bestätigen' },
    { pattern: 'DROP\\s+DATABASE', action: 'confirm', risk: 'high', reason: 'Datenbank löschen — bitte bestätigen' },
    { pattern: 'DROP\\s+TABLE', action: 'confirm', risk: 'high', reason: 'Tabelle löschen — bitte bestätigen' },
    { pattern: 'TRUNCATE', action: 'confirm', risk: 'high', reason: 'Tabelle leeren — bitte bestätigen' },
    { pattern: 'shutdown', action: 'confirm', risk: 'high', reason: 'System herunterfahren — bitte bestätigen' },
    { pattern: 'reboot', action: 'confirm', risk: 'high', reason: 'System neustarten — bitte bestätigen' },
    { pattern: 'init\\s+0', action: 'confirm', risk: 'high', reason: 'System herunterfahren — bitte bestätigen' },
    { pattern: 'systemctl\\s+stop', action: 'confirm', risk: 'high', reason: 'Service stoppen — bitte bestätigen' },
    { pattern: 'kill\\s+-9', action: 'confirm', risk: 'high', reason: 'Force-Kill — bitte bestätigen' },
    { pattern: 'taskkill\\s+/F', action: 'confirm', risk: 'high', reason: 'Force-Kill — bitte bestätigen' },

    // Medium risk — warn
    { pattern: 'npm\\s+publish', action: 'confirm', risk: 'medium', reason: 'Paket veröffentlichen — bitte bestätigen' },
    { pattern: 'git\\s+push.*--force', action: 'confirm', risk: 'medium', reason: 'Force-Push — bitte bestätigen' },
    { pattern: 'git\\s+reset\\s+--hard', action: 'confirm', risk: 'medium', reason: 'Hard-Reset verliert Änderungen' },
    { pattern: 'docker\\s+system\\s+prune', action: 'confirm', risk: 'medium', reason: 'Docker aufräumen — bitte bestätigen' },
    { pattern: 'pip\\s+install', action: 'confirm', risk: 'medium', reason: 'Python-Paket installieren' },
    { pattern: 'npm\\s+install\\s+-g', action: 'confirm', risk: 'medium', reason: 'Globales npm-Paket installieren' },
    { pattern: 'curl.*\\|\\s*(bash|sh)', action: 'confirm', risk: 'medium', reason: 'Script aus dem Internet ausführen' },
    { pattern: 'wget.*\\|\\s*(bash|sh)', action: 'confirm', risk: 'medium', reason: 'Script aus dem Internet ausführen' },

    // Low risk — allow with note
    { pattern: 'npm\\s+install', action: 'allow', risk: 'low', reason: 'Lokale npm-Installation' },
    { pattern: 'git\\s+(add|commit|status|log|diff)', action: 'allow', risk: 'safe', reason: 'Standard Git-Operation' },
    { pattern: 'ls|dir|pwd|cd|echo|cat|head|tail|grep|find', action: 'allow', risk: 'safe', reason: 'Lese-Operation' },
    { pattern: 'node|npm\\s+run|npx|tsc', action: 'allow', risk: 'safe', reason: 'Node.js-Ausführung' },
]

// ============================================
// Core Logic
// ============================================

export function evaluateCommand(request: ApprovalRequest): ApprovalResult {
    const fullCommand = [request.command, ...(request.args || [])].join(' ')

    // Check custom rules first
    const customRules = loadCustomRules()
    for (const rule of customRules) {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(fullCommand)) {
            const result: ApprovalResult = {
                approved: rule.action === 'allow',
                risk: rule.risk,
                reason: rule.reason,
                requiresUserConfirm: rule.action === 'confirm',
                matchedRule: `custom: ${rule.pattern}`,
            }
            logApproval(request, result)
            return result
        }
    }

    // Check built-in patterns
    for (const pattern of DANGEROUS_PATTERNS) {
        const regex = new RegExp(pattern.pattern, 'i')
        if (regex.test(fullCommand)) {
            const result: ApprovalResult = {
                approved: pattern.action === 'allow',
                risk: pattern.risk,
                reason: pattern.reason,
                requiresUserConfirm: pattern.action === 'confirm',
                matchedRule: `builtin: ${pattern.pattern}`,
            }
            logApproval(request, result)
            return result
        }
    }

    // Default: allow with low risk
    const result: ApprovalResult = {
        approved: true,
        risk: 'low',
        reason: 'Kein bekanntes Risiko-Muster erkannt',
    }
    logApproval(request, result)
    return result
}

// ============================================
// Custom Rules
// ============================================

function loadCustomRules(): ApprovalRule[] {
    if (!existsSync(RULES_FILE)) return []
    try {
        return JSON.parse(readFileSync(RULES_FILE, 'utf-8'))
    } catch {
        return []
    }
}

export function addCustomRule(rule: ApprovalRule): void {
    const rules = loadCustomRules()
    rules.push(rule)
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2))
}

export function removeCustomRule(pattern: string): boolean {
    const rules = loadCustomRules()
    const filtered = rules.filter(r => r.pattern !== pattern)
    if (filtered.length === rules.length) return false
    writeFileSync(RULES_FILE, JSON.stringify(filtered, null, 2))
    return true
}

export function listRules(): { builtin: ApprovalRule[]; custom: ApprovalRule[] } {
    return {
        builtin: DANGEROUS_PATTERNS,
        custom: loadCustomRules(),
    }
}

// ============================================
// Logging
// ============================================

function logApproval(request: ApprovalRequest, result: ApprovalResult): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    let history: ApprovalLogEntry[] = []
    if (existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        } catch { /* fresh */ }
    }

    history.push({ timestamp: Date.now(), request, result })
    if (history.length > 200) history = history.slice(-200)

    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

export function getApprovalHistory(limit = 20): ApprovalLogEntry[] {
    if (!existsSync(HISTORY_FILE)) return []
    try {
        const history: ApprovalLogEntry[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        return history.slice(-limit)
    } catch {
        return []
    }
}

export function getApprovalStats(): {
    total: number
    approved: number
    denied: number
    confirmRequired: number
    riskBreakdown: Record<RiskLevel, number>
} {
    const history = getApprovalHistory(200)
    const stats = {
        total: history.length,
        approved: history.filter(h => h.result.approved).length,
        denied: history.filter(h => !h.result.approved).length,
        confirmRequired: history.filter(h => h.result.requiresUserConfirm).length,
        riskBreakdown: {
            safe: 0, low: 0, medium: 0, high: 0, critical: 0,
        } as Record<RiskLevel, number>,
    }

    for (const entry of history) {
        stats.riskBreakdown[entry.result.risk]++
    }

    return stats
}

export default {
    evaluateCommand,
    addCustomRule,
    removeCustomRule,
    listRules,
    getApprovalHistory,
    getApprovalStats,
}
