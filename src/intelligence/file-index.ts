/**
 * Fast File Index — OmniSearch-inspired
 *
 * Builds an in-memory file index for instant search.
 * Uses Node.js fs.readdir with recursive option for cross-platform support.
 * Incremental updates via file watcher.
 *
 * Not as fast as NTFS MFT (that requires C++/Rust),
 * but covers all platforms and is still very fast for Nova's needs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename, relative } from 'node:path'
import { watch, FSWatcher } from 'node:fs'

const DATA_DIR = join(process.cwd(), '.nova-data', 'file-index')

// ============================================
// Types
// ============================================

interface FileEntry {
    path: string
    name: string
    ext: string
    size: number
    modifiedAt: number
    isDir: boolean
}

interface FileIndex {
    entries: FileEntry[]
    rootPaths: string[]
    lastScanAt: number
    totalFiles: number
    totalDirs: number
    scanDurationMs: number
    byExtension: Record<string, number>
}

// ============================================
// State
// ============================================

let index: FileIndex = {
    entries: [],
    rootPaths: [],
    lastScanAt: 0,
    totalFiles: 0,
    totalDirs: 0,
    scanDurationMs: 0,
    byExtension: {},
}

let watchers: FSWatcher[] = []
let initialized = false

// ============================================
// Scanning
// ============================================

const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__',
    '.nova-data', '.cache', 'coverage', '.tsbuildinfo', '.turbo',
    'out', '.vercel', '.svelte-kit', '.nx', '.angular', 'vendor',
    'bower_components', '.yarn', '.pnp', 'target', 'bin', 'obj',
    '.terraform', '.serverless', 'venv', '.venv', 'env',
])

const IGNORE_EXTS = new Set([
    '.lock', '.map', '.d.ts', '.min.js', '.min.css', '.chunk.js',
])

const MAX_FILES = 50_000  // Hard safety limit

/**
 * Load .nova-ignore file (gitignore-style patterns)
 */
function loadNovaIgnore(rootPath: string): Set<string> {
    const extra = new Set<string>()
    const ignorePath = join(rootPath, '.nova-ignore')
    try {
        if (existsSync(ignorePath)) {
            const lines = readFileSync(ignorePath, 'utf-8').split('\n')
            for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed && !trimmed.startsWith('#')) {
                    extra.add(trimmed.replace(/\/$/, ''))  // strip trailing slash
                }
            }
            console.log(`[FileIndex] 📄 .nova-ignore loaded: ${extra.size} patterns`)
        }
    } catch { }
    return extra
}

/**
 * Scan a directory recursively and build index
 */
export function scanDirectory(rootPath: string, maxDepth: number = 8): number {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    const startTime = Date.now()
    const entries: FileEntry[] = []
    const customIgnore = loadNovaIgnore(rootPath)
    let hitLimit = false

    function isIgnored(name: string): boolean {
        if (IGNORE_DIRS.has(name)) return true
        if (customIgnore.has(name)) return true
        // Glob-style: check if any pattern matches
        for (const pattern of customIgnore) {
            if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true
        }
        return false
    }

    function walk(dir: string, depth: number): void {
        if (depth > maxDepth) return
        if (entries.length >= MAX_FILES) {
            if (!hitLimit) {
                hitLimit = true
                console.log(`[FileIndex] ⚠️ MAX_FILES limit (${MAX_FILES}) reached — stopping scan`)
            }
            return
        }

        try {
            const items = readdirSync(dir, { withFileTypes: true })

            for (const item of items) {
                if (entries.length >= MAX_FILES) return
                if (item.name.startsWith('.') && depth > 0) continue
                if (isIgnored(item.name)) continue

                const fullPath = join(dir, item.name)

                if (item.isDirectory()) {
                    entries.push({
                        path: fullPath,
                        name: item.name,
                        ext: '',
                        size: 0,
                        modifiedAt: 0,
                        isDir: true,
                    })
                    walk(fullPath, depth + 1)
                } else {
                    const ext = extname(item.name).toLowerCase()
                    if (IGNORE_EXTS.has(ext)) continue

                    try {
                        const stat = statSync(fullPath)
                        entries.push({
                            path: fullPath,
                            name: item.name,
                            ext,
                            size: stat.size,
                            modifiedAt: stat.mtimeMs,
                            isDir: false,
                        })
                    } catch { }
                }
            }
        } catch { }
    }

    walk(rootPath, 0)

    // Merge into index
    if (!index.rootPaths.includes(rootPath)) {
        index.rootPaths.push(rootPath)
    }

    // Remove old entries from this root
    index.entries = index.entries.filter(e => !e.path.startsWith(rootPath))
    index.entries.push(...entries)

    // Update stats
    index.totalFiles = index.entries.filter(e => !e.isDir).length
    index.totalDirs = index.entries.filter(e => e.isDir).length
    index.lastScanAt = Date.now()
    index.scanDurationMs = Date.now() - startTime

    // Extension stats
    index.byExtension = {}
    for (const e of index.entries) {
        if (e.ext) {
            index.byExtension[e.ext] = (index.byExtension[e.ext] || 0) + 1
        }
    }

    // Save index
    saveIndex()

    console.log(`[FileIndex] ✅ Indexed ${entries.length} items from ${rootPath} in ${index.scanDurationMs}ms`)
    return entries.length
}

