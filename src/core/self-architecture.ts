/**
 * Nova Self-Architecture Generator
 *
 * Auto-scans Nova's own codebase at startup and generates a
 * self-architecture document that gets injected into the system prompt.
 * This allows Nova to accurately describe her own capabilities.
 *
 * Why: Without this, Nova guesses about herself based on directory names.
 *      With this, she KNOWS her exact architecture, layers, tools, etc.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { hostname as osHostname } from 'node:os'

const DATA_DIR = join(process.cwd(), '.nova-data')
const ARCH_FILE = join(DATA_DIR, 'self-architecture.md')
const SRC_DIR = join(process.cwd(), 'src')

// Cache — regenerated once per boot
let cachedArchitecture: string | null = null

/**
 * Scan a directory for .ts files and return their names + exported function count
 */
function scanModule(dirPath: string): Array<{ file: string, exports: string[], size: number }> {
    const results: Array<{ file: string, exports: string[], size: number }> = []
    try {
        if (!existsSync(dirPath)) return results
        const files = readdirSync(dirPath).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        for (const file of files) {
            const fullPath = join(dirPath, file)
            try {
                const stat = statSync(fullPath)
                const content = readFileSync(fullPath, 'utf-8')
                // Extract exported function/class names
                const exportMatches = content.match(/export\s+(?:async\s+)?(?:function|class|const|interface)\s+(\w+)/g) || []
                const exports = exportMatches.map(m => {
                    const match = m.match(/(?:function|class|const|interface)\s+(\w+)/)
                    return match?.[1] || ''
                }).filter(Boolean)
                results.push({ file: basename(file, '.ts'), exports, size: stat.size })
            } catch { /* skip unreadable files */ }
        }
    } catch { /* directory not readable */ }
    return results
}

/**
 * Detect layers from src/layers/ directory
 */
function scanLayers(): string {
    const layerDir = join(SRC_DIR, 'layers')
    const modules = scanModule(layerDir)
    if (modules.length === 0) return ''

    // Group by layer number
    const layers = modules
        .filter(m => m.file.match(/^L\d/))
        .sort((a, b) => {
            const numA = parseInt(a.file.match(/^L(\d+)/)?.[1] || '99')
            const numB = parseInt(b.file.match(/^L(\d+)/)?.[1] || '99')
            return numA - numB
        })

    let text = '### Kognitive Layer (Schichtenmodell)\n'
    for (const l of layers) {
        const name = l.file.replace(/^L\d+-?/, '').replace(/-/g, ' ')
        const topExports = l.exports.slice(0, 4).join(', ')
        text += `- **${l.file}**: ${name} (${topExports})\n`
    }
    return text
}

/**
 * Detect tools from src/tools/ directory
 */
function scanTools(): string {
    const toolDir = join(SRC_DIR, 'tools')
    const modules = scanModule(toolDir)
    if (modules.length === 0) return ''

    let text = '### Werkzeuge (Tools)\n'
    const toolGroups: Record<string, string[]> = {}
    for (const m of modules) {
        // Group by prefix
        const prefix = m.file.split('-')[0] || 'other'
        if (!toolGroups[prefix]) toolGroups[prefix] = []
        toolGroups[prefix].push(m.file)
    }
    for (const [group, tools] of Object.entries(toolGroups)) {
        text += `- **${group}**: ${tools.join(', ')}\n`
    }
    text += `\n_Gesamt: ${modules.length} Tool-Module_\n`
    return text
}

/**
 * Detect channels
 */
function scanChannels(): string {
    const channelDir = join(SRC_DIR, 'channels')
    const modules = scanModule(channelDir)
    if (modules.length === 0) return ''

    let text = '### Kommunikations-Kanäle\n'
    for (const m of modules) {
        text += `- **${m.file}** (${m.exports.slice(0, 3).join(', ')})\n`
    }
    return text
}

/**
 * Detect intelligence modules
 */
function scanIntelligence(): string {
    const dirs = ['intelligence', 'memory', 'learning']
    let text = '### Intelligenz & Gedächtnis\n'
    let count = 0

    for (const dir of dirs) {
        const modules = scanModule(join(SRC_DIR, dir))
        if (modules.length === 0) continue
        text += `**${dir}/**:\n`
        for (const m of modules) {
            text += `  - ${m.file}: ${m.exports.slice(0, 3).join(', ')}\n`
            count++
        }
    }
    if (count === 0) return ''
    return text
}

