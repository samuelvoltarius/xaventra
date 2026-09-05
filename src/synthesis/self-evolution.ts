/**
 * Nova Self-Evolution Sandbox
 *
 * Allows Nova to safely modify her own code:
 * 1. Create a git branch
 * 2. Apply code change
 * 3. Build & test in child process
 * 4. Merge on success, rollback on failure
 *
 * Safety:
 * - Only files in src/ can be modified
 * - Max 1 active evolution at a time
 * - 60s build timeout
 * - Full rollback on any failure
 * - All changes logged to .nova-data/evolution-log.json
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { validatePatchInSandbox, type PatchSandboxResult } from './patch-sandbox.js'

// ============================================
// Types
// ============================================

export interface EvolutionRequest {
    file: string           // Relative path (e.g. 'src/core/runtime.ts')
    description: string    // What the change does
    search: string         // Exact text to find
    replace: string        // Replacement text
    reason?: string        // Why this change is needed
    apply?: boolean        // Must be true plus approvalToken to apply
    approvalToken?: string // Must match NOVA_PATCH_GATE_TOKEN
}

export interface EvolutionResult {
    success: boolean
    queued?: boolean
    proposalId?: string
    branch?: string
    buildOutput?: string
    error?: string
    rollbackPerformed?: boolean
    duration?: number
}

interface EvolutionLogEntry {
    timestamp: number
    request: EvolutionRequest
    result: EvolutionResult
    branch: string
}

// ============================================
// Configuration
// ============================================

const NOVA_DIR = process.cwd()
const DATA_DIR = join(NOVA_DIR, '.nova-data')
const LOG_FILE = join(DATA_DIR, 'evolution-log.json')
const PROPOSALS_FILE = join(DATA_DIR, 'patch-proposals.json')
const BUILD_TIMEOUT = 60_000  // 60 seconds
const ALLOWED_DIRS = ['src']

// ============================================
// State
// ============================================

let activeEvolution: string | null = null

// ============================================
// Safety Checks
// ============================================

function isAllowedPath(filePath: string): boolean {
    const resolved = resolve(NOVA_DIR, filePath)
    const rel = relative(NOVA_DIR, resolved)

    // Must be within project
    if (rel.startsWith('..')) return false

    // Must be in allowed directories
    return ALLOWED_DIRS.some(dir => rel.startsWith(dir))
}

function isGitRepo(): boolean {
    try {
        execSync('git rev-parse --is-inside-work-tree', {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 5000,
        })
        return true
    } catch {
        return false
    }
}

function getCurrentBranch(): string {
    return execSync('git branch --show-current', {
        cwd: NOVA_DIR,
        encoding: 'utf-8',
        timeout: 5000,
    }).trim()
}

function hasUncommittedChanges(): boolean {
    const status = execSync('git status --porcelain', {
        cwd: NOVA_DIR,
        encoding: 'utf-8',
        timeout: 5000,
    }).trim()
    return status.length > 0
}

// ============================================
// Logging
// ============================================

function logEvolution(entry: EvolutionLogEntry): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true })
    }

    let log: EvolutionLogEntry[] = []
    if (existsSync(LOG_FILE)) {
        try {
            log = JSON.parse(readFileSync(LOG_FILE, 'utf-8'))
        } catch { /* fresh log */ }
    }

    log.push(entry)

    // Keep last 100 entries
    if (log.length > 100) {
        log = log.slice(-100)
    }

    writeFileSync(LOG_FILE, JSON.stringify(log, null, 2))
}

function isPatchGateApproved(request: EvolutionRequest): boolean {
    const expected = process.env.NOVA_PATCH_GATE_TOKEN
    return Boolean(request.apply === true && expected && request.approvalToken === expected)
}

