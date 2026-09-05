/**
 * Nova Auto-Update System
 *
 * Self-updating mechanism:
 * - Check for updates (git fetch + compare)
 * - Pull updates (git pull)
 * - Rebuild (npm install + tsc)
 * - Restart (via self-management)
 *
 * Inspired by OpenClaw's update-runner (66KB+ across 5 files)
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface UpdateCheckResult {
    updateAvailable: boolean
    currentCommit: string
    remoteCommit: string
    behind: number
    ahead: number
    branch: string
    lastCheck: number
}

export interface UpdateResult {
    success: boolean
    previousCommit: string
    newCommit: string
    changes: string[]
    buildSuccess: boolean
    error?: string
    duration: number
}

interface UpdateLogEntry {
    timestamp: number
    type: 'check' | 'update'
    result: UpdateCheckResult | UpdateResult
}

// ============================================
// Configuration
// ============================================

const NOVA_DIR = process.cwd()
const DATA_DIR = join(NOVA_DIR, '.nova-data')
const UPDATE_LOG_FILE = join(DATA_DIR, 'update-log.json')
const UPDATE_TIMEOUT = 120_000 // 2 minutes for build

// ============================================
// Git Helpers
// ============================================

function git(cmd: string, timeout = 15_000): string {
    return execSync(`git ${cmd}`, {
        cwd: NOVA_DIR,
        encoding: 'utf-8',
        timeout,
    }).trim()
}

function getCommitHash(): string {
    return git('rev-parse HEAD')
}

function getBranch(): string {
    return git('branch --show-current')
}

// ============================================
// Core Functions
// ============================================

/**
 * Check if updates are available (git fetch + compare)
 */
export function checkForUpdates(): UpdateCheckResult {
    const branch = getBranch()

    // Fetch latest from remote
    try {
        git('fetch origin', 30_000)
    } catch {
        // May fail if no remote, continue with local info
    }

    const currentCommit = getCommitHash()
    let remoteCommit = currentCommit
    let behind = 0
    let ahead = 0

    try {
        remoteCommit = git(`rev-parse origin/${branch}`)
        const revList = git(`rev-list --left-right --count origin/${branch}...HEAD`)
        const parts = revList.split(/\s+/)
        behind = parseInt(parts[0] || '0')
        ahead = parseInt(parts[1] || '0')
    } catch {
        // No remote tracking branch
    }

    const result: UpdateCheckResult = {
        updateAvailable: behind > 0,
        currentCommit: currentCommit.slice(0, 8),
        remoteCommit: remoteCommit.slice(0, 8),
        behind,
        ahead,
        branch,
        lastCheck: Date.now(),
    }

    logUpdate({ timestamp: Date.now(), type: 'check', result })
    return result
}

/**
 * Pull updates, rebuild, and prepare for restart
 */
export async function pullAndRebuild(): Promise<UpdateResult> {
    const startTime = Date.now()
    const previousCommit = getCommitHash().slice(0, 8)

    try {
        // Step 1: Stash local changes
        const hasChanges = git('status --porcelain').length > 0
        if (hasChanges) {
            git('stash push -m "nova-auto-update-stash"')
        }

        // Step 2: Pull
        console.log('[AutoUpdate] 📥 Pulling updates...')
        git('pull origin ' + getBranch(), 60_000)

        const newCommit = getCommitHash().slice(0, 8)

        // Step 3: Get changed files
        const changesOutput = git(`log --oneline ${previousCommit}..${newCommit}`)
        const changes = changesOutput.split('\n').filter(Boolean)

        // Step 4: Install dependencies if package.json changed
        const packageChanged = changes.some(c => c.includes('package'))
        if (packageChanged) {
            console.log('[AutoUpdate] 📦 Installing dependencies...')
            execSync('npm install', {
                cwd: NOVA_DIR,
                encoding: 'utf-8',
                timeout: UPDATE_TIMEOUT,
            })
        }

        // Step 5: Build
        console.log('[AutoUpdate] 🔨 Building...')
        execSync('npx tsc', {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: UPDATE_TIMEOUT,
        })

        // Step 6: Restore stash
        if (hasChanges) {
            try { git('stash pop') } catch { /* conflict, non-critical */ }
        }

        const result: UpdateResult = {
            success: true,
            previousCommit,
            newCommit,
            changes,
            buildSuccess: true,
            duration: Date.now() - startTime,
        }

        logUpdate({ timestamp: Date.now(), type: 'update', result })
        console.log(`[AutoUpdate] ✅ Update erfolgreich! ${previousCommit} → ${newCommit} (${result.duration}ms)`)
        return result

    } catch (err: any) {
        // Rollback
        try { git(`reset --hard ${previousCommit}`) } catch { /* ignore */ }

        const result: UpdateResult = {
            success: false,
            previousCommit,
            newCommit: previousCommit,
            changes: [],
            buildSuccess: false,
            error: err.message,
            duration: Date.now() - startTime,
        }

        logUpdate({ timestamp: Date.now(), type: 'update', result })
        console.log(`[AutoUpdate] ❌ Update fehlgeschlagen: ${err.message}`)
        return result
    }
}

/**
 * Get current version info
 */
export function getVersionInfo(): {
    commit: string
    branch: string
    date: string
    message: string
    tag?: string
} {
    const commit = getCommitHash().slice(0, 8)
    const branch = getBranch()
    const date = git('log -1 --format=%ci')
    const message = git('log -1 --format=%s')

    let tag: string | undefined
    try {
        tag = git('describe --tags --abbrev=0 2>/dev/null')
    } catch { /* no tags */ }

    return { commit, branch, date, message, tag }
}

// ============================================
// Logging
// ============================================

function logUpdate(entry: UpdateLogEntry): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    let log: UpdateLogEntry[] = []
    if (existsSync(UPDATE_LOG_FILE)) {
        try {
            log = JSON.parse(readFileSync(UPDATE_LOG_FILE, 'utf-8'))
        } catch { /* fresh */ }
    }

    log.push(entry)
    if (log.length > 50) log = log.slice(-50)

    writeFileSync(UPDATE_LOG_FILE, JSON.stringify(log, null, 2))
}

export function getUpdateHistory(limit = 10): UpdateLogEntry[] {
    if (!existsSync(UPDATE_LOG_FILE)) return []
    try {
        const log: UpdateLogEntry[] = JSON.parse(readFileSync(UPDATE_LOG_FILE, 'utf-8'))
        return log.slice(-limit)
    } catch {
        return []
    }
}

export default {
    checkForUpdates,
    pullAndRebuild,
    getVersionInfo,
    getUpdateHistory,
}
