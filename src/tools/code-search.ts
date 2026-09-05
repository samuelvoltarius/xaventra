/**
 * Nova Code Search Tool
 * 
 * Equivalent to grep_search / find_by_name.
 * Provides structured JSON output for code searching:
 * - Pattern matching (literal or regex)
 * - File name/extension filtering
 * - Case-insensitive option
 * - Results capped at 50 for performance
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, basename, relative } from 'node:path'

// ============================================
// Types
// ============================================

export interface SearchMatch {
    file: string
    line: number
    content: string
    column?: number
}

export interface SearchResult {
    query: string
    matches: SearchMatch[]
    totalMatches: number
    truncated: boolean
    filesSearched: number
}

export interface FindResult {
    pattern: string
    results: Array<{
        path: string
        type: 'file' | 'directory'
        size?: number
    }>
    totalResults: number
    truncated: boolean
}

// ============================================
// Ignore Patterns
// ============================================

const DEFAULT_IGNORE = [
    'node_modules', '.git', 'dist', '.nova-data', '.nova-tools',
    '.nova-screenshots', '__pycache__', '.next', '.turbo',
    'coverage', '.nyc_output', '.cache', 'build',
]

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.avi', '.mov',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.exe', '.dll', '.so', '.dylib', '.o',
    '.pyc', '.class', '.wasm',
])

// ============================================
// Core: grep_search equivalent
// ============================================

export function codeSearch(
    searchPath: string,
    query: string,
    options: {
        isRegex?: boolean
        caseInsensitive?: boolean
        includes?: string[]
        matchPerLine?: boolean
        maxResults?: number
    } = {}
): SearchResult {
    const {
        isRegex = false,
        caseInsensitive = false,
        includes = [],
        matchPerLine = true,
        maxResults = 50,
    } = options

    const flags = caseInsensitive ? 'gi' : 'g'
    let pattern: RegExp

    try {
        pattern = isRegex
            ? new RegExp(query, flags)
            : new RegExp(escapeRegex(query), flags)
    } catch {
        return {
            query,
            matches: [],
            totalMatches: 0,
            truncated: false,
            filesSearched: 0,

        }
    }

    const matches: SearchMatch[] = []
    let filesSearched = 0
    let totalMatches = 0

    const walkAndSearch = (dir: string): void => {
        if (matches.length >= maxResults) return

        let entries: string[]
        try {
            entries = readdirSync(dir)
        } catch {
            return
        }

        for (const entry of entries) {
            if (matches.length >= maxResults) return
            if (DEFAULT_IGNORE.includes(entry)) continue

            const fullPath = join(dir, entry)
            let stat
            try {
                stat = statSync(fullPath)
            } catch {
                continue
            }

            if (stat.isDirectory()) {
                walkAndSearch(fullPath)
            } else if (stat.isFile()) {
                const ext = extname(entry).toLowerCase()
                if (BINARY_EXTENSIONS.has(ext)) continue

                // Apply include filters
                if (includes.length > 0) {
                    const matchesInclude = includes.some(glob => {
                        if (glob.startsWith('*.')) {
                            return ext === glob.slice(1)
                        }
                        return entry === glob || fullPath.includes(glob)
                    })
                    if (!matchesInclude) continue
                }

                // Skip files > 1MB
                if (stat.size > 1_000_000) continue

                filesSearched++
                try {
                    const content = readFileSync(fullPath, 'utf-8')
                    const relPath = relative(searchPath, fullPath).replace(/\\/g, '/')

                    if (matchPerLine) {
                        const lines = content.split('\n')
                        for (let i = 0; i < lines.length; i++) {
                            if (matches.length >= maxResults) break
                            pattern.lastIndex = 0
                            const match = pattern.exec(lines[i])
                            if (match) {
                                totalMatches++
                                matches.push({
                                    file: relPath,
                                    line: i + 1,
                                    content: lines[i].trim().slice(0, 200),
                                    column: match.index + 1,
                                })
                            }
                        }
                    } else {
                        // File-only mode: just check if file contains pattern
                        pattern.lastIndex = 0
                        if (pattern.test(content)) {
                            totalMatches++
                            matches.push({
                                file: relPath,
                                line: 0,
                                content: '(file contains match)',
                            })
                        }
                    }
                } catch { /* skip unreadable files */ }
            }
        }
    }

    walkAndSearch(searchPath)

    return {
        query,
        matches,
        totalMatches,
        truncated: totalMatches > maxResults,
        filesSearched,
    }
}

// ============================================
// Core: find_by_name equivalent
// ============================================

