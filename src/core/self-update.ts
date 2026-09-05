/**
 * Self-Update Loop
 * 
 * Ermöglicht Nova, ihren eigenen Quellcode autonom zu verbessern.
 * Mit strengen Sicherheitschecks um gefährliche Änderungen zu verhindern.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

// ============================================
// Types
// ============================================

export interface SelfUpdateProposal {
    id: string
    type: 'bugfix' | 'optimization' | 'feature' | 'refactor'
    file: string
    description: string
    oldCode: string
    newCode: string
    reason: string
    confidence: number  // 0-100
    createdAt: number
    status: 'pending' | 'approved' | 'rejected' | 'applied'
}

export interface UpdateHistory {
    proposals: SelfUpdateProposal[]
    appliedCount: number
    rejectedCount: number
    lastUpdate: number
}

// ============================================
// Configuration
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const PROPOSALS_DIR = join(DATA_DIR, 'self-updates')
const HISTORY_FILE = join(PROPOSALS_DIR, 'history.json')

// Safety Limits
const MAX_LINES_CHANGED = 50
const MIN_CONFIDENCE = 80  // Minimum confidence for auto-apply
const FORBIDDEN_PATTERNS = [
    /process\.exit/i,
    /rm\s+-rf/i,
    /DELETE\s+FROM\s+\w+\s*;/i,  // DROP without WHERE
    /DROP\s+TABLE/i,
    /DROP\s+DATABASE/i,
    /eval\s*\(/i,
    /exec\s*\(/i,
    /\.env/i,  // Don't touch env files
    /config\.json/i,  // Don't touch config
    /package\.json/i,  // Don't touch package.json
    /tsconfig/i,  // Don't touch tsconfig
]

const ALLOWED_DIRECTORIES = [
    'src/memory/',
    'src/intelligence/',
    'src/layers/',
    'src/tools/',
    'src/core/',
]

// ============================================
// State
// ============================================

let history: UpdateHistory = {
    proposals: [],
    appliedCount: 0,
    rejectedCount: 0,
    lastUpdate: Date.now(),
}

// ============================================
// Initialization
// ============================================

function ensureInitialized(): void {
    if (!existsSync(PROPOSALS_DIR)) {
        mkdirSync(PROPOSALS_DIR, { recursive: true })
    }

    if (existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        } catch {
            console.warn('[Self-Update] Could not load history, starting fresh')
        }
    }
}

function saveHistory(): void {
    ensureInitialized()
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

// ============================================
// Safety Checks
// ============================================

/**
 * Prüft ob eine Änderung sicher ist
 */
function isSafeChange(proposal: SelfUpdateProposal): { safe: boolean; reason?: string } {
    // Check file path is in allowed directory
    const isAllowedPath = ALLOWED_DIRECTORIES.some(dir => proposal.file.includes(dir))
    if (!isAllowedPath) {
        return { safe: false, reason: `Datei nicht in erlaubtem Verzeichnis: ${proposal.file}` }
    }

    // Check for forbidden patterns
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(proposal.newCode)) {
            return { safe: false, reason: `Verbotenes Pattern gefunden: ${pattern.source}` }
        }
    }

    // Check lines changed
    const oldLines = proposal.oldCode.split('\n').length
    const newLines = proposal.newCode.split('\n').length
    const linesDiff = Math.abs(newLines - oldLines)

    if (linesDiff > MAX_LINES_CHANGED) {
        return { safe: false, reason: `Zu viele Zeilen geändert: ${linesDiff} > ${MAX_LINES_CHANGED}` }
    }

    // Check confidence
    if (proposal.confidence < MIN_CONFIDENCE) {
        return { safe: false, reason: `Confidence zu niedrig: ${proposal.confidence}% < ${MIN_CONFIDENCE}%` }
    }

    return { safe: true }
}

/**
 * Validiert dass die Änderung compiliert
 */
function validateCompiles(): boolean {
    try {
        execSync('npm run build', {
            cwd: process.cwd(),
            stdio: 'pipe',
            timeout: 60000,
        })
        return true
    } catch {
        return false
    }
}

// ============================================
// Core Functions
// ============================================

/**
 * Erstellt einen Update-Vorschlag
 */
