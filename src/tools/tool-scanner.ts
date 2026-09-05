/**
 * Nova Tool Scanner — Auto-Discovery
 *
 * Inspired by Hermes-Agent's plugin pattern.
 * Scans dist/tools/*.js at runtime and auto-registers any exported NovaTool[].
 *
 * Convention: a tool file exports one or more arrays named *Tools or *Tool:
 *   export const minimaxTools: NovaTool[] = [...]
 *   export const printerTools: NovaTool[] = [...]
 *   export default { tools: [...] }  // also supported
 *
 * No need to edit complete-registry.ts when adding new tool files — they are
 * auto-discovered.
 *
 * Usage:
 *   const tools = await scanTools()
 *   // or: append scanned tools to existing ALL_TOOLS
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NovaTool } from './complete-registry.js'

// ============================================
// Tool File Discovery
// ============================================

/** Files that should NOT be scanned (not tool files) */
const EXCLUDED_FILES = new Set([
    'complete-registry.js',
    'tool-scanner.js',
    'tool-router.js',
    'tool-policy.js',
    'tool-confirmation.js',
    'loop-detection.js',
    'registry.js',
    'executor.js',
    'skills-import-cli.js',
])

/** Patterns that indicate a NovaTool export */
const TOOL_ARRAY_PATTERNS = [
    /^(\w+Tools?)$/,        // minimaxTools, printerTools, homeAssistantTools
    /^(all\w+)$/i,         // allTools (with case insensitive)
]

function isToolArray(value: unknown): value is NovaTool[] {
    return Array.isArray(value) &&
        value.length > 0 &&
        typeof (value[0] as any)?.name === 'string' &&
        typeof (value[0] as any)?.handler === 'function'
}

function isSingleTool(value: unknown): value is NovaTool {
    return typeof value === 'object' && value !== null &&
        typeof (value as any).name === 'string' &&
        typeof (value as any).handler === 'function' &&
        !Array.isArray(value)
}

// ============================================
// Scanner
// ============================================

interface ScanResult {
    tools: NovaTool[]
    sources: string[]
    skipped: string[]
    errors: string[]
}

let _scanCache: { result: ScanResult; timestamp: number } | null = null
const CACHE_TTL = 60_000  // 1 minute

export async function scanTools(forceFresh = false): Promise<ScanResult> {
    if (!forceFresh && _scanCache && Date.now() - _scanCache.timestamp < CACHE_TTL) {
        return _scanCache.result
    }

    // In production, scan dist/tools/; in dev, use dynamic import from src
    const toolsDir = join(process.cwd(), 'dist', 'tools')
    const result: ScanResult = { tools: [], sources: [], skipped: [], errors: [] }

    if (!existsSync(toolsDir)) {
        console.log('[ToolScanner] dist/tools/ not found — skipping auto-scan')
        return result
    }

    const files = readdirSync(toolsDir)
        .filter(f => f.endsWith('.js') && !EXCLUDED_FILES.has(f))
        .sort()

    for (const file of files) {
        const filePath = join(toolsDir, file)
        try {
            const mod = await import(`file://${filePath}`)
            const discovered: NovaTool[] = []

            // Check all named exports
            for (const [exportName, exportValue] of Object.entries(mod)) {
                if (exportName === 'default') continue

                // Array exports: minimaxTools, printerTools, etc.
                const matchesPattern = TOOL_ARRAY_PATTERNS.some(p => p.test(exportName))
                if (matchesPattern && isToolArray(exportValue)) {
                    discovered.push(...exportValue)
                    continue
                }

                // Single tool exports: saveConfigTool, apiKeyTool, etc.
                if (isSingleTool(exportValue) && exportName.toLowerCase().includes('tool')) {
                    discovered.push(exportValue as NovaTool)
                }
            }

            // Check default export for tools array
            if (mod.default) {
                if (isToolArray(mod.default)) {
                    discovered.push(...mod.default)
                } else if (mod.default?.tools && isToolArray(mod.default.tools)) {
                    discovered.push(...mod.default.tools)
                }
            }

            if (discovered.length > 0) {
                result.tools.push(...discovered)
                result.sources.push(`${file} (${discovered.length} tools)`)
            } else {
                result.skipped.push(file)
            }
        } catch (err) {
            result.errors.push(`${file}: ${err}`)
        }
    }

    // Deduplicate by name (later files override earlier ones)
    const seen = new Map<string, NovaTool>()
    for (const tool of result.tools) {
        seen.set(tool.name, tool)
    }
    result.tools = Array.from(seen.values())

    _scanCache = { result, timestamp: Date.now() }

    if (result.sources.length > 0) {
        console.log(`[ToolScanner] ✅ Auto-discovered ${result.tools.length} tools from ${result.sources.length} files`)
    }
    if (result.errors.length > 0) {
        console.log(`[ToolScanner] ⚠️ ${result.errors.length} scan errors:`, result.errors.join(', '))
    }

    return result
}

/**
 * Get only the extra tools discovered by auto-scan (not in complete-registry).
 * Used to append to ALL_TOOLS without duplicates.
 */
export async function getScannedExtraTools(existingToolNames: Set<string>): Promise<NovaTool[]> {
    const { tools } = await scanTools()
    return tools.filter(t => !existingToolNames.has(t.name))
}

export function clearScanCache(): void {
    _scanCache = null
}

export default { scanTools, getScannedExtraTools, clearScanCache }
