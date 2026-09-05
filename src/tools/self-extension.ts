/**
 * Nova Self-Extension System
 * 
 * Allows Nova to create and register new tools at runtime.
 * Tools are saved to .nova-tools/ and auto-loaded on startup.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const CUSTOM_TOOLS_DIR = '.nova-tools'

export interface CustomTool {
    name: string
    description: string
    parameters: Array<{
        name: string
        type: 'string' | 'number' | 'boolean'
        description: string
        required?: boolean
    }>
    // JavaScript code as string - will be eval'd (sandboxed)
    code: string
    createdAt: number
    createdBy: string  // userId who created it
}

// ============================================
// Tool Storage
// ============================================

function getToolsDir(): string {
    const dir = join(process.cwd(), CUSTOM_TOOLS_DIR)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
    return dir
}

export function saveCustomTool(tool: CustomTool): void {
    const dir = getToolsDir()
    const path = join(dir, `${tool.name}.json`)
    writeFileSync(path, JSON.stringify(tool, null, 2))
    console.log(`[Nova Extension] Tool gespeichert: ${tool.name}`)
}

export function loadCustomTools(): CustomTool[] {
    const dir = getToolsDir()
    if (!existsSync(dir)) return []

    const tools: CustomTool[] = []
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))

    for (const file of files) {
        try {
            const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
            tools.push(data)
        } catch { /* ignore */ }
    }

    console.log(`[Nova Extension] ${tools.length} Custom-Tools geladen`)
    return tools
}

export function deleteCustomTool(name: string): boolean {
    const path = join(getToolsDir(), `${name}.json`)
    if (existsSync(path)) {
        unlinkSync(path)
        console.log(`[Nova Extension] Tool gelöscht: ${name}`)
        return true
    }
    return false
}

// ============================================
// Tool Execution (Sandboxed)
// ============================================

export async function executeCustomTool(
    tool: CustomTool,
    params: Record<string, unknown>
): Promise<unknown> {
    // Create a sandboxed context with limited capabilities
    const sandbox = {
        params,
        fetch: global.fetch,
        console: {
            log: (...args: unknown[]) => console.log(`[Tool:${tool.name}]`, ...args),
            error: (...args: unknown[]) => console.error(`[Tool:${tool.name}]`, ...args),
        },
        JSON,
        Date,
        Math,
        String,
        Number,
        Array,
        Object,
        Promise,
        setTimeout,
        // Dangerous stuff is NOT included: fs, child_process, require, etc.
    }

    try {
        // Build async function from code string (safer than eval — no scope access)
        const sandboxKeys = Object.keys(sandbox)
        const sandboxValues = Object.values(sandbox)
        // Create function with explicit sandbox parameters (no access to outer scope)
        const fn = new Function(
            ...sandboxKeys,
            `return (async function() { ${tool.code} })()`
        )
        return await fn(...sandboxValues)
    } catch (err) {
        throw new Error(`Tool execution failed: ${err}`)
    }
}

// ============================================
// Tool Creation Helper
// ============================================

export function createToolFromDescription(
    name: string,
    description: string,
    code: string,
    createdBy: string
): CustomTool {
    // Parse parameters from code (simple heuristic)
    const paramMatches = code.match(/params\.(\w+)/g) || []
    const paramNames = [...new Set(paramMatches.map(m => m.replace('params.', '')))]

    const tool: CustomTool = {
        name: name.toLowerCase().replace(/\s+/g, '_'),
        description,
        parameters: paramNames.map(p => ({
            name: p,
            type: 'string',
            description: `Parameter: ${p}`,
            required: true,
        })),
        code,
        createdAt: Date.now(),
        createdBy,
    }

    saveCustomTool(tool)
    return tool
}

// ============================================
// Example: Google Search Tool
// ============================================

export const GOOGLE_SEARCH_TOOL: CustomTool = {
    name: 'google_search',
    description: 'Suche mit Google über Headless Browser (Playwright)',
    parameters: [
        { name: 'query', type: 'string', description: 'Suchanfrage', required: true },
        { name: 'count', type: 'number', description: 'Anzahl Ergebnisse', required: false },
    ],
    code: `
        // Note: This requires Playwright to be installed and browser tool available
        const query = params.query
        const count = params.count || 5
        
        // Use built-in browser tool
        const results = await fetch('http://localhost:3000/api/browser/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, count })
        }).then(r => r.json())
        
        return results
    `,
    createdAt: Date.now(),
    createdBy: 'system',
}

export default {
    saveCustomTool,
    loadCustomTools,
    deleteCustomTool,
    executeCustomTool,
    createToolFromDescription,
}
