/**
 * Nova Code Outline Tool
 * 
 * Equivalent to view_file_outline / view_code_item.
 * Regex-based AST-like code analysis for:
 * - TypeScript/JavaScript (functions, classes, interfaces, types, exports)
 * - Python (def, class, decorators)
 * - Go (func, type, struct)
 * - Rust (fn, struct, impl, enum, trait)
 * 
 * Returns structured outline with signatures and line ranges.
 */

import { readFileSync, existsSync } from 'node:fs'
import { extname } from 'node:path'

// ============================================
// Types
// ============================================

export interface OutlineItem {
    name: string
    kind: 'function' | 'class' | 'interface' | 'type' | 'method' | 'property' | 'enum' | 'export' | 'import' | 'variable' | 'decorator' | 'trait' | 'impl'
    signature: string
    startLine: number
    endLine: number
    parent?: string
    children?: OutlineItem[]
}

export interface FileOutline {
    file: string
    language: string
    totalLines: number
    items: OutlineItem[]
    error?: string
}

// ============================================
// Language Detection
// ============================================

function detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
        '.py': 'python', '.pyw': 'python',
        '.go': 'go',
        '.rs': 'rust',
        '.java': 'java',
        '.c': 'c', '.h': 'c',
        '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
        '.cs': 'csharp',
        '.rb': 'ruby',
        '.php': 'php',
        '.swift': 'swift',
        '.kt': 'kotlin',
    }
    return langMap[ext] || 'unknown'
}

// ============================================
// TypeScript/JavaScript Outline Parser
// ============================================