export function proposeUpdate(
    file: string,
    type: SelfUpdateProposal['type'],
    description: string,
    oldCode: string,
    newCode: string,
    reason: string,
    confidence: number
): SelfUpdateProposal {
    ensureInitialized()

    const proposal: SelfUpdateProposal = {
        id: `update_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        file,
        description,
        oldCode,
        newCode,
        reason,
        confidence: Math.max(0, Math.min(100, confidence)),
        createdAt: Date.now(),
        status: 'pending',
    }

    history.proposals.push(proposal)
    saveHistory()

    console.log(`[Self-Update] 📝 Neuer Vorschlag: ${description}`)
    console.log(`[Self-Update] Confidence: ${confidence}%, Type: ${type}`)

    return proposal
}

/**
 * Wendet einen Update-Vorschlag an (mit Sicherheitschecks)
 */
export async function applyUpdate(proposalId: string, force: boolean = false): Promise<{
    success: boolean
    message: string
}> {
    ensureInitialized()

    const proposal = history.proposals.find(p => p.id === proposalId)
    if (!proposal) {
        return { success: false, message: `Vorschlag nicht gefunden: ${proposalId}` }
    }

    if (proposal.status === 'applied') {
        return { success: false, message: 'Vorschlag bereits angewendet' }
    }

    // Safety check
    if (!force) {
        const safety = isSafeChange(proposal)
        if (!safety.safe) {
            proposal.status = 'rejected'
            history.rejectedCount++
            saveHistory()
            return { success: false, message: `Sicherheitscheck fehlgeschlagen: ${safety.reason}` }
        }
    }

    // Read current file
    const fullPath = join(process.cwd(), proposal.file)
    if (!existsSync(fullPath)) {
        return { success: false, message: `Datei nicht gefunden: ${fullPath}` }
    }

    const currentContent = readFileSync(fullPath, 'utf-8')

    // Check if old code still exists
    if (!currentContent.includes(proposal.oldCode)) {
        proposal.status = 'rejected'
        saveHistory()
        return { success: false, message: 'Original-Code nicht mehr vorhanden (bereits geändert?)' }
    }

    // Create backup
    const backupPath = fullPath + `.backup.${Date.now()}`
    writeFileSync(backupPath, currentContent)

    // Apply change
    const newContent = currentContent.replace(proposal.oldCode, proposal.newCode)
    writeFileSync(fullPath, newContent)

    // Validate it compiles
    if (!validateCompiles()) {
        // Rollback
        writeFileSync(fullPath, currentContent)
        proposal.status = 'rejected'
        history.rejectedCount++
        saveHistory()
        return { success: false, message: 'Änderung verursacht Build-Fehler, rollback durchgeführt' }
    }

    // Success!
    proposal.status = 'applied'
    history.appliedCount++
    history.lastUpdate = Date.now()
    saveHistory()

    console.log(`[Self-Update] ✅ Update angewendet: ${proposal.description}`)

    return { success: true, message: `Update angewendet: ${proposal.description}` }
}

/**
 * Commitet und pusht Änderungen zu GitHub
 */
export async function commitAndPush(message: string): Promise<{
    success: boolean
    message: string
}> {
    try {
        // Stage all changes
        execSync('git add -A', { cwd: process.cwd(), stdio: 'pipe' })

        // Commit with [Nova Auto] prefix
        const commitMessage = `[Nova Auto] ${message}`
        execSync(`git commit -m "${commitMessage}"`, { cwd: process.cwd(), stdio: 'pipe' })

        // Push
        execSync('git push', { cwd: process.cwd(), stdio: 'pipe' })

        console.log(`[Self-Update] 🚀 Gepusht: ${commitMessage}`)

        return { success: true, message: `Committed and pushed: ${commitMessage}` }
    } catch (err) {
        console.error(`[Self-Update] Push fehlgeschlagen: ${err}`)
        return { success: false, message: `Git-Fehler: ${err}` }
    }
}

/**
 * Vollständiger Auto-Update Zyklus
 */
export async function autoUpdate(
    file: string,
    type: SelfUpdateProposal['type'],
    description: string,
    oldCode: string,
    newCode: string,
    reason: string,
    confidence: number
): Promise<{
    success: boolean
    message: string
    proposalId?: string
}> {
    // Create proposal
    const proposal = proposeUpdate(file, type, description, oldCode, newCode, reason, confidence)

    // Try to apply
    const applyResult = await applyUpdate(proposal.id)

    if (!applyResult.success) {
        return {
            success: false,
            message: applyResult.message,
            proposalId: proposal.id,
        }
    }

    // Commit and push
    const pushResult = await commitAndPush(`${type}: ${description}`)

    return {
        success: pushResult.success,
        message: pushResult.success
            ? `✅ Self-Update erfolgreich: ${description}`
            : `Update angewendet, aber Push fehlgeschlagen: ${pushResult.message}`,
        proposalId: proposal.id,
    }
}

// ============================================
// Query Functions
// ============================================

/**
 * Gibt alle ausstehenden Vorschläge zurück
 */
export function getPendingProposals(): SelfUpdateProposal[] {
    ensureInitialized()
    return history.proposals.filter(p => p.status === 'pending')
}

/**
 * Gibt Update-Statistiken zurück
 */
export function getStats(): {
    pending: number
    applied: number
    rejected: number
    total: number
    lastUpdate: number
} {
    ensureInitialized()
    return {
        pending: history.proposals.filter(p => p.status === 'pending').length,
        applied: history.appliedCount,
        rejected: history.rejectedCount,
        total: history.proposals.length,
        lastUpdate: history.lastUpdate,
    }
}

/**
 * Lehnt einen Vorschlag ab
 */
export function rejectProposal(proposalId: string, reason?: string): boolean {
    ensureInitialized()

    const proposal = history.proposals.find(p => p.id === proposalId)
    if (!proposal || proposal.status !== 'pending') {
        return false
    }

    proposal.status = 'rejected'
    history.rejectedCount++
    saveHistory()

    console.log(`[Self-Update] ❌ Vorschlag abgelehnt: ${proposal.description}${reason ? ` (${reason})` : ''}`)

    return true
}

// ============================================
// Export
// ============================================

export default {
    proposeUpdate,
    applyUpdate,
    commitAndPush,
    autoUpdate,
    getPendingProposals,
    getStats,
    rejectProposal,
}
