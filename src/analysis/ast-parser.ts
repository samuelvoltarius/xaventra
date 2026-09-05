/**
 * AST Parser - Code Understanding
 * 
 * Parses TypeScript/JavaScript files to extract:
 * - Functions and classes
 * - Dependencies (imports)
 * - Call graph
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

// ============================================
// Types
// ============================================

export interface CodeSymbol {
    name: string
    type: 'function' | 'class' | 'variable' | 'interface' | 'type'
    startLine: number
    endLine: number
    exported: boolean
    params?: string[]
    returnType?: string
}

export interface ImportInfo {
    module: string
    imports: string[]
    isDefault: boolean
    isType: boolean
}

export interface FileAnalysis {
    path: string
    language: 'typescript' | 'javascript' | 'python' | 'unknown'
    symbols: CodeSymbol[]
    imports: ImportInfo[]
    exports: string[]
    lines: number
}

// ============================================
// Regex Patterns for Parsing
// ============================================

const PATTERNS = {
    // TypeScript/JavaScript
    tsFunction: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/gm,
    tsArrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*([^=]+))?\s*=>/gm,
    tsClass: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/gm,
    tsInterface: /(?:export\s+)?interface\s+(\w+)/gm,
    tsType: /(?:export\s+)?type\s+(\w+)/gm,
    tsImport: /import\s+(?:type\s+)?(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/gm,
    tsExport: /export\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/gm,

    // Python
    pyFunction: /def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/gm,
    pyClass: /class\s+(\w+)(?:\(([^)]*)\))?:/gm,
    pyImport: /(?:from\s+(\S+)\s+)?import\s+(.+)/gm,
}

// ============================================
// Parser Functions
// ============================================

/**
 * Detect language from file extension
 */
function detectLanguage(path: string): FileAnalysis['language'] {
    const ext = extname(path).toLowerCase()
    switch (ext) {
        case '.ts':
        case '.tsx':
            return 'typescript'
        case '.js':
        case '.jsx':
        case '.mjs':
            return 'javascript'
        case '.py':
            return 'python'
        default:
            return 'unknown'
    }
}

/**
 * Parse TypeScript/JavaScript file
 */