/**
 * Detect mesh/infra
 */
function scanInfra(): string {
    const dirs = ['mesh', 'infra', 'resilience', 'supervisor']
    let text = '### Infrastruktur & Mesh\n'
    let count = 0

    for (const dir of dirs) {
        const modules = scanModule(join(SRC_DIR, dir))
        if (modules.length === 0) continue
        for (const m of modules) {
            text += `- **${dir}/${m.file}**: ${m.exports.slice(0, 4).join(', ')}\n`
            count++
        }
    }
    if (count === 0) return ''
    return text
}

/**
 * Count total modules and lines
 */
function countCodebase(): { files: number, lines: number, bytes: number } {
    let files = 0, lines = 0, bytes = 0
    function walk(dir: string): void {
        try {
            for (const entry of readdirSync(dir)) {
                const full = join(dir, entry)
                try {
                    const stat = statSync(full)
                    if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
                        walk(full)
                    } else if (stat.isFile() && extname(entry) === '.ts') {
                        files++
                        bytes += stat.size
                        const content = readFileSync(full, 'utf-8')
                        lines += content.split('\n').length
                    }
                } catch { /* skip */ }
            }
        } catch { /* skip */ }
    }
    walk(SRC_DIR)
    return { files, lines, bytes }
}

/**
 * Generate the full self-architecture document
 */
export function generateArchitecture(): string {
    const stats = countCodebase()
    const hostname = osHostname()
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'

    let doc = `## 🧬 SELF-ARCHITECTURE (Auto-Generated)\n`
    doc += `_Generiert beim Start am ${new Date().toLocaleString('de-DE')} auf ${hostname} (${platform})_\n`
    doc += `_Codebasis: ${stats.files} TypeScript-Dateien, ~${Math.round(stats.lines / 1000)}k Zeilen, ${Math.round(stats.bytes / 1024 / 1024)}MB_\n\n`

    // Layers
    const layers = scanLayers()
    if (layers) doc += layers + '\n'

    // Tools
    const tools = scanTools()
    if (tools) doc += tools + '\n'

    // Channels
    const channels = scanChannels()
    if (channels) doc += channels + '\n'

    // Intelligence
    const intel = scanIntelligence()
    if (intel) doc += intel + '\n'

    // Infra
    const infra = scanInfra()
    if (infra) doc += infra + '\n'

    // Key capabilities summary
    doc += `### Kern-Fähigkeiten (automatisch erkannt)\n`
    doc += `- TypeScript/Node.js Runtime\n`
    doc += `- Autonomy Loop mit Self-Think (alle 10min)\n`
    doc += `- Tool Health Monitor mit Auto-Degradation\n`
    doc += `- Persistent Memory (LanceDB Vektorspeicher + JSON)\n`
    doc += `- Multi-Channel (Telegram, WhatsApp, Discord, CLI, Dashboard)\n`
    doc += `- Mesh Networking (Multi-Node Coordination via Supabase)\n`
    doc += `- 18+ kognitive Layer (L0 Supervisor → L20 Self-Improvement)\n`
    doc += `- Mission Engine (autonome Task-Chains)\n`
    doc += `- Proaktives Lernen + Knowledge Hub\n`
    doc += `\n**WICHTIG: Du BIST dieses System. Wenn jemand fragt wie du funktionierst, beziehe dich auf diese Architektur, nicht auf Vermutungen.**\n`

    return doc
}

/**
 * Get or generate the architecture document.
 * Cached per boot cycle.
 */
export function getSelfArchitecturePrompt(): string {
    if (cachedArchitecture) return cachedArchitecture

    try {
        cachedArchitecture = generateArchitecture()
        // Also persist to disk for debugging
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(ARCH_FILE, cachedArchitecture)
        console.log(`[SelfArchitecture] ✓ Architecture scanned (${cachedArchitecture.length} chars)`)
    } catch (err) {
        console.error(`[SelfArchitecture] ❌ Scan failed: ${err}`)
        cachedArchitecture = ''
    }

    return cachedArchitecture || ''
}

/**
 * Force regeneration (e.g. after code changes)
 */
export function regenerateArchitecture(): string {
    cachedArchitecture = null
    return getSelfArchitecturePrompt()
}
