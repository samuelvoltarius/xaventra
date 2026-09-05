/**
 * AutoFix diagnoses build errors and creates sandbox-verified PATCH_GATE
 * proposals. It never writes production source files directly.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'

const DATA_DIR = getNovaDataDir('auto-fix')

interface FixAttempt {
    timestamp: string
    file: string
    originalError: string
    fixApplied: string
    success: boolean
    proposalId?: string
}

let fixHistory: FixAttempt[] = []

export function runBuildCheck(): { success: boolean; errors: string[] } {
    try {
        execSync('npx tsc --noEmit 2>&1', { cwd: process.cwd(), timeout: 30_000, encoding: 'utf-8' })
        return { success: true, errors: [] }
    } catch (error: any) {
        const output = error.stdout || error.stderr || error.message || ''
        return {
            success: false,
            errors: String(output).split('\n').filter(line => line.includes('error TS')).slice(0, 10),
        }
    }
}

function parseTscError(errorLine: string) {
    const match = errorLine.match(/^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/)
    if (!match) return null
    return { file: match[1].trim(), line: Number(match[2]), code: match[3], message: match[4].trim() }
}

export async function autoFixBuildError(errorLine: string, retryCount = 0): Promise<boolean> {
    if (retryCount >= 2) return false
    const parsed = parseTscError(errorLine)
    if (!parsed) return false
    const filePath = join(process.cwd(), parsed.file)
    if (!existsSync(filePath)) return false

    const fileContent = readFileSync(filePath, 'utf-8')
    const lines = fileContent.split('\n')
    const startLine = Math.max(0, parsed.line - 3)
    const errorContext = lines.slice(startLine, parsed.line + 3).join('\n')

    try {
        const { generateFix } = await import('../intelligence/doctor-client.js')
        const proposal = await generateFix(errorContext, `${parsed.code}: ${parsed.message}`)
        if (!proposal?.fixedCode) return false

        const { evolve } = await import('../synthesis/self-evolution.js')
        const outcome = await evolve({
            file: parsed.file.replace(/\\/g, '/'),
            description: `Nova Doctor proposal for ${parsed.code} at line ${parsed.line}`,
            reason: proposal.explanation || parsed.message,
            search: errorContext,
            replace: proposal.fixedCode,
        })
        fixHistory.push({
            timestamp: new Date().toISOString(),
            file: parsed.file,
            originalError: errorLine,
            fixApplied: proposal.fixedCode.slice(0, 200),
            success: outcome.success,
            proposalId: outcome.proposalId,
        })
        saveHistory()
        console.log(outcome.queued
            ? `[AutoFix] Sandbox passed; queued ${outcome.proposalId} for PATCH_GATE`
            : `[AutoFix] Proposal rejected: ${outcome.error || 'unknown error'}`)
        return outcome.success
    } catch (error: any) {
        console.log(`[AutoFix] Nova Doctor proposal failed: ${error.message}`)
        return false
    }
}

export async function runAutoFixCycle(): Promise<{ fixed: number; failed: number }> {
    const build = runBuildCheck()
    if (build.success) return { fixed: 0, failed: 0 }
    let fixed = 0
    let failed = 0
    for (const error of build.errors.slice(0, 5)) {
        if (await autoFixBuildError(error)) fixed++
        else failed++
    }
    return { fixed, failed }
}

export function getAutoFixStats(): string {
    return `AutoFix: ${fixHistory.filter(item => item.success).length}/${fixHistory.length} erfolgreich`
}

function saveHistory(): void {
    try {
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'history.json'), JSON.stringify(fixHistory.slice(-50), null, 2))
    } catch { /* telemetry only */ }
}

export function initAutoFix(): void {
    mkdirSync(DATA_DIR, { recursive: true })
    try {
        const path = join(DATA_DIR, 'history.json')
        if (existsSync(path)) fixHistory = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* start empty */ }
    console.log(`[AutoFix] Initialized: ${fixHistory.length} past attempts`)
}
