/**
 * Nova - Apply Patch Tool
 * 
 * Apply code patches/diffs to files safely with backup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { backupFile } from '../resilience/backup.js'

// ============================================
// Types
// ============================================

export interface PatchHunk {
    startLine: number
    endLine: number
    oldContent: string
    newContent: string
}

export interface PatchResult {
    success: boolean
    path: string
    hunksApplied: number
    hunksFailed: number
    backupPath?: string
    error?: string
}

// ============================================
// Patch Parser
// ============================================

/**
 * Parse a unified diff patch.
 */
export function parsePatch(patch: string): PatchHunk[] {
    const hunks: PatchHunk[] = []
    const lines = patch.split('\n')

    let i = 0
    while (i < lines.length) {
        const line = lines[i]

        // Look for hunk header: @@ -start,count +start,count @@
        const match = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/)
        if (match) {
            const startLine = parseInt(match[1], 10)
            const oldLines: string[] = []
            const newLines: string[] = []

            i++
            while (i < lines.length && !lines[i].startsWith('@@')) {
                const hunkLine = lines[i]
                if (hunkLine.startsWith('-')) {
                    oldLines.push(hunkLine.slice(1))
                } else if (hunkLine.startsWith('+')) {
                    newLines.push(hunkLine.slice(1))
                } else if (hunkLine.startsWith(' ')) {
                    oldLines.push(hunkLine.slice(1))
                    newLines.push(hunkLine.slice(1))
                }
                i++
            }

            hunks.push({
                startLine,
                endLine: startLine + oldLines.length - 1,
                oldContent: oldLines.join('\n'),
                newContent: newLines.join('\n'),
            })
        } else {
            i++
        }
    }

    return hunks
}

// ============================================
// Patch Application
// ============================================

/**
 * Apply a patch to a file.
 */
export function applyPatch(path: string, patch: string): PatchResult {
    if (!existsSync(path)) {
        return {
            success: false,
            path,
            hunksApplied: 0,
            hunksFailed: 0,
            error: `File not found: ${path}`,
        }
    }

    // Backup before modifying
    const backup = backupFile(path)

    try {
        const content = readFileSync(path, 'utf-8')
        const lines = content.split('\n')
        const hunks = parsePatch(patch)

        let hunksApplied = 0
        let hunksFailed = 0
        let offset = 0

        for (const hunk of hunks) {
            const startIdx = hunk.startLine - 1 + offset
            const endIdx = hunk.endLine - 1 + offset

            // Verify context matches
            const currentContent = lines.slice(startIdx, endIdx + 1).join('\n')
            if (currentContent !== hunk.oldContent) {
                console.log(`[Patch] Hunk at line ${hunk.startLine} doesn't match context`)
                hunksFailed++
                continue
            }

            // Apply the change
            const newLines = hunk.newContent.split('\n')
            lines.splice(startIdx, endIdx - startIdx + 1, ...newLines)

            // Adjust offset for subsequent hunks
            offset += newLines.length - (endIdx - startIdx + 1)
            hunksApplied++
        }

        // Write result
        writeFileSync(path, lines.join('\n'), 'utf-8')

        return {
            success: hunksFailed === 0,
            path,
            hunksApplied,
            hunksFailed,
            backupPath: backup?.backupPath,
        }

    } catch (err) {
        return {
            success: false,
            path,
            hunksApplied: 0,
            hunksFailed: 0,
            backupPath: backup?.backupPath,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

/**
 * Apply a simple search-and-replace patch.
 */
export function applySimplePatch(
    path: string,
    search: string,
    replace: string
): PatchResult {
    if (!existsSync(path)) {
        return {
            success: false,
            path,
            hunksApplied: 0,
            hunksFailed: 0,
            error: `File not found: ${path}`,
        }
    }

    const backup = backupFile(path)

    try {
        const content = readFileSync(path, 'utf-8')

        if (!content.includes(search)) {
            return {
                success: false,
                path,
                hunksApplied: 0,
                hunksFailed: 1,
                backupPath: backup?.backupPath,
                error: 'Search string not found in file',
            }
        }

        const newContent = content.replace(search, replace)
        writeFileSync(path, newContent, 'utf-8')

        return {
            success: true,
            path,
            hunksApplied: 1,
            hunksFailed: 0,
            backupPath: backup?.backupPath,
        }

    } catch (err) {
        return {
            success: false,
            path,
            hunksApplied: 0,
            hunksFailed: 0,
            backupPath: backup?.backupPath,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

/**
 * Apply multiple search-and-replace operations.
 */
export function applyMultiPatch(
    path: string,
    patches: Array<{ search: string; replace: string }>
): PatchResult {
    if (!existsSync(path)) {
        return {
            success: false,
            path,
            hunksApplied: 0,
            hunksFailed: 0,
            error: `File not found: ${path}`,
        }
    }

    const backup = backupFile(path)

    try {
        let content = readFileSync(path, 'utf-8')
        let applied = 0
        let failed = 0

        for (const { search, replace } of patches) {
            if (content.includes(search)) {
                content = content.replace(search, replace)
                applied++
            } else {
                failed++
            }
        }

        writeFileSync(path, content, 'utf-8')

        return {
            success: failed === 0,
            path,
            hunksApplied: applied,
            hunksFailed: failed,
            backupPath: backup?.backupPath,
        }

    } catch (err) {
        return {
            success: false,
            path,
            hunksApplied: 0,
            hunksFailed: 0,
            backupPath: backup?.backupPath,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

export default { parsePatch, applyPatch, applySimplePatch, applyMultiPatch }