function parseTypeScript(content: string): { symbols: CodeSymbol[]; imports: ImportInfo[]; exports: string[] } {
    const lines = content.split('\n')
    const symbols: CodeSymbol[] = []
    const imports: ImportInfo[] = []
    const exports: string[] = []

    // Find functions
    let match
    while ((match = PATTERNS.tsFunction.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        symbols.push({
            name: match[1],
            type: 'function',
            startLine: line,
            endLine: line,  // Would need proper parsing for block end
            exported: match[0].includes('export'),
            params: match[2] ? match[2].split(',').map(p => p.trim()) : [],
            returnType: match[3]?.trim(),
        })
    }

    // Find arrow functions
    PATTERNS.tsArrowFunction.lastIndex = 0
    while ((match = PATTERNS.tsArrowFunction.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        symbols.push({
            name: match[1],
            type: 'function',
            startLine: line,
            endLine: line,
            exported: match[0].includes('export'),
            returnType: match[2]?.trim(),
        })
    }

    // Find classes
    PATTERNS.tsClass.lastIndex = 0
    while ((match = PATTERNS.tsClass.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        symbols.push({
            name: match[1],
            type: 'class',
            startLine: line,
            endLine: line,
            exported: match[0].includes('export'),
        })
    }

    // Find interfaces
    PATTERNS.tsInterface.lastIndex = 0
    while ((match = PATTERNS.tsInterface.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        symbols.push({
            name: match[1],
            type: 'interface',
            startLine: line,
            endLine: line,
            exported: match[0].includes('export'),
        })
    }

    // Find imports
    PATTERNS.tsImport.lastIndex = 0
    while ((match = PATTERNS.tsImport.exec(content)) !== null) {
        const namedImports = match[1] ? match[1].split(',').map(s => s.trim()) : []
        const defaultImport = match[2]
        const module = match[3]

        imports.push({
            module,
            imports: defaultImport ? [defaultImport] : namedImports,
            isDefault: !!defaultImport,
            isType: match[0].includes('import type'),
        })
    }

    // Find exports
    PATTERNS.tsExport.lastIndex = 0
    while ((match = PATTERNS.tsExport.exec(content)) !== null) {
        exports.push(match[1])
    }

    return { symbols, imports, exports }
}

/**
 * Parse Python file
 */
function parsePython(content: string): { symbols: CodeSymbol[]; imports: ImportInfo[]; exports: string[] } {
    const symbols: CodeSymbol[] = []
    const imports: ImportInfo[] = []
    const exports: string[] = []

    let match
    while ((match = PATTERNS.pyFunction.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        symbols.push({
            name: match[1],
            type: 'function',
            startLine: line,
            endLine: line,
            exported: !match[1].startsWith('_'),
            params: match[2] ? match[2].split(',').map(p => p.trim()) : [],
            returnType: match[3]?.trim(),
        })
    }

    PATTERNS.pyClass.lastIndex = 0
    while ((match = PATTERNS.pyClass.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        symbols.push({
            name: match[1],
            type: 'class',
            startLine: line,
            endLine: line,
            exported: !match[1].startsWith('_'),
        })
    }

    PATTERNS.pyImport.lastIndex = 0
    while ((match = PATTERNS.pyImport.exec(content)) !== null) {
        const module = match[1] || ''
        const imported = match[2].split(',').map(s => s.trim())
        imports.push({
            module: module || imported[0],
            imports: imported,
            isDefault: false,
            isType: false,
        })
    }

    return { symbols, imports, exports }
}

// ============================================
// Main API
// ============================================

/**
 * Analyze a single file
 */
export function analyzeFile(path: string): FileAnalysis | null {
    if (!existsSync(path)) {
        console.log(`[AST] File not found: ${path}`)
        return null
    }

    const content = readFileSync(path, 'utf-8')
    const language = detectLanguage(path)
    const lines = content.split('\n').length

    let parsed: { symbols: CodeSymbol[]; imports: ImportInfo[]; exports: string[] }

    switch (language) {
        case 'typescript':
        case 'javascript':
            parsed = parseTypeScript(content)
            break
        case 'python':
            parsed = parsePython(content)
            break
        default:
            parsed = { symbols: [], imports: [], exports: [] }
    }

    console.log(`[AST] Analyzed ${path}: ${parsed.symbols.length} symbols, ${parsed.imports.length} imports`)

    return {
        path,
        language,
        ...parsed,
        lines,
    }
}

/**
 * Get dependency graph for a file
 */
export function getDependencies(analysis: FileAnalysis): string[] {
    return analysis.imports
        .map(i => i.module)
        .filter(m => !m.startsWith('.'))  // External modules only
}

/**
 * Get summary of a file
 */
export function getFileSummary(analysis: FileAnalysis): string {
    const parts = [
        `**${basename(analysis.path)}** (${analysis.language}, ${analysis.lines} lines)`,
    ]

    const funcs = analysis.symbols.filter(s => s.type === 'function')
    const classes = analysis.symbols.filter(s => s.type === 'class')

    if (classes.length > 0) {
        parts.push(`Classes: ${classes.map(c => c.name).join(', ')}`)
    }
    if (funcs.length > 0) {
        parts.push(`Functions: ${funcs.slice(0, 5).map(f => f.name).join(', ')}${funcs.length > 5 ? '...' : ''}`)
    }
    if (analysis.imports.length > 0) {
        parts.push(`Imports: ${analysis.imports.length} modules`)
    }

    return parts.join('\n')
}

export default {
    analyzeFile,
    getDependencies,
    getFileSummary,
}
