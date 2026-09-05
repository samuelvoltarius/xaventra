/**
 * Token Killer — RTK-inspired tool output compression
 *
 * Reduces LLM token consumption by 60-90% on common tool outputs.
 * Applied BEFORE tool results enter the LLM context.
 *
 * Strategies:
 * 1. Smart Filtering — removes noise (comments, whitespace, boilerplate)
 * 2. Grouping — aggregates similar items (files by directory, errors by type)
 * 3. Truncation — keeps relevant context, cuts redundancy
 * 4. Deduplication — collapses repeated lines with counts
 */

// ============================================
// Types
// ============================================

interface CompressionResult {
    original: string
    compressed: string
    originalTokens: number
    compressedTokens: number
    savings: number // percentage
    strategy: string
}

interface CompressionRule {
    pattern: RegExp
    name: string
    compress: (output: string) => string
}

// ============================================
// Token Estimation
// ============================================

function estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English, ~3 for code
    return Math.ceil(text.length / 3.5)
}

// ============================================
// Compression Rules per Tool/Command
// ============================================

const GIT_STATUS_RULE: CompressionRule = {
    pattern: /^(git\s+status|git\s+diff\s+--stat)/i,
    name: 'git-status',
    compress: (output: string) => {
        const lines = output.split('\n').filter(l => l.trim())

        // Group by status
        const modified: string[] = []
        const added: string[] = []
        const deleted: string[] = []
        const untracked: string[] = []
        const other: string[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('M ') || trimmed.includes('modified:')) {
                modified.push(trimmed.replace(/^\s*(M\s+|modified:\s+)/, ''))
            } else if (trimmed.startsWith('A ') || trimmed.includes('new file:')) {
                added.push(trimmed.replace(/^\s*(A\s+|new file:\s+)/, ''))
            } else if (trimmed.startsWith('D ') || trimmed.includes('deleted:')) {
                deleted.push(trimmed.replace(/^\s*(D\s+|deleted:\s+)/, ''))
            } else if (trimmed.startsWith('??') || trimmed.includes('Untracked')) {
                untracked.push(trimmed.replace(/^\?\?\s+/, ''))
            } else if (!trimmed.startsWith('On branch') && !trimmed.startsWith('Changes') &&
                !trimmed.startsWith('(use') && !trimmed.startsWith('no changes')) {
                other.push(trimmed)
            }
        }

        // Group by directory
        const groupByDir = (files: string[]): string => {
            if (files.length === 0) return ''
            if (files.length <= 3) return files.join(', ')

            const dirs: Record<string, number> = {}
            for (const f of files) {
                const dir = f.includes('/') ? f.split('/').slice(0, -1).join('/') : '.'
                dirs[dir] = (dirs[dir] || 0) + 1
            }
            return Object.entries(dirs).map(([d, c]) => `${d}/ (${c})`).join(', ')
        }

        const parts: string[] = []
        if (modified.length) parts.push(`Modified (${modified.length}): ${groupByDir(modified)}`)
        if (added.length) parts.push(`Added (${added.length}): ${groupByDir(added)}`)
        if (deleted.length) parts.push(`Deleted (${deleted.length}): ${groupByDir(deleted)}`)
        if (untracked.length) parts.push(`Untracked (${untracked.length}): ${groupByDir(untracked)}`)
        if (other.length > 0) parts.push(other.slice(0, 3).join('\n'))

        return parts.join('\n') || output.slice(0, 200)
    },
}

const GIT_LOG_RULE: CompressionRule = {
    pattern: /^git\s+log/i,
    name: 'git-log',
    compress: (output: string) => {
        const commits = output.split(/(?=commit\s+[a-f0-9]{40})/i)
        if (commits.length <= 5) return output

        // Keep first 5 commits, summarize rest
        const kept = commits.slice(0, 5).join('')
        return `${kept}\n... and ${commits.length - 5} more commits`
    },
}