function parseTypeScript(lines: string[], content: string): OutlineItem[] {
    const items: OutlineItem[] = []
    let currentClass: OutlineItem | null = null
    let braceDepth = 0
    let classStartDepth = 0

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()

        // Track brace depth
        const openBraces = (line.match(/\{/g) || []).length
        const closeBraces = (line.match(/\}/g) || []).length
        braceDepth += openBraces - closeBraces

        // Skip comments and empty lines
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '') continue

        // Class / Interface / Type / Enum
        const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)(?:\s*<[^>]*>)?(?:\s+(?:extends|implements)\s+[^{]+)?/)
        if (classMatch) {
            currentClass = {
                name: classMatch[1],
                kind: trimmed.includes('interface') ? 'interface' : 'class',
                signature: trimmed.replace(/\s*\{.*$/, ''),
                startLine: i + 1,
                endLine: i + 1, // updated when closing brace found
                children: [],
            }
            classStartDepth = braceDepth - openBraces
            items.push(currentClass)
            continue
        }

        // Type alias
        const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)(?:\s*<[^>]*>)?\s*=/)
        if (typeMatch) {
            items.push({
                name: typeMatch[1],
                kind: 'type',
                signature: trimmed.slice(0, 80),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // Enum
        const enumMatch = trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/)
        if (enumMatch) {
            items.push({
                name: enumMatch[1],
                kind: 'enum',
                signature: trimmed.replace(/\s*\{.*$/, ''),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // Function / arrow function (top-level and exported)
        const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/)
        if (funcMatch && (!currentClass || braceDepth <= classStartDepth + 1)) {
            const item: OutlineItem = {
                name: funcMatch[1],
                kind: 'function',
                signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            }
            items.push(item)
            continue
        }

        // Exported const arrow function
        const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/)
        if (arrowMatch && (!currentClass || braceDepth <= classStartDepth + 1)) {
            items.push({
                name: arrowMatch[1],
                kind: 'function',
                signature: trimmed.replace(/\s*=>.*$/, '').replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // Class methods (inside a class)
        if (currentClass && braceDepth > classStartDepth) {
            const methodMatch = trimmed.match(/^(?:(?:public|private|protected|static|async|abstract|readonly|get|set)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/)
            if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('switch') && !trimmed.startsWith('return') && !trimmed.startsWith('new ')) {
                currentClass.children?.push({
                    name: methodMatch[1],
                    kind: 'method',
                    signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                    startLine: i + 1,
                    endLine: i + 1,
                    parent: currentClass.name,
                })
            }
        }

        // Close current class
        if (currentClass && braceDepth <= classStartDepth) {
            currentClass.endLine = i + 1
            currentClass = null
        }
    }

    // Close any open class
    if (currentClass) {
        currentClass.endLine = lines.length
    }

    return items
}

// ============================================
// Python Outline Parser
// ============================================

function parsePython(lines: string[]): OutlineItem[] {
    const items: OutlineItem[] = []
    let currentClass: OutlineItem | null = null

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        const indent = line.length - line.trimStart().length

        // Skip comments and empty lines
        if (trimmed.startsWith('#') || trimmed === '' || trimmed.startsWith('"""') || trimmed.startsWith("'''")) continue

        // Class
        const classMatch = trimmed.match(/^class\s+(\w+)(?:\s*\([^)]*\))?:/)
        if (classMatch) {
            currentClass = {
                name: classMatch[1],
                kind: 'class',
                signature: trimmed,
                startLine: i + 1,
                endLine: i + 1,
                children: [],
            }
            items.push(currentClass)
            continue
        }

        // Function / method
        const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/)
        if (funcMatch) {
            const isMethod = indent > 0 && currentClass
            const item: OutlineItem = {
                name: funcMatch[1],
                kind: isMethod ? 'method' : 'function',
                signature: trimmed.replace(/:$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
                parent: isMethod ? currentClass?.name : undefined,
            }

            if (isMethod && currentClass) {
                currentClass.children?.push(item)
            } else {
                items.push(item)
                if (indent === 0) currentClass = null
            }
            continue
        }

        // Decorator
        const decoMatch = trimmed.match(/^@(\w+(?:\.\w+)*)/)
        if (decoMatch) {
            // Peek next non-empty line for target
            continue // decorators are part of the next function/class
        }

        // Top-level assignment (important constants)
        if (indent === 0 && currentClass === null) {
            const assignMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*[:=]/)
            if (assignMatch) {
                items.push({
                    name: assignMatch[1],
                    kind: 'variable',
                    signature: trimmed.slice(0, 80),
                    startLine: i + 1,
                    endLine: i + 1,
                })
            }
        }
    }

    return items
}

// ============================================
// Go Outline Parser
// ============================================

function parseGo(lines: string[]): OutlineItem[] {
    const items: OutlineItem[] = []

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()

        // func
        const funcMatch = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/)
        if (funcMatch) {
            items.push({
                name: funcMatch[1],
                kind: 'function',
                signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // type struct/interface
        const typeMatch = trimmed.match(/^type\s+(\w+)\s+(struct|interface)\s*\{?/)
        if (typeMatch) {
            items.push({
                name: typeMatch[1],
                kind: typeMatch[2] === 'interface' ? 'interface' : 'class',
                signature: trimmed.replace(/\s*\{.*$/, ''),
                startLine: i + 1,
                endLine: i + 1,
            })
        }
    }

    return items
}

// ============================================
// Rust Outline Parser
// ============================================

function parseRust(lines: string[]): OutlineItem[] {
    const items: OutlineItem[] = []

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()

        // fn
        const fnMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/)
        if (fnMatch) {
            items.push({
                name: fnMatch[1],
                kind: 'function',
                signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // struct / enum
        const structMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+(\w+)/)
        if (structMatch) {
            items.push({
                name: structMatch[1],
                kind: trimmed.includes('enum') ? 'enum' : 'class',
                signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // trait
        const traitMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/)
        if (traitMatch) {
            items.push({
                name: traitMatch[1],
                kind: 'trait',
                signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            })
            continue
        }

        // impl
        const implMatch = trimmed.match(/^impl(?:\s*<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)/)
        if (implMatch) {
            items.push({
                name: implMatch[2] + (implMatch[1] ? ` (${implMatch[1]})` : ''),
                kind: 'impl',
                signature: trimmed.replace(/\s*\{.*$/, '').slice(0, 120),
                startLine: i + 1,
                endLine: i + 1,
            })
        }
    }

    return items
}

// ============================================
// Main: Get File Outline
// ============================================

export function getFileOutline(filePath: string): FileOutline {
    if (!existsSync(filePath)) {
        return {
            file: filePath,
            language: 'unknown',
            totalLines: 0,
            items: [],
            error: `File not found: ${filePath}`,
        }
    }

    const language = detectLanguage(filePath)
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch (err) {
        return {
            file: filePath,
            language,
            totalLines: 0,
            items: [],
            error: `Cannot read file: ${err}`,
        }
    }

    const lines = content.split('\n')
    let items: OutlineItem[]

    switch (language) {
        case 'typescript':
        case 'javascript':
            items = parseTypeScript(lines, content)
            break
        case 'python':
            items = parsePython(lines)
            break
        case 'go':
            items = parseGo(lines)
            break
        case 'rust':
            items = parseRust(lines)
            break
        default:
            // Generic: try TS parser as fallback (works for many C-like languages)
            items = parseTypeScript(lines, content)
            break
    }

    return {
        file: filePath,
        language,
        totalLines: lines.length,
        items,
    }
}

// ============================================
// View Code Item (by name)
// ============================================

export function viewCodeItem(
    filePath: string,
    itemName: string,
    contextLines = 0
): { found: boolean; name: string; content: string; startLine: number; endLine: number } {
    if (!existsSync(filePath)) {
        return { found: false, name: itemName, content: `File not found: ${filePath}`, startLine: 0, endLine: 0 }
    }

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const outline = getFileOutline(filePath)

    // Find item in outline (search in children too)
    const findItem = (items: OutlineItem[]): OutlineItem | null => {
        for (const item of items) {
            if (item.name === itemName) return item
            // Support Parent.method notation
            if (itemName.includes('.')) {
                const [parent, child] = itemName.split('.')
                if (item.name === parent && item.children) {
                    const found = item.children.find(c => c.name === child)
                    if (found) return found
                }
            }
            if (item.children) {
                const found = findItem(item.children)
                if (found) return found
            }
        }
        return null
    }

    const item = findItem(outline.items)
    if (!item) {
        return { found: false, name: itemName, content: `Symbol not found: ${itemName}`, startLine: 0, endLine: 0 }
    }

    // Find the actual end of the block by tracking braces
    let endLine = item.startLine
    let braceCount = 0
    let started = false

    for (let i = item.startLine - 1; i < lines.length; i++) {
        const line = lines[i]
        const opens = (line.match(/\{/g) || []).length
        const closes = (line.match(/\}/g) || []).length
        braceCount += opens - closes
        if (opens > 0) started = true
        if (started && braceCount <= 0) {
            endLine = i + 1
            break
        }
        endLine = i + 1
    }

    const start = Math.max(0, item.startLine - 1 - contextLines)
    const end = Math.min(lines.length, endLine + contextLines)
    const codeLines = lines.slice(start, end)

    return {
        found: true,
        name: itemName,
        content: codeLines.map((l, idx) => `${start + idx + 1}: ${l}`).join('\n'),
        startLine: start + 1,
        endLine: end,
    }
}

// ============================================
// Tool Definitions for Nova Registry
// ============================================

export const codeOutlineTool = {
    name: 'code_outline',
    description: 'Zeigt die Struktur einer Code-Datei: Klassen, Funktionen, Interfaces mit Signaturen und Zeilennummern. Unterstützt TS/JS, Python, Go, Rust.',
    category: 'file' as const,
    parameters: [
        { name: 'path', type: 'string' as const, description: 'Pfad zur Datei', required: true },
    ],
    handler: async (params: Record<string, unknown>) => {
        return getFileOutline(params.path as string)
    },
}

export const viewCodeItemTool = {
    name: 'view_code_item',
    description: 'Zeigt den vollständigen Code einer Funktion/Klasse/Methode anhand ihres Namens. Nutze z.B. "ClassName.methodName" für Methoden.',
    category: 'file' as const,
    parameters: [
        { name: 'path', type: 'string' as const, description: 'Pfad zur Datei', required: true },
        { name: 'name', type: 'string' as const, description: 'Name des Symbols (z.B. "MyClass", "myFunction", "MyClass.myMethod")', required: true },
        { name: 'context', type: 'number' as const, description: 'Extra Kontext-Zeilen vor/nach dem Symbol', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        return viewCodeItem(
            params.path as string,
            params.name as string,
            (params.context as number) || 0
        )
    },
}

export default { getFileOutline, viewCodeItem, codeOutlineTool, viewCodeItemTool }