/**
 * Search the file index
 */
export function searchFiles(query: string, options: {
    ext?: string
    maxSize?: number
    minSize?: number
    limit?: number
} = {}): FileEntry[] {
    const queryLower = query.toLowerCase()
    const limit = options.limit || 20

    return index.entries
        .filter(e => {
            if (e.isDir) return false
            if (!e.name.toLowerCase().includes(queryLower) &&
                !e.path.toLowerCase().includes(queryLower)) return false
            if (options.ext && e.ext !== options.ext) return false
            if (options.maxSize && e.size > options.maxSize) return false
            if (options.minSize && e.size < options.minSize) return false
            return true
        })
        .sort((a, b) => {
            // Prefer exact name matches
            const aExact = a.name.toLowerCase() === queryLower ? 1 : 0
            const bExact = b.name.toLowerCase() === queryLower ? 1 : 0
            if (aExact !== bExact) return bExact - aExact
            // Then by recency
            return b.modifiedAt - a.modifiedAt
        })
        .slice(0, limit)
}

/**
 * Find duplicates by name (similar to OmniSearch)
 */
export function findDuplicates(): Record<string, FileEntry[]> {
    const byName: Record<string, FileEntry[]> = {}

    for (const entry of index.entries) {
        if (entry.isDir) continue
        if (!byName[entry.name]) byName[entry.name] = []
        byName[entry.name].push(entry)
    }

    // Only return names with multiple entries
    const duplicates: Record<string, FileEntry[]> = {}
    for (const [name, entries] of Object.entries(byName)) {
        if (entries.length > 1) {
            duplicates[name] = entries
        }
    }

    return duplicates
}

/**
 * Get index stats
 */
export function getIndexStats(): string {
    if (index.entries.length === 0) {
        return '📁 File-Index leer. Starte Scan mit `/scan <path>`'
    }

    const topExts = Object.entries(index.byExtension)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([ext, count]) => `${ext}(${count})`)
        .join(', ')

    return `📁 **File Index**
Files: ${index.totalFiles} | Dirs: ${index.totalDirs}
Roots: ${index.rootPaths.join(', ')}
Last scan: ${new Date(index.lastScanAt).toLocaleString('de')} (${index.scanDurationMs}ms)
Top extensions: ${topExts}`
}

// ============================================
// Persistence
// ============================================

function saveIndex(): void {
    try {
        // Save only metadata, not full paths (too large)
        const compact = {
            ...index,
            entries: index.entries.length, // Don't persist full entries
        }
        writeFileSync(join(DATA_DIR, 'index-meta.json'), JSON.stringify(compact, null, 2))

        // Save full index as compact binary-ish JSON
        writeFileSync(join(DATA_DIR, 'index.json'), JSON.stringify(index))
    } catch { }
}

function loadIndex(): void {
    try {
        const path = join(DATA_DIR, 'index.json')
        if (existsSync(path)) {
            index = JSON.parse(readFileSync(path, 'utf-8'))
        }
    } catch { }
}

/**
 * Initialize file index (load from cache)
 */
export function initFileIndex(): void {
    if (initialized) return
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    loadIndex()
    initialized = true

    if (index.entries.length > 0) {
        console.log(`[FileIndex] ✅ Loaded ${index.entries.length} cached entries`)
    }
}