const LS_RULE: CompressionRule = {
    pattern: /^(ls|dir|find\s|fd\s)/i,
    name: 'ls-dir',
    compress: (output: string) => {
        const lines = output.split('\n').filter(l => l.trim())
        if (lines.length <= 20) return output

        // Group by extension
        const exts: Record<string, number> = {}
        const dirs: string[] = []
        for (const l of lines) {
            const trimmed = l.trim()
            if (trimmed.endsWith('/') || trimmed.includes('<DIR>')) {
                dirs.push(trimmed)
            } else {
                const ext = trimmed.includes('.') ? trimmed.split('.').pop() || 'other' : 'no-ext'
                exts[ext] = (exts[ext] || 0) + 1
            }
        }

        const parts: string[] = []
        if (dirs.length) parts.push(`Directories (${dirs.length}): ${dirs.slice(0, 10).join(', ')}${dirs.length > 10 ? '...' : ''}`)
        parts.push(`Files (${lines.length - dirs.length}): ${Object.entries(exts).map(([e, c]) => `.${e}(${c})`).join(', ')}`)

        return parts.join('\n')
    },
}

const NPM_RULE: CompressionRule = {
    pattern: /^(npm\s|yarn\s|pnpm\s)/i,
    name: 'npm',
    compress: (output: string) => {
        const lines = output.split('\n')
        // Remove npm WARN lines, keep errors and key info
        const important = lines.filter(l =>
            !l.includes('npm warn') &&
            !l.includes('npm WARN') &&
            !l.startsWith('npm notice') &&
            !l.includes('added ') &&
            l.trim().length > 0
        )
        if (important.length < lines.length * 0.5) {
            // Lots of noise removed
            const warnings = lines.filter(l => l.includes('WARN')).length
            const errors = lines.filter(l => l.includes('ERR') || l.includes('error')).length
            return `${important.join('\n')}\n[${warnings} warnings, ${errors} errors filtered]`
        }
        return important.join('\n')
    },
}

const GENERIC_DEDUP_RULE: CompressionRule = {
    pattern: /./,
    name: 'generic-dedup',
    compress: (output: string) => {
        if (output.length < 500) return output

        const lines = output.split('\n')
        if (lines.length < 10) return output

        // Dedup consecutive identical lines
        const deduped: string[] = []
        let lastLine = ''
        let dupCount = 0

        for (const line of lines) {
            if (line === lastLine) {
                dupCount++
            } else {
                if (dupCount > 0) {
                    deduped.push(`  ... (×${dupCount + 1})`)
                }
                deduped.push(line)
                lastLine = line
                dupCount = 0
            }
        }
        if (dupCount > 0) deduped.push(`  ... (×${dupCount + 1})`)

        // Truncate if still too long
        const result = deduped.join('\n')
        if (result.length > 4000) {
            return result.slice(0, 3500) + `\n... [truncated, ${result.length} chars total]`
        }
        return result
    },
}

// All rules in priority order
const RULES: CompressionRule[] = [
    GIT_STATUS_RULE,
    GIT_LOG_RULE,
    LS_RULE,
    NPM_RULE,
    GENERIC_DEDUP_RULE,
]

// ============================================
// Main API
// ============================================

let totalSaved = 0
let totalCalls = 0

export function compressToolOutput(toolName: string, command: string, output: string): CompressionResult {
    const originalTokens = estimateTokens(output)

    // Skip compression for small outputs
    if (output.length < 200) {
        return {
            original: output,
            compressed: output,
            originalTokens,
            compressedTokens: originalTokens,
            savings: 0,
            strategy: 'none (small output)',
        }
    }

    // Find matching rule
    const commandStr = command || toolName || ''
    let compressed = output
    let strategy = 'none'

    for (const rule of RULES) {
        if (rule.pattern.test(commandStr)) {
            try {
                compressed = rule.compress(output)
                strategy = rule.name
                break
            } catch {
                // Compression failed, use original
            }
        }
    }

    const compressedTokens = estimateTokens(compressed)
    const savings = Math.round((1 - compressedTokens / originalTokens) * 100)

    totalSaved += (originalTokens - compressedTokens)
    totalCalls++

    if (savings > 20) {
        console.log(`[TokenKiller] ${strategy}: ${originalTokens} → ${compressedTokens} tokens (${savings}% saved)`)
    }

    return {
        original: output,
        compressed,
        originalTokens,
        compressedTokens,
        savings,
        strategy,
    }
}

export function getTokenKillerStats(): { totalCalls: number; totalTokensSaved: number } {
    return { totalCalls, totalTokensSaved: totalSaved }
}