export function findByName(
    searchDir: string,
    pattern: string,
    options: {
        type?: 'file' | 'directory' | 'any'
        extensions?: string[]
        maxDepth?: number
        maxResults?: number
    } = {}
): FindResult {
    const {
        type = 'any',
        extensions = [],
        maxDepth = 20,
        maxResults = 50,
    } = options

    const results: FindResult['results'] = []
    let totalResults = 0

    // Build glob pattern → regex
    const globRegex = globToRegex(pattern)

    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth || results.length >= maxResults) return

        let entries: string[]
        try {
            entries = readdirSync(dir)
        } catch {
            return
        }

        for (const entry of entries) {
            if (results.length >= maxResults) return
            if (DEFAULT_IGNORE.includes(entry)) continue

            const fullPath = join(dir, entry)
            let stat
            try {
                stat = statSync(fullPath)
            } catch {
                continue
            }

            const isDir = stat.isDirectory()
            const isFile = stat.isFile()

            // Check type filter
            if (type === 'file' && !isFile) {
                if (isDir) walk(fullPath, depth + 1)
                continue
            }
            if (type === 'directory' && !isDir) continue

            // Check extension filter
            if (extensions.length > 0 && isFile) {
                const ext = extname(entry).slice(1).toLowerCase()
                if (!extensions.includes(ext)) {
                    if (isDir) walk(fullPath, depth + 1)
                    continue
                }
            }

            // Check name pattern
            if (globRegex.test(entry)) {
                totalResults++
                const relPath = relative(searchDir, fullPath).replace(/\\/g, '/')
                results.push({
                    path: relPath,
                    type: isDir ? 'directory' : 'file',
                    size: isFile ? stat.size : undefined,
                })
            }

            if (isDir) walk(fullPath, depth + 1)
        }
    }

    walk(searchDir, 0)

    return {
        pattern,
        results,
        totalResults,
        truncated: totalResults > maxResults,
    }
}

// ============================================
// Helpers
// ============================================

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegex(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`, 'i')
}

// ============================================
// Tool Definitions for Nova Registry
// ============================================

export const codeSearchTool = {
    name: 'code_search',
    description: 'Durchsucht Code-Dateien nach einem Pattern (wie grep/ripgrep). Liefert strukturiertes JSON mit Datei, Zeilennummer und Inhalt. Max 50 Treffer.',
    category: 'file' as const,
    parameters: [
        { name: 'path', type: 'string' as const, description: 'Verzeichnis zum Durchsuchen', required: true },
        { name: 'query', type: 'string' as const, description: 'Suchbegriff oder Regex-Pattern', required: true },
        { name: 'is_regex', type: 'boolean' as const, description: 'Als Regex interpretieren', required: false },
        { name: 'case_insensitive', type: 'boolean' as const, description: 'Groß/Kleinschreibung ignorieren', required: false },
        { name: 'includes', type: 'string' as const, description: 'Datei-Filter (komma-getrennt, z.B. "*.ts,*.js")', required: false },
        { name: 'files_only', type: 'boolean' as const, description: 'Nur Dateinamen, nicht einzelne Zeilen', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const includes = params.includes
            ? (params.includes as string).split(',').map(s => s.trim())
            : []

        return codeSearch(
            params.path as string,
            params.query as string,
            {
                isRegex: params.is_regex as boolean,
                caseInsensitive: params.case_insensitive as boolean,
                includes,
                matchPerLine: !(params.files_only as boolean),
            }
        )
    },
}

export const findByNameTool = {
    name: 'find_files',
    description: 'Sucht Dateien/Ordner nach Name-Pattern (wie find/fd). Unterstützt Glob-Patterns (*,?). Max 50 Treffer.',
    category: 'file' as const,
    parameters: [
        { name: 'path', type: 'string' as const, description: 'Verzeichnis zum Durchsuchen', required: true },
        { name: 'pattern', type: 'string' as const, description: 'Name-Pattern (Glob: *, ?)', required: true },
        { name: 'type', type: 'string' as const, description: 'Typ: file, directory, any', required: false },
        { name: 'extensions', type: 'string' as const, description: 'Dateiendungen (komma-getrennt, z.B. "ts,js,py")', required: false },
        { name: 'max_depth', type: 'number' as const, description: 'Maximale Suchtiefe', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const extensions = params.extensions
            ? (params.extensions as string).split(',').map(s => s.trim().replace(/^\./, ''))
            : []

        return findByName(
            params.path as string,
            params.pattern as string,
            {
                type: (params.type as 'file' | 'directory' | 'any') || 'any',
                extensions,
                maxDepth: (params.max_depth as number) || 20,
            }
        )
    },
}

export default { codeSearch, findByName, codeSearchTool, findByNameTool }
