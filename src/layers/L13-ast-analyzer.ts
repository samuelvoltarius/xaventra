/**
 * L13 AST Analyzer - Deep Code Understanding via Repository Map
 * 
 * Builds and maintains a graph of code dependencies:
 * - Import/Export relationships
 * - Class/Function definitions
 * - Impact analysis (what breaks if I change this?)
 * - Usage tracking
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, dirname, basename, extname } from 'node:path'

// ============================================
// Types
// ============================================

export interface CodeNode {
    id: string              // Unique identifier (file:symbol)
    path: string            // File path
    type: 'file' | 'class' | 'function' | 'interface' | 'type' | 'const' | 'variable'
    name: string            // Symbol name
    line?: number           // Line number
    exports: string[]       // What this node exports
    imports: ImportInfo[]   // What this node imports
    dependencies: string[]  // Node IDs this depends on
    dependents: string[]    // Node IDs that depend on this
}

export interface ImportInfo {
    from: string            // Module path
    items: string[]         // Imported items (or ['*'] for namespace)
    isDefault: boolean
    isTypeOnly: boolean
}

export interface RepoGraph {
    rootPath: string
    nodes: Map<string, CodeNode>
    files: Map<string, CodeNode>  // File-level nodes
    lastUpdated: number
}

export interface ImpactAnalysis {
    changedFile: string
    directDependents: string[]
    indirectDependents: string[]
    totalImpact: number
    riskLevel: 'low' | 'medium' | 'high'
    suggestion?: string
}

// ============================================
// AST Analyzer
// ============================================

const CACHE_DIR = '.nova-repo-map'

export class ASTAnalyzer {
    private graph: RepoGraph | null = null
    private rootPath: string

    constructor(rootPath: string = process.cwd()) {
        this.rootPath = rootPath
        console.log(`[L13 AST] Analyzer initialized for: ${rootPath}`)
    }

    // ============================================
    // Graph Building
    // ============================================

    async buildRepoMap(forceRebuild = false): Promise<RepoGraph> {
        console.log(`[L13 AST] Building repository map...`)

        // Check cache
        if (!forceRebuild && this.graph) {
            return this.graph
        }

        const cachePath = join(this.rootPath, CACHE_DIR, 'graph.json')
        if (!forceRebuild && existsSync(cachePath)) {
            try {
                const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
                // Convert Maps from JSON
                cached.nodes = new Map(Object.entries(cached.nodes))
                cached.files = new Map(Object.entries(cached.files))
                this.graph = cached as RepoGraph
                console.log(`[L13 AST] Loaded cached graph (${this.graph.nodes.size} nodes)`)
                return this.graph
            } catch (err) {
                console.log(`[L13 AST] Cache invalid, rebuilding`)
            }
        }

        // Build fresh graph
        this.graph = {
            rootPath: this.rootPath,
            nodes: new Map(),
            files: new Map(),
            lastUpdated: Date.now(),
        }

        // Find all TypeScript/JavaScript files
        const files = this.findSourceFiles(this.rootPath)
        console.log(`[L13 AST] Found ${files.length} source files`)

        // Parse each file
        for (const file of files) {
            await this.parseFile(file)
        }

        // Build dependency graph
        this.resolveDependencies()

        // Save cache
        this.saveCache()

        console.log(`[L13 AST] Built graph with ${this.graph.nodes.size} nodes`)
        return this.graph
    }

    private findSourceFiles(dir: string, files: string[] = []): string[] {
        const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.nova-', '__tests__']
        const extensions = ['.ts', '.tsx', '.js', '.jsx']

        try {
            const entries = readdirSync(dir)

            for (const entry of entries) {
                const fullPath = join(dir, entry)

                if (excludeDirs.some(ex => entry.startsWith(ex))) continue

                try {
                    const stat = statSync(fullPath)

                    if (stat.isDirectory()) {
                        this.findSourceFiles(fullPath, files)
                    } else if (extensions.includes(extname(entry))) {
                        files.push(fullPath)
                    }
                } catch { }
            }
        } catch { }

        return files
    }

    private async parseFile(filePath: string): Promise<void> {
        const relPath = relative(this.rootPath, filePath)
        const content = readFileSync(filePath, 'utf-8')

        // Create file node
        const fileNode: CodeNode = {
            id: `file:${relPath}`,
            path: relPath,
            type: 'file',
            name: basename(filePath),
            exports: [],
            imports: [],
            dependencies: [],
            dependents: [],
        }

        // Parse imports using regex (simple but effective)
        const importRegex = /import\s+(?:type\s+)?(?:(\{[^}]+\})|(\*\s+as\s+\w+)|(\w+))?\s*(?:,\s*(?:(\{[^}]+\})|(\w+)))?\s*from\s+['"]([^'"]+)['"]/g

        let match
        while ((match = importRegex.exec(content)) !== null) {
            const namedImports = match[1] || match[4]
            const namespaceImport = match[2]
            const defaultImport = match[3] || match[5]
            const fromPath = match[6]

            const items: string[] = []

            if (namedImports) {
                // Parse {a, b, c as d}
                const cleaned = namedImports.replace(/[{}]/g, '').trim()
                items.push(...cleaned.split(',').map(s => s.trim().split(' as ')[0]))
            }
            if (namespaceImport) {
                items.push('*')
            }
            if (defaultImport) {
                items.push(defaultImport)
            }

            fileNode.imports.push({
                from: fromPath,
                items,
                isDefault: !!defaultImport && !namedImports,
                isTypeOnly: match[0].includes('import type'),
            })
        }

        // Parse exports
        const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g
        while ((match = exportRegex.exec(content)) !== null) {
            fileNode.exports.push(match[1])
        }

        // Named exports: export { a, b }
        const namedExportRegex = /export\s+\{([^}]+)\}/g
        while ((match = namedExportRegex.exec(content)) !== null) {
            const items = match[1].split(',').map(s => s.trim().split(' as ')[0])
            fileNode.exports.push(...items)
        }

        // Re-exports: export * from
        const reExportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g
        while ((match = reExportRegex.exec(content)) !== null) {
            fileNode.imports.push({
                from: match[1],
                items: ['*'],
                isDefault: false,
                isTypeOnly: false,
            })
        }

        this.graph!.nodes.set(fileNode.id, fileNode)
        this.graph!.files.set(relPath, fileNode)
    }

    private resolveDependencies(): void {
        for (const [nodeId, node] of this.graph!.nodes) {
            for (const imp of node.imports) {
                const resolvedPath = this.resolveImportPath(node.path, imp.from)
                if (resolvedPath) {
                    const depId = `file:${resolvedPath}`

                    // Add to dependencies
                    if (!node.dependencies.includes(depId)) {
                        node.dependencies.push(depId)
                    }

                    // Add to dependents of target
                    const depNode = this.graph!.nodes.get(depId)
                    if (depNode && !depNode.dependents.includes(nodeId)) {
                        depNode.dependents.push(nodeId)
                    }
                }
            }
        }
    }

    private resolveImportPath(fromFile: string, importPath: string): string | null {
        // Skip external modules
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            return null
        }

        const fromDir = dirname(fromFile)
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']

        for (const ext of extensions) {
            const candidate = join(fromDir, importPath + ext)
            const fullPath = join(this.rootPath, candidate)

            if (existsSync(fullPath)) {
                return candidate.replace(/\\/g, '/')
            }
        }

        // Try without extension (might already have one)
        const direct = join(fromDir, importPath)
        const fullDirect = join(this.rootPath, direct)
        if (existsSync(fullDirect)) {
            return direct.replace(/\\/g, '/')
        }

        return null
    }

    private saveCache(): void {
        const cacheDir = join(this.rootPath, CACHE_DIR)
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true })
        }

        const cachePath = join(cacheDir, 'graph.json')

        // Convert Maps to objects for JSON
        const serializable = {
            ...this.graph,
            nodes: Object.fromEntries(this.graph!.nodes),
            files: Object.fromEntries(this.graph!.files),
        }

        writeFileSync(cachePath, JSON.stringify(serializable, null, 2))
    }

    // ============================================
    // Impact Analysis
    // ============================================

    analyzeImpact(filePath: string): ImpactAnalysis {
        if (!this.graph) {
            this.buildRepoMap()
        }

        const relPath = relative(this.rootPath, filePath).replace(/\\/g, '/')
        const nodeId = `file:${relPath}`
        const node = this.graph!.nodes.get(nodeId)

        if (!node) {
            return {
                changedFile: relPath,
                directDependents: [],
                indirectDependents: [],
                totalImpact: 0,
                riskLevel: 'low',
            }
        }

        // Direct dependents
        const directDependents = node.dependents.map(id => id.replace('file:', ''))

        // Indirect dependents (BFS)
        const indirectDependents: string[] = []
        const visited = new Set<string>([nodeId])
        const queue = [...node.dependents]

        while (queue.length > 0) {
            const currentId = queue.shift()!
            if (visited.has(currentId)) continue
            visited.add(currentId)

            const current = this.graph!.nodes.get(currentId)
            if (current) {
                if (!directDependents.includes(current.path)) {
                    indirectDependents.push(current.path)
                }
                queue.push(...current.dependents)
            }
        }

        const totalImpact = directDependents.length + indirectDependents.length
        let riskLevel: 'low' | 'medium' | 'high' = 'low'

        if (totalImpact > 10) riskLevel = 'high'
        else if (totalImpact > 3) riskLevel = 'medium'

        let suggestion: string | undefined
        if (riskLevel === 'high') {
            suggestion = `⚠️ Hohe Auswirkung! ${totalImpact} Dateien betroffen. Führe alle Tests aus bevor du committest.`
        }

        return {
            changedFile: relPath,
            directDependents,
            indirectDependents,
            totalImpact,
            riskLevel,
            suggestion,
        }
    }

    // ============================================
    // Queries
    // ============================================

    getDependenciesOf(filePath: string): string[] {
        if (!this.graph) this.buildRepoMap()

        const relPath = relative(this.rootPath, filePath).replace(/\\/g, '/')
        const nodeId = `file:${relPath}`
        const node = this.graph!.nodes.get(nodeId)

        if (!node) return []
        return node.dependencies.map(id => id.replace('file:', ''))
    }

    getDependentsOf(filePath: string): string[] {
        if (!this.graph) this.buildRepoMap()

        const relPath = relative(this.rootPath, filePath).replace(/\\/g, '/')
        const nodeId = `file:${relPath}`
        const node = this.graph!.nodes.get(nodeId)

        if (!node) return []
        return node.dependents.map(id => id.replace('file:', ''))
    }

    findUsagesOf(symbolName: string): string[] {
        if (!this.graph) this.buildRepoMap()

        const usages: string[] = []

        for (const [_, node] of this.graph!.nodes) {
            for (const imp of node.imports) {
                if (imp.items.includes(symbolName) || imp.items.includes('*')) {
                    usages.push(node.path)
                }
            }
        }

        return usages
    }

    // ============================================
    // Architecture Summary
    // ============================================

    async explainArchitecture(): Promise<string> {
        if (!this.graph) await this.buildRepoMap()

        const nodes = Array.from(this.graph!.nodes.values())
        const fileNodes = nodes.filter(n => n.type === 'file')

        // Group by directory
        const byDir: Map<string, CodeNode[]> = new Map()
        for (const node of fileNodes) {
            const dir = dirname(node.path) || '.'
            if (!byDir.has(dir)) byDir.set(dir, [])
            byDir.get(dir)!.push(node)
        }

        // Find core files (most dependents)
        const coreFiles = fileNodes
            .sort((a, b) => b.dependents.length - a.dependents.length)
            .slice(0, 5)

        // Find entry points (no dependents, has exports)
        const entryPoints = fileNodes
            .filter(n => n.dependents.length === 0 && n.exports.length > 0)
            .slice(0, 5)

        let summary = `# Repository Architektur\n\n`
        summary += `📁 **${this.rootPath}**\n\n`
        summary += `## Statistiken\n`
        summary += `- ${fileNodes.length} Dateien\n`
        summary += `- ${byDir.size} Verzeichnisse\n\n`

        summary += `## Kern-Module (meiste Dependents)\n`
        for (const file of coreFiles) {
            summary += `- \`${file.path}\` (${file.dependents.length} Dependents)\n`
        }

        summary += `\n## Entry Points\n`
        for (const file of entryPoints) {
            summary += `- \`${file.path}\` (exportiert: ${file.exports.join(', ')})\n`
        }

        summary += `\n## Verzeichnisse\n`
        for (const [dir, files] of byDir) {
            summary += `- \`${dir}/\` (${files.length} Dateien)\n`
        }

        return summary
    }

    // ============================================
    // Format for User
    // ============================================

    formatImpact(analysis: ImpactAnalysis): string {
        const riskIcon = {
            'low': '🟢',
            'medium': '🟡',
            'high': '🔴',
        }[analysis.riskLevel]

        let msg = `${riskIcon} **Impact Analysis: ${analysis.changedFile}**\n\n`

        msg += `**Risiko:** ${analysis.riskLevel.toUpperCase()}\n`
        msg += `**Betroffene Dateien:** ${analysis.totalImpact}\n\n`

        if (analysis.directDependents.length > 0) {
            msg += `**Direkt abhängig (${analysis.directDependents.length}):**\n`
            for (const dep of analysis.directDependents.slice(0, 5)) {
                msg += `  • ${dep}\n`
            }
            if (analysis.directDependents.length > 5) {
                msg += `  • ... und ${analysis.directDependents.length - 5} weitere\n`
            }
        }

        if (analysis.indirectDependents.length > 0) {
            msg += `\n**Indirekt abhängig (${analysis.indirectDependents.length}):**\n`
            for (const dep of analysis.indirectDependents.slice(0, 3)) {
                msg += `  • ${dep}\n`
            }
            if (analysis.indirectDependents.length > 3) {
                msg += `  • ... und ${analysis.indirectDependents.length - 3} weitere\n`
            }
        }

        if (analysis.suggestion) {
            msg += `\n${analysis.suggestion}\n`
        }

        return msg
    }
}

// ============================================
// Singleton
// ============================================

let astAnalyzer: ASTAnalyzer | null = null

export function getASTAnalyzer(rootPath?: string): ASTAnalyzer {
    if (!astAnalyzer || (rootPath && rootPath !== astAnalyzer['rootPath'])) {
        astAnalyzer = new ASTAnalyzer(rootPath)
    }
    return astAnalyzer
}

export default { ASTAnalyzer, getASTAnalyzer }