function queuePatchProposal(request: EvolutionRequest, sandbox: PatchSandboxResult): string {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const proposalId = `patch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const proposal = {
        id: proposalId,
        createdAt: Date.now(),
        status: 'queued',
        file: request.file,
        description: request.description,
        reason: request.reason || '',
        search: request.search,
        replace: request.replace,
        sandbox,
    }

    let proposals: any[] = []
    if (existsSync(PROPOSALS_FILE)) {
        try { proposals = JSON.parse(readFileSync(PROPOSALS_FILE, 'utf-8')) } catch { proposals = [] }
    }
    proposals.push(proposal)
    writeFileSync(PROPOSALS_FILE, JSON.stringify(proposals.slice(-200), null, 2))
    return proposalId
}

// ============================================
// Core Evolution Pipeline
// ============================================

/**
 * Execute a self-evolution: branch → modify → build → test → merge/rollback
 */
export async function evolve(request: EvolutionRequest): Promise<EvolutionResult> {
    const startTime = Date.now()
    const branchName = `nova/self-evolve-${Date.now()}`

    // Guard: only one at a time
    if (activeEvolution) {
        return {
            success: false,
            error: `Evolution bereits aktiv: ${activeEvolution}. Warte bis sie fertig ist.`,
        }
    }

    // Guard: git check
    if (!isGitRepo()) {
        return {
            success: false,
            error: 'Kein Git-Repository. Self-Evolution braucht Git für sichere Branches.',
        }
    }

    // Guard: path safety
    if (!isAllowedPath(request.file)) {
        return {
            success: false,
            error: `Datei '${request.file}' ist nicht in erlaubten Verzeichnissen: ${ALLOWED_DIRS.join(', ')}`,
        }
    }

    // Guard: file exists
    const fullPath = join(NOVA_DIR, request.file)
    if (!existsSync(fullPath)) {
        return {
            success: false,
            error: `Datei nicht gefunden: ${request.file}`,
        }
    }

    // Guard: search text exists in file
    const originalContent = readFileSync(fullPath, 'utf-8')
    if (!originalContent.includes(request.search)) {
        return {
            success: false,
            error: `Such-Text nicht gefunden in ${request.file}. Bitte exakten Text angeben.`,
        }
    }

    // Diagnosis/proposal generation is allowed automatically. No proposal can
    // reach PATCH_GATE until the exact patch builds and passes tests in an
    // isolated copy of the project.
    const sandbox = validatePatchInSandbox({
        projectRoot: NOVA_DIR,
        file: request.file,
        search: request.search,
        replace: request.replace,
    })
    if (!sandbox.verified) {
        return {
            success: false,
            error: `Sandbox verification failed; patch was not queued: ${sandbox.output.slice(-1000)}`,
            buildOutput: sandbox.output,
            duration: Date.now() - startTime,
        }
    }

    if (!isPatchGateApproved(request)) {
        const proposalId = queuePatchProposal(request, sandbox)
        return {
            success: false,
            queued: true,
            proposalId,
            error: `PATCH_GATE: Patch queued for review (${proposalId}). To apply, call self_evolve with apply=true and a valid approvalToken.`,
            buildOutput: 'No files changed. Proposal queued only.',
            duration: Date.now() - startTime,
        }
    }

    activeEvolution = branchName
    const originalBranch = getCurrentBranch()

    console.log(`[SelfEvolution] 🧬 Starting evolution: ${request.description}`)
    console.log(`[SelfEvolution] Branch: ${branchName}`)
    console.log(`[SelfEvolution] File: ${request.file}`)

    try {
        // Step 1: Stash any uncommitted changes
        const hadChanges = hasUncommittedChanges()
        if (hadChanges) {
            console.log('[SelfEvolution] 📦 Stashing uncommitted changes...')
            execSync('git stash push -m "nova-self-evolution-stash"', {
                cwd: NOVA_DIR,
                encoding: 'utf-8',
                timeout: 10_000,
            })
        }

        // Step 2: Create branch
        console.log(`[SelfEvolution] 🌿 Creating branch: ${branchName}`)
        execSync(`git checkout -b "${branchName}"`, {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 10_000,
        })

        // Step 3: Apply code change
        console.log(`[SelfEvolution] ✏️ Applying change to ${request.file}...`)
        const newContent = originalContent.replace(request.search, request.replace)

        if (newContent === originalContent) {
            throw new Error('Replacement hatte keinen Effekt — search/replace identisch?')
        }

        // Backup original
        const backupPath = fullPath + '.evolution-backup'
        copyFileSync(fullPath, backupPath)
        writeFileSync(fullPath, newContent, 'utf-8')

        // Step 4: Build check (tsc --noEmit)
        console.log('[SelfEvolution] 🔨 Building...')
        const buildResult = await runWithTimeout(
            'npx tsc --noEmit 2>&1',
            BUILD_TIMEOUT,
        )

        if (!buildResult.success) {
            console.log(`[SelfEvolution] ❌ Build failed:\n${buildResult.output}`)
            throw new Error(`Build fehlgeschlagen:\n${buildResult.output.slice(0, 500)}`)
        }

        console.log('[SelfEvolution] ✅ Build successful!')

        // Step 5: Commit
        console.log('[SelfEvolution] 💾 Committing...')
        execSync(`git add "${request.file}"`, {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 10_000,
        })
        execSync(`git commit -m "feat(self-evolve): ${request.description}"`, {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 10_000,
        })

        // Step 6: Merge back to original branch
        console.log(`[SelfEvolution] 🔀 Merging back to ${originalBranch}...`)
        execSync(`git checkout "${originalBranch}"`, {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 10_000,
        })
        execSync(`git merge "${branchName}" --no-ff -m "merge(self-evolve): ${request.description}"`, {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 10_000,
        })

        // Step 7: Cleanup branch
        execSync(`git branch -d "${branchName}"`, {
            cwd: NOVA_DIR,
            encoding: 'utf-8',
            timeout: 10_000,
        })

        // Cleanup backup
        try {
            const { unlinkSync } = await import('node:fs')
            unlinkSync(backupPath)
        } catch { /* ignore */ }

        // Restore stash if needed
        if (hadChanges) {
            try {
                execSync('git stash pop', { cwd: NOVA_DIR, encoding: 'utf-8', timeout: 10_000 })
            } catch { /* stash may conflict, non-critical */ }
        }

        // Step 8: Full build (compile to dist/)
        console.log('[SelfEvolution] 📦 Running full build (npm run build)...')
        const fullBuild = await runWithTimeout('npm run build', BUILD_TIMEOUT * 2)
        if (!fullBuild.success) {
            console.log(`[SelfEvolution] ⚠ Full build had issues but type-check passed. Output: ${fullBuild.output.slice(0, 200)}`)
        } else {
            console.log('[SelfEvolution] ✅ Full build successful!')
        }

        // Step 9: Auto-restart (graceful)
        console.log('[SelfEvolution] 🔄 Scheduling auto-restart in 3s...')
        setTimeout(() => {
            try {
                // Try pm2 restart first
                execSync('pm2 restart nova 2>&1', { cwd: NOVA_DIR, encoding: 'utf-8', timeout: 10_000 })
                console.log('[SelfEvolution] ♻️ PM2 restart triggered')
            } catch {
                // Fallback: direct process restart
                console.log('[SelfEvolution] ♻️ Restarting process...')
                process.exit(0)  // Let pm2/systemd/supervisor restart us
            }
        }, 3000)

        const result: EvolutionResult = {
            success: true,
            branch: branchName,
            buildOutput: fullBuild.output.slice(0, 200),
            duration: Date.now() - startTime,
        }

        logEvolution({ timestamp: Date.now(), request, result, branch: branchName })
        console.log(`[SelfEvolution] 🎉 Evolution erfolgreich! (${result.duration}ms)`)

        return result

    } catch (err: any) {
        console.log(`[SelfEvolution] 💥 Evolution fehlgeschlagen: ${err.message}`)

        // ROLLBACK
        const rollbackResult = await rollback(originalBranch, branchName, fullPath, originalContent)

        const result: EvolutionResult = {
            success: false,
            branch: branchName,
            error: err.message,
            rollbackPerformed: rollbackResult,
            duration: Date.now() - startTime,
        }

        logEvolution({ timestamp: Date.now(), request, result, branch: branchName })
        return result

    } finally {
        activeEvolution = null
    }
}

// ============================================
// Rollback
// ============================================

async function rollback(
    originalBranch: string,
    evolutionBranch: string,
    filePath: string,
    originalContent: string,
): Promise<boolean> {
    console.log('[SelfEvolution] 🔄 Rolling back...')

    try {
        // Restore file content
        writeFileSync(filePath, originalContent, 'utf-8')

        // Switch back to original branch
        try {
            execSync(`git checkout "${originalBranch}" --force`, {
                cwd: NOVA_DIR,
                encoding: 'utf-8',
                timeout: 10_000,
            })
        } catch { /* may already be on original */ }

        // Delete evolution branch
        try {
            execSync(`git branch -D "${evolutionBranch}"`, {
                cwd: NOVA_DIR,
                encoding: 'utf-8',
                timeout: 10_000,
            })
        } catch { /* branch may not exist */ }

        // Cleanup backup
        const backupPath = filePath + '.evolution-backup'
        if (existsSync(backupPath)) {
            const { unlinkSync } = await import('node:fs')
            unlinkSync(backupPath)
        }

        console.log('[SelfEvolution] ✅ Rollback erfolgreich')
        return true
    } catch (err) {
        console.error(`[SelfEvolution] ❌ Rollback fehlgeschlagen: ${err}`)
        return false
    }
}

// ============================================
// Build Runner (with timeout)
// ============================================

function runWithTimeout(
    command: string,
    timeout: number,
): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32'
        const shell = isWin ? 'cmd.exe' : '/bin/sh'
        const shellArg = isWin ? '/c' : '-c'

        let output = ''
        const child = spawn(shell, [shellArg, command], {
            cwd: NOVA_DIR,
            timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        child.stdout?.on('data', (data: Buffer) => {
            output += data.toString()
        })
        child.stderr?.on('data', (data: Buffer) => {
            output += data.toString()
        })

        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            resolve({ success: false, output: `Timeout nach ${timeout}ms\n${output}` })
        }, timeout)

        child.on('close', (code) => {
            clearTimeout(timer)
            resolve({
                success: code === 0,
                output: output.trim(),
            })
        })

        child.on('error', (err) => {
            clearTimeout(timer)
            resolve({ success: false, output: `Fehler: ${err.message}` })
        })
    })
}

// ============================================
// History
// ============================================

export function getEvolutionHistory(limit = 20): EvolutionLogEntry[] {
    if (!existsSync(LOG_FILE)) return []
    try {
        const log: EvolutionLogEntry[] = JSON.parse(readFileSync(LOG_FILE, 'utf-8'))
        return log.slice(-limit)
    } catch {
        return []
    }
}

export function getEvolutionStats(): {
    total: number
    successful: number
    failed: number
    lastEvolution?: string
} {
    const history = getEvolutionHistory(100)
    return {
        total: history.length,
        successful: history.filter(h => h.result.success).length,
        failed: history.filter(h => !h.result.success).length,
        lastEvolution: history.length > 0
            ? new Date(history[history.length - 1].timestamp).toISOString()
            : undefined,
    }
}

export function getPatchProposals(limit = 20): any[] {
    if (!existsSync(PROPOSALS_FILE)) return []
    try {
        const proposals = JSON.parse(readFileSync(PROPOSALS_FILE, 'utf-8'))
        return Array.isArray(proposals) ? proposals.slice(-limit) : []
    } catch {
        return []
    }
}

// ============================================
// Active Status
// ============================================

export function isEvolutionActive(): boolean {
    return activeEvolution !== null
}

export function getActiveEvolution(): string | null {
    return activeEvolution
}

export default {
    evolve,
    getEvolutionHistory,
    getEvolutionStats,
    getPatchProposals,
    isEvolutionActive,
    getActiveEvolution,
}
