/**
 * Nova - Tool System
 * 
 * Enables LLM to call tools/functions:
 * - Tool registration with JSON Schema
 * - Execution with security checks
 * - Result formatting
 * 
 * Compatible with OpenAI function calling format.
 */

import { getSecurity } from '../resilience/security.js'

// ============================================
// Types
// ============================================

export interface ToolParameter {
    name: string
    type: 'string' | 'number' | 'boolean' | 'array' | 'object'
    description: string
    required?: boolean
    enum?: string[]
    default?: unknown
}

export interface ToolDefinition {
    name: string
    description: string
    parameters: ToolParameter[]
    category: 'browser' | 'file' | 'system' | 'memory' | 'communication' | 'other'
    requiresElevation?: boolean  // Needs admin permission
    handler: (params: Record<string, unknown>) => Promise<unknown>
}

export interface ToolCall {
    id: string
    name: string
    arguments: Record<string, unknown>
}

export interface ToolResult {
    toolCallId: string
    name: string
    success: boolean
    result?: unknown
    error?: string
    executionTimeMs: number
}

// OpenAI-compatible format
export interface OpenAITool {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: {
            type: 'object'
            properties: Record<string, unknown>
            required: string[]
        }
    }
}

// ============================================
// Tool Registry
// ============================================

export class ToolRegistry {
    private tools: Map<string, ToolDefinition> = new Map()
    private executionHistory: ToolResult[] = []
    private failureCount: Map<string, number> = new Map() // Track consecutive failures

    // ============================================
    // Registration
    // ============================================

    register(tool: ToolDefinition): void {
        this.tools.set(tool.name, tool)
        console.log(`[Tools] Registered: ${tool.name} (${tool.category})`)
    }

    unregister(name: string): void {
        this.tools.delete(name)
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name)
    }

    getAll(): ToolDefinition[] {
        return Array.from(this.tools.values())
    }

    getByCategory(category: string): ToolDefinition[] {
        return this.getAll().filter(t => t.category === category)
    }

    // ============================================
    // Execution
    // ============================================

    async execute(call: ToolCall, isElevatedUser = false): Promise<ToolResult> {
        const startTime = Date.now()
        const tool = this.tools.get(call.name)

        if (!tool) {
            return {
                toolCallId: call.id,
                name: call.name,
                success: false,
                error: `Tool not found: ${call.name}`,
                executionTimeMs: Date.now() - startTime,
            }
        }

        // Check elevation requirement
        if (tool.requiresElevation && !isElevatedUser) {
            return {
                toolCallId: call.id,
                name: call.name,
                success: false,
                error: `Tool requires admin permissions: ${call.name}`,
                executionTimeMs: Date.now() - startTime,
            }
        }

        // Validate parameters
        const validation = this.validateParams(tool, call.arguments)
        if (!validation.valid) {
            return {
                toolCallId: call.id,
                name: call.name,
                success: false,
                error: `Invalid parameters: ${validation.error}`,
                executionTimeMs: Date.now() - startTime,
            }
        }

        // Execute
        try {
            console.log(`[Tools] Executing: ${call.name}`)
            const result = await tool.handler(call.arguments)

            // Check if result indicates error (some tools return {error: ...} instead of throwing)
            const hasError = result && typeof result === 'object' && 'error' in result

            if (hasError) {
                // Track by TOOL NAME only — not params!
                // Nova often varies params between retries, which reset the counter
                const key = call.name
                const failures = (this.failureCount.get(key) || 0) + 1
                this.failureCount.set(key, failures)
                console.log(`[Registry] Tool "${call.name}" returned error (${failures}x)`)

                // Feed L15 Self-Check (tool health tracking)
                try {
                    const { reportToolFailure } = await import('../layers/L15-self-check.js')
                    reportToolFailure(call.name)
                } catch { /* L15 not available */ }

                // Feed L7 Tool Learning (auto-learn from failures)
                try {
                    const { getToolUsageLearner } = await import('../layers/L7-tool-learning.js')
                    const learner = getToolUsageLearner()
                    learner.recordUsage(call.name, 'auto-failure', call.arguments, false)
                } catch { /* L7 not available */ }

                // After 3 failures, trigger L8 Sub-Agent
                if (failures >= 3) {
                    console.log(`[Registry→L8] 🔍 3 failures reached, triggering sub-agent google search!`)
                    try {
                        const { getSubAgentManager } = await import('../layers/L8-sub-agent.js')
                        const manager = getSubAgentManager()
                        const error = (result as any).error || 'Unknown error'

                        await manager.spawnSearchAgent(
                            {
                                problem: `${call.name} ${error}`,
                                tool: call.name,
                                params: call.arguments,
                            },
                            async (solution) => tool.handler(call.arguments),
                            async (msg: string) => console.log(`[L8 Report] ${msg}`)
                        )
                    } catch (l8Err) {
                        console.log(`[Registry] L8 not available: ${l8Err}`)
                    }
                }
            } else {
                // Success - reset failure counter
                const key = call.name
                this.failureCount.set(key, 0)

                // Feed L15 Self-Check (clear tool health flag)
                try {
                    const { reportToolSuccess } = await import('../layers/L15-self-check.js')
                    reportToolSuccess(call.name)
                } catch { /* L15 not available */ }

                // Feed L7 Tool Learning (record successful usage)
                try {
                    const { getToolUsageLearner } = await import('../layers/L7-tool-learning.js')
                    const learner = getToolUsageLearner()
                    learner.recordUsage(call.name, 'auto-success', call.arguments, true)
                } catch { /* L7 not available */ }
            }

            const toolResult: ToolResult = {
                toolCallId: call.id,
                name: call.name,
                success: !hasError,
                result,
                executionTimeMs: Date.now() - startTime,
            }

            this.executionHistory.push(toolResult)
            return toolResult

        } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            console.error(`[Tools] Error in ${call.name}: ${error}`)

            // Track failure by tool name only (not params)
            const key = call.name
            const failures = (this.failureCount.get(key) || 0) + 1
            this.failureCount.set(key, failures)
            console.log(`[Registry] Tool "${call.name}" threw exception (${failures}x)`)

            // Feed L15 Self-Check (tool health tracking)
            try {
                const { reportToolFailure } = await import('../layers/L15-self-check.js')
                reportToolFailure(call.name)
            } catch { /* L15 not available */ }

            // Feed L7 Tool Learning (auto-learn from exceptions)
            try {
                const { getToolUsageLearner } = await import('../layers/L7-tool-learning.js')
                const learner = getToolUsageLearner()
                learner.recordUsage(call.name, 'auto-exception', call.arguments, false)
            } catch { /* L7 not available */ }

            // After 3 failures, trigger L8
            if (failures >= 3) {
                console.log(`[Registry→L8] 🔍 3 failures reached, triggering sub-agent google search!`)
                try {
                    const { getSubAgentManager } = await import('../layers/L8-sub-agent.js')
                    const manager = getSubAgentManager()
                    await manager.spawnSearchAgent(
                        {
                            problem: `${call.name} ${error}`,
                            tool: call.name,
                            params: call.arguments,
                        },
                        async (solution) => tool.handler(call.arguments),
                        async (msg: string) => console.log(`[L8 Report] ${msg}`)
                    )
                } catch (l8Err) {
                    console.log(`[Registry] L8 not available: ${l8Err}`)
                }
            }

            const toolResult: ToolResult = {
                toolCallId: call.id,
                name: call.name,
                success: false,
                error,
                executionTimeMs: Date.now() - startTime,
            }

            this.executionHistory.push(toolResult)
            return toolResult
        }
    }

    async executeMultiple(calls: ToolCall[], isElevatedUser = false): Promise<ToolResult[]> {
        return Promise.all(calls.map(call => this.execute(call, isElevatedUser)))
    }

    private validateParams(
        tool: ToolDefinition,
        args: Record<string, unknown>
    ): { valid: boolean; error?: string } {
        for (const param of tool.parameters) {
            if (param.required && !(param.name in args)) {
                return { valid: false, error: `Missing required parameter: ${param.name}` }
            }

            if (param.name in args) {
                const value = args[param.name]
                const actualType = Array.isArray(value) ? 'array' : typeof value

                if (actualType !== param.type && value !== undefined) {
                    return {
                        valid: false,
                        error: `Parameter ${param.name} should be ${param.type}, got ${actualType}`
                    }
                }

                if (param.enum && !param.enum.includes(String(value))) {
                    return {
                        valid: false,
                        error: `Parameter ${param.name} must be one of: ${param.enum.join(', ')}`
                    }
                }
            }
        }

        return { valid: true }
    }

    // ============================================
    // OpenAI Format
    // ============================================

    toOpenAIFormat(): OpenAITool[] {
        return this.getAll().map(tool => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: 'object' as const,
                    properties: Object.fromEntries(
                        tool.parameters.map(p => [
                            p.name,
                            {
                                type: p.type,
                                description: p.description,
                                ...(p.enum ? { enum: p.enum } : {}),
                            }
                        ])
                    ),
                    required: tool.parameters
                        .filter(p => p.required)
                        .map(p => p.name),
                },
            },
        }))
    }

    // ============================================
    // History
    // ============================================

    getHistory(limit = 50): ToolResult[] {
        return this.executionHistory.slice(-limit)
    }

    clearHistory(): void {
        this.executionHistory = []
    }

    getStats(): {
        totalTools: number
        totalExecutions: number
        successRate: number
        byCategory: Record<string, number>
    } {
        const executions = this.executionHistory
        const successful = executions.filter(e => e.success).length

        const byCategory: Record<string, number> = {}
        for (const tool of this.getAll()) {
            byCategory[tool.category] = (byCategory[tool.category] || 0) + 1
        }

        return {
            totalTools: this.tools.size,
            totalExecutions: executions.length,
            successRate: executions.length > 0 ? successful / executions.length : 0,
            byCategory,
        }
    }
}

// ============================================
// Built-in Tools
// ============================================

export function registerBuiltinTools(registry: ToolRegistry): void {
    const security = getSecurity()

    // --- Workspace Resolution Helper ---
    function getWorkspaceRoot(): string {
        const { existsSync, mkdirSync, readFileSync } = require('node:fs')
        const { join } = require('node:path')
        const { homedir } = require('node:os')

        // Try to read from config.json
        try {
            const configPath = join(process.cwd(), 'config.json')
            if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                if (config.workspace?.root) {
                    const wsRoot = config.workspace.root
                    if (!existsSync(wsRoot)) mkdirSync(wsRoot, { recursive: true })
                    return wsRoot
                }
            }
        } catch { /* fallback */ }

        // Default: ~/nova-workspace
        const defaultWs = join(homedir(), 'nova-workspace')
        if (!existsSync(defaultWs)) mkdirSync(defaultWs, { recursive: true })
        return defaultWs
    }

    // --- File Tools ---

    registry.register({
        name: 'read_file',
        description: 'Read the contents of a file',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'File path to read', required: true },
        ],
        handler: async (params) => {
            const path = params.path as string
            const check = security.checkPath(path)
            if (!check.allowed) throw new Error(check.reason)

            const { readFileSync } = await import('node:fs')
            return readFileSync(path, 'utf-8')
        },
    })

    // --- Universal Document Reader (PDF, DOCX, XLSX, PPTX, Images, etc.) ---

    registry.register({
        name: 'read_document',
        description: 'Liest JEDES Dateiformat: PDF, DOCX, XLSX, PPTX, Bilder, und mehr. Benutze dieses Tool statt read_file für Dokumente die nicht reiner Text sind. Erkennt das Format automatisch und verwendet die beste Methode (lokal, Python, oder VLM/Vision).',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Absoluter Pfad zur Datei', required: true },
        ],
        handler: async (params) => {
            const path = params.path as string
            const check = security.checkPath(path)
            if (!check.allowed) throw new Error(check.reason)

            const { readDocument } = await import('./document-reader.js')
            return await readDocument(path)
        },
    })

    registry.register({
        name: 'write_file',
        description: 'Write content to a file. Relative paths resolve to ~/nova-workspace/. Returns success status and the absolute path.',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'File path to write (relative paths go to ~/nova-workspace/)', required: true },
            { name: 'content', type: 'string', description: 'Content to write', required: true },
        ],
        handler: async (params) => {
            const { resolve, isAbsolute, dirname } = await import('node:path')
            const { writeFileSync, existsSync, mkdirSync } = await import('node:fs')

            const inputPath = params.path as string
            // Resolve relative paths to workspace, not cwd
            const absolutePath = isAbsolute(inputPath)
                ? inputPath
                : resolve(getWorkspaceRoot(), inputPath)
            const content = params.content as string

            const check = security.checkPath(absolutePath)
            if (!check.allowed) {
                return {
                    success: false,
                    error: check.reason,
                    path: absolutePath,
                    cwd: process.cwd()
                }
            }

            try {
                // Auto-create parent directories
                const dir = dirname(absolutePath)
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

                writeFileSync(absolutePath, content, 'utf-8')
                return { success: true, path: absolutePath, bytesWritten: content.length }
            } catch (err) {
                return {
                    success: false,
                    error: String(err),
                    path: absolutePath
                }
            }
        },
    })

    registry.register({
        name: 'list_directory',
        description: 'List files and folders in a directory',
        category: 'file',
        parameters: [
            { name: 'path', type: 'string', description: 'Directory path', required: true },
        ],
        handler: async (params) => {
            const path = params.path as string
            const check = security.checkPath(path)
            if (!check.allowed) throw new Error(check.reason)

            const { readdirSync, statSync } = await import('node:fs')
            const { join } = await import('node:path')

            const entries = readdirSync(path)
            return entries.map(name => {
                const fullPath = join(path, name)
                const stat = statSync(fullPath)
                return {
                    name,
                    type: stat.isDirectory() ? 'directory' : 'file',
                    size: stat.size,
                }
            })
        },
    })

    // --- System Tools ---

    registry.register({
        name: 'run_command',
        description: 'Execute a shell command',
        category: 'system',
        requiresElevation: true,
        parameters: [
            { name: 'command', type: 'string', description: 'Command to execute', required: true },
            { name: 'cwd', type: 'string', description: 'Working directory', required: false },
        ],
        handler: async (params) => {
            const command = params.command as string
            const cwd = params.cwd as string | undefined

            // Security check (existing)
            const check = security.checkCommand(command, true)
            if (!check.allowed) throw new Error(check.reason)

            // Database safety check (NEW - Prisma Guards)
            try {
                const { checkDatabaseSafety, formatBlockMessage } = await import('../layers/L8-prisma-guards.js')
                const dbCheck = checkDatabaseSafety(command)

                if (!dbCheck.safe) {
                    console.log(`[L8 PrismaGuards] ⚠️ Dangerous DB op detected: ${dbCheck.reason}`)

                    if (dbCheck.blocked || dbCheck.requiresConfirmation) {
                        return {
                            success: false,
                            blocked: true,
                            error: formatBlockMessage(dbCheck),
                            requiresConfirmation: dbCheck.requiresConfirmation,
                        }
                    }
                }
            } catch (guardErr) {
                // Guards not available, continue with normal execution
                console.log(`[Tools] Prisma guards not loaded: ${guardErr}`)
            }

            const { execSync } = await import('node:child_process')
            const output = execSync(command, {
                cwd,
                encoding: 'utf-8',
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024,
            })
            return { success: true, output: output.slice(0, 10000) }
        },
    })

    // --- SSH Tool for Remote Commands ---
    // Delegates to ssh-tool.ts which has full self-healing (password, key setup, auto-install)

    registry.register({
        name: 'ssh_command',
        description: 'Führe einen Befehl auf einem Remote-Server via SSH aus. Unterstützt Passwort-Authentifizierung und automatische Key-Einrichtung.',
        category: 'system',
        requiresElevation: true,
        parameters: [
            { name: 'host', type: 'string', description: 'Hostname oder IP (z.B. 192.0.2.30 oder nas.local)', required: true },
            { name: 'command', type: 'string', description: 'Befehl der ausgeführt werden soll', required: true },
            { name: 'user', type: 'string', description: 'SSH Benutzername', required: false },
            { name: 'port', type: 'number', description: 'SSH Port (default: 22)', required: false },
            { name: 'password', type: 'string', description: 'SSH Passwort (falls Key-Auth nicht möglich)', required: false },
        ],
        handler: async (params) => {
            const { executeSSH } = await import('./ssh-tool.js')
            return executeSSH({
                host: params.host as string,
                command: params.command as string,
                user: params.user as string | undefined,
                port: params.port as number | undefined,
                password: params.password as string | undefined,
            })
        },
    })

    // --- Send File Tool (Telegram: Photos, Documents, any file) ---

    registry.register({
        name: 'send_file',
        description: 'Sendet eine Datei an den User via Telegram. Erkennt automatisch ob Foto (jpg/png/gif/webp) oder Dokument (pdf/zip/txt/etc). Nutze dies um Screenshots, generierte Bilder, Reports, oder andere Dateien direkt zu senden.',
        category: 'communication',
        parameters: [
            { name: 'path', type: 'string', description: 'Absoluter Pfad zur Datei', required: true },
            { name: 'caption', type: 'string', description: 'Optionale Bildunterschrift/Beschreibung', required: false },
            { name: 'as_document', type: 'boolean', description: 'Erzwinge Versand als Dokument (auch für Bilder)', required: false },
        ],
        handler: async (params) => {
            const { executeSendFile } = await import('./send-file-tool.js')
            return await executeSendFile(params)
        },
    })

    // --- Image Generation Tool ---

    registry.register({
        name: 'generate_image',
        description: 'Generiert ein Bild mit KI (DALL-E 3 Image). Sendet das Bild automatisch an Telegram. Unterstützt verschiedene Seitenverhältnisse.',
        category: 'other',
        parameters: [
            { name: 'prompt', type: 'string', description: 'Beschreibung des zu generierenden Bildes (Englisch empfohlen)', required: true },
            { name: 'aspect_ratio', type: 'string', description: 'Seitenverhältnis: 1:1, 16:9, 9:16, 4:3, 3:4', required: false },
        ],
        handler: async (params) => {
            const { executeImageGen } = await import('./image-gen-tool.js')
            return await executeImageGen(params)
        },
    })

    // --- Browser Tools (Placeholder - will use nova pw-session when integrated) ---


    registry.register({
        name: 'browse_url',
        description: 'Öffne eine URL im Browser und erhalte den Seiteninhalt. Kann auch Screenshots machen.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'URL zum Öffnen', required: true },
            { name: 'screenshot', type: 'boolean', description: 'Screenshot machen? (default: false)', required: false },
            { name: 'headless', type: 'boolean', description: 'Browser im Hintergrund? (default: true)', required: false },
        ],
        handler: async (params) => {
            try {
                const { getBrowser } = await import('./browser.js')
                const browser = getBrowser({
                    headless: params.headless !== false,
                })

                await browser.launch()
                const content = await browser.goto(params.url as string)

                let screenshotPath: string | undefined
                if (params.screenshot) {
                    const result = await browser.screenshot()
                    screenshotPath = result.path
                }

                await browser.close()

                return {
                    success: true,
                    url: content.url,
                    title: content.title,
                    textLength: content.text.length,
                    linksCount: content.links.length,
                    screenshotPath,
                    text: content.text.slice(0, 5000),
                }
            } catch (err) {
                return {
                    success: false,
                    url: params.url,
                    error: `Browser-Fehler: ${err}`,
                }
            }
        },
    })

    registry.register({
        name: 'screenshot',
        description: 'Nimm einen Screenshot der aktuellen Browser-Seite auf',
        category: 'browser',
        parameters: [
            { name: 'name', type: 'string', description: 'Screenshot-Dateiname', required: false },
            { name: 'fullPage', type: 'boolean', description: 'Ganze Seite statt nur sichtbarer Bereich', required: false },
        ],
        handler: async (params) => {
            try {
                const { getBrowser } = await import('./browser.js')
                const browser = getBrowser()

                if (!browser.isRunning()) {
                    return { success: false, error: 'Kein Browser aktiv. Zuerst browse_url aufrufen.' }
                }

                const result = params.fullPage
                    ? await browser.screenshotFullPage(params.name as string)
                    : await browser.screenshot(params.name as string)

                return {
                    success: true,
                    path: result.path,
                    timestamp: result.timestamp,
                }
            } catch (err) {
                return { success: false, error: `Screenshot-Fehler: ${err}` }
            }
        },
    })

    registry.register({
        name: 'click_element',
        description: 'Klicke auf ein Element im Browser (per CSS-Selector oder Text)',
        category: 'browser',
        parameters: [
            { name: 'selector', type: 'string', description: 'CSS-Selector oder Button-Text', required: true },
            { name: 'double', type: 'boolean', description: 'Doppelklick?', required: false },
        ],
        handler: async (params) => {
            try {
                const { getBrowser } = await import('./browser.js')
                const browser = getBrowser()

                if (!browser.isRunning()) {
                    return { success: false, error: 'Kein Browser aktiv. Zuerst browse_url aufrufen.' }
                }

                await browser.click(params.selector as string)
                return { success: true, selector: params.selector }
            } catch (err) {
                return { success: false, error: `Click-Fehler: ${err}` }
            }
        },
    })

    registry.register({
        name: 'type_text',
        description: 'Tippe Text in ein Eingabefeld im Browser',
        category: 'browser',
        parameters: [
            { name: 'selector', type: 'string', description: 'CSS-Selector oder Placeholder-Text', required: true },
            { name: 'text', type: 'string', description: 'Text zum Eingeben', required: true },
            { name: 'submit', type: 'boolean', description: 'Enter nach Eingabe?', required: false },
        ],
        handler: async (params) => {
            try {
                const { getBrowser } = await import('./browser.js')
                const browser = getBrowser()

                if (!browser.isRunning()) {
                    return { success: false, error: 'Kein Browser aktiv. Zuerst browse_url aufrufen.' }
                }

                await browser.type(params.selector as string, params.text as string)
                if (params.submit) {
                    await browser.press('Enter')
                }
                return { success: true, selector: params.selector, text: params.text }
            } catch (err) {
                return { success: false, error: `Type-Fehler: ${err}` }
            }
        },
    })

    registry.register({
        name: 'browser_action',
        description: 'Führe eine Browser-Aktion in natürlicher Sprache aus (z.B. "öffne google und suche nach wetter")',
        category: 'browser',
        parameters: [
            { name: 'instruction', type: 'string', description: 'Was soll im Browser passieren?', required: true },
        ],
        handler: async (params) => {
            try {
                const { getBrowser } = await import('./browser.js')
                const browser = getBrowser()
                const instruction = (params.instruction as string).toLowerCase()

                // Parse natural language instruction
                if (instruction.includes('öffne') || instruction.includes('gehe zu') || instruction.includes('open')) {
                    const urlMatch = instruction.match(/(?:öffne|gehe zu|open)\s+(.+)/i)
                    if (urlMatch) {
                        let url = urlMatch[1].trim()
                        if (!url.startsWith('http')) {
                            url = instruction.includes('google') ? 'https://google.com' :
                                instruction.includes('youtube') ? 'https://youtube.com' :
                                    `https://${url}`
                        }
                        await browser.launch()
                        const content = await browser.goto(url)
                        return { success: true, action: 'navigate', url: content.url, title: content.title }
                    }
                }

                if (instruction.includes('suche') || instruction.includes('search')) {
                    const searchMatch = instruction.match(/(?:suche nach|search for|suche)\s+(.+)/i)
                    if (searchMatch) {
                        const query = searchMatch[1].trim()
                        await browser.launch()
                        await browser.goto(`https://google.com/search?q=${encodeURIComponent(query)}`)
                        return { success: true, action: 'search', query }
                    }
                }

                if (instruction.includes('screenshot')) {
                    const result = await browser.screenshot()
                    return { success: true, action: 'screenshot', path: result.path }
                }

                if (instruction.includes('schließe') || instruction.includes('close')) {
                    await browser.close()
                    return { success: true, action: 'close' }
                }

                return { success: false, error: `Befehl nicht erkannt: ${params.instruction}` }
            } catch (err) {
                return { success: false, error: `Browser-Action Fehler: ${err}` }
            }
        },
    })

    registry.register({
        name: 'browser_close',
        description: 'Schließe den Browser',
        category: 'browser',
        parameters: [],
        handler: async () => {
            try {
                const { getBrowser } = await import('./browser.js')
                const browser = getBrowser()
                await browser.close()
                return { success: true, message: 'Browser geschlossen' }
            } catch (err) {
                return { success: false, error: `Close-Fehler: ${err}` }
            }
        },
    })

    // --- Memory Tools ---

    registry.register({
        name: 'remember',
        description: 'Store something in memory for later',
        category: 'memory',
        parameters: [
            { name: 'key', type: 'string', description: 'Memory key', required: true },
            { name: 'value', type: 'string', description: 'Value to remember', required: true },
        ],
        handler: async (params) => {
            // This would integrate with the memory system
            return { stored: params.key }
        },
    })

    registry.register({
        name: 'recall',
        description: 'Recall something from memory',
        category: 'memory',
        parameters: [
            { name: 'query', type: 'string', description: 'What to recall', required: true },
        ],
        handler: async (params) => {
            // This would integrate with the memory system
            return { query: params.query, results: [] }
        },
    })

    // --- Web Search Tool (DuckDuckGo - no API key needed) ---

    registry.register({
        name: 'web_search',
        description: 'Suche im Internet mit DuckDuckGo. Gibt Titel, URL und Snippet der Ergebnisse zurück.',
        category: 'other',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchanfrage', required: true },
            { name: 'count', type: 'number', description: 'Anzahl Ergebnisse (max 10)', required: false },
        ],
        handler: async (params) => {
            const query = params.query as string
            const count = Math.min((params.count as number) || 5, 10)

            // Use DuckDuckGo's instant answer API (no key needed)
            const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`

            try {
                const res = await fetch(url, {
                    headers: { 'User-Agent': 'Nova AI Assistant' },
                    signal: AbortSignal.timeout(10000)
                })
                const data = await res.json() as {
                    Heading?: string
                    AbstractText?: string
                    AbstractURL?: string
                    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
                }

                const results = []

                // Add main abstract if exists
                if (data.AbstractText && data.AbstractURL) {
                    results.push({
                        title: data.Heading || query,
                        url: data.AbstractURL,
                        snippet: data.AbstractText.slice(0, 300),
                    })
                }

                // Add related topics
                if (data.RelatedTopics) {
                    for (const topic of data.RelatedTopics.slice(0, count - results.length)) {
                        if (topic.Text && topic.FirstURL) {
                            results.push({
                                title: topic.Text.split(' - ')[0] || topic.Text.slice(0, 80),
                                url: topic.FirstURL,
                                snippet: topic.Text.slice(0, 300),
                            })
                        }
                    }
                }

                return {
                    query,
                    count: results.length,
                    results,
                }
            } catch (err) {
                return {
                    query,
                    count: 0,
                    error: String(err),
                    results: [],
                }
            }
        },
    })

    // --- Desktop Screenshot Tool (Native, no Python/nut-js needed) ---

    registry.register({
        name: 'desktop_screenshot',
        description: 'Nimm einen Screenshot des gesamten Desktops auf. Funktioniert ohne Browser. Das Bild wird automatisch an die KI weitergeleitet zur Analyse UND (sofern send=true und Telegram aktiv) direkt an den Nutzer gesendet.',
        category: 'system',
        parameters: [
            { name: 'name', type: 'string', description: 'Optionaler Dateiname (ohne Endung)', required: false },
            { name: 'send', type: 'boolean', description: 'Screenshot direkt an den Nutzer senden (default: true)', required: false },
        ],
        handler: async (params) => {
            try {
                const { existsSync, mkdirSync, readFileSync } = await import('node:fs')
                const { join } = await import('node:path')
                const { execSync } = await import('node:child_process')

                const visionDir = join(process.cwd(), '.nova-vision')
                if (!existsSync(visionDir)) mkdirSync(visionDir, { recursive: true })

                const fileName = (params.name as string) || `desktop_${Date.now()}`
                const filePath = join(visionDir, `${fileName}.png`)

                const isWin = process.platform === 'win32'

                if (isWin) {
                    // PowerShell native screenshot — no dependencies needed
                    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$bounds = [System.Drawing.Rectangle]::Empty
foreach ($s in $screens) { $bounds = [System.Drawing.Rectangle]::Union($bounds, $s.Bounds) }
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save('${filePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'OK'`
                    execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`, { timeout: 15000 })
                } else if (process.platform === 'darwin') {
                    execSync(`screencapture -x "${filePath}"`, { timeout: 10000 })
                } else {
                    // Linux fallback
                    execSync(`import -window root "${filePath}" 2>/dev/null || scrot "${filePath}"`, { timeout: 10000 })
                }

                if (!existsSync(filePath)) {
                    return { success: false, error: 'Screenshot konnte nicht erstellt werden.' }
                }

                // Read as base64 for LLM vision
                const imageBuffer = readFileSync(filePath)
                const base64 = imageBuffer.toString('base64')

                console.log(`[Desktop] 📸 Screenshot: ${filePath} (${(imageBuffer.length / 1024).toFixed(0)} KB)`)

                // Auto-send to the user (default true) so we never claim "sent"
                // without actually sending. Capture stays separate from delivery:
                // the base64 still flows back to the LLM for real vision analysis.
                let sentMsg = ''
                if (params.send !== false) {
                    try {
                        const { executeSendFile } = await import('./send-file-tool.js')
                        const sendResult = await executeSendFile({
                            path: filePath,
                            caption: 'Screenshot vom Desktop 📸',
                            chat_id: params.chat_id,
                        })
                        sentMsg = ` | ${sendResult}`
                        console.log(`[Desktop] 📤 ${sendResult}`)
                    } catch (sendErr) {
                        sentMsg = ` | ⚠️ Senden fehlgeschlagen: ${sendErr}`
                        console.log(`[Desktop] ⚠️ Auto-send failed: ${sendErr}`)
                    }
                }

                return {
                    success: true,
                    path: filePath,
                    screenshotPath: filePath,
                    imageBase64: base64,
                    imageMimeType: 'image/png',
                    size: imageBuffer.length,
                    message: `Screenshot gespeichert: ${filePath}${sentMsg}`,
                }
            } catch (err) {
                return { success: false, error: `Screenshot-Fehler: ${err}` }
            }
        },
    })

    // --- Vision Tool (L10) ---

    registry.register({
        name: 'check_ui',
        description: 'Screenshot einer Webseite aufnehmen und mit KI auf Layout/CSS-Fehler analysieren',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'URL der Webseite', required: true },
            { name: 'context', type: 'string', description: 'Optionaler Kontext (z.B. "Prüfe den Login-Button")', required: false },
        ],
        handler: async (params) => {
            try {
                const { getVisionAnalyzer } = await import('../layers/L10-vision.js')
                const vision = getVisionAnalyzer()

                const url = params.url as string
                const context = params.context as string | undefined

                const analysis = await vision.captureAndAnalyze(url, context)

                return {
                    success: true,
                    url,
                    screenshotPath: analysis.screenshotPath,
                    summary: analysis.summary,
                    issueCount: analysis.issues.length,
                    issues: analysis.issues,
                    suggestions: analysis.suggestions,
                    formatted: vision.formatAnalysis(analysis),
                }
            } catch (err) {
                return {
                    success: false,
                    error: `Vision-Analyse fehlgeschlagen: ${err}`,
                }
            }
        },
    })

    // --- QA/Testing Tools (L12) ---

    registry.register({
        name: 'run_tests',
        description: 'Tests im Projekt ausführen (Jest/Vitest). Zeigt Ergebnis mit bestandenen/fehlgeschlagenen Tests.',
        category: 'system',
        parameters: [
            { name: 'path', type: 'string', description: 'Projektpfad (optional, default: aktuelles Verzeichnis)', required: false },
            { name: 'filter', type: 'string', description: 'Test-Filter (z.B. "auth" für auth.test.ts)', required: false },
        ],
        handler: async (params) => {
            try {
                const { getQAAgent } = await import('../layers/L12-qa-agent.js')
                const qa = getQAAgent()

                const path = (params.path as string) || process.cwd()
                const filter = params.filter as string | undefined

                const result = await qa.runTests(path, filter)

                return {
                    success: result.success,
                    framework: result.framework,
                    passed: result.passed,
                    failed: result.failed,
                    skipped: result.skipped,
                    duration: result.duration,
                    errors: result.errors.slice(0, 5),
                    formatted: qa.formatResult(result),
                }
            } catch (err) {
                return { success: false, error: `Tests fehlgeschlagen: ${err}` }
            }
        },
    })

    registry.register({
        name: 'generate_tests',
        description: 'Generiert automatisch Unit-Tests für eine Datei mittels KI (TDD-Support).',
        category: 'system',
        parameters: [
            { name: 'file', type: 'string', description: 'Pfad zur Quell-Datei', required: true },
            { name: 'intent', type: 'string', description: 'Was soll getestet werden?', required: false },
        ],
        handler: async (params) => {
            try {
                const { getQAAgent } = await import('../layers/L12-qa-agent.js')
                const qa = getQAAgent()

                const file = params.file as string
                const intent = params.intent as string | undefined

                const testPath = await qa.generateAndSaveTests(file, intent)

                if (testPath) {
                    return {
                        success: true,
                        testFile: testPath,
                        message: `Tests generiert: ${testPath}`,
                    }
                } else {
                    return { success: false, error: 'Keine Tests generiert' }
                }
            } catch (err) {
                return { success: false, error: `Test-Generierung fehlgeschlagen: ${err}` }
            }
        },
    })

    // --- AST/Code Understanding Tools (L13) ---

    registry.register({
        name: 'analyze_impact',
        description: 'Analysiert welche Dateien von einer Änderung betroffen sind (Dependency Graph).',
        category: 'other',
        parameters: [
            { name: 'file', type: 'string', description: 'Pfad zur geänderten Datei', required: true },
        ],
        handler: async (params) => {
            try {
                const { getASTAnalyzer } = await import('../layers/L13-ast-analyzer.js')
                const ast = getASTAnalyzer()

                await ast.buildRepoMap()
                const impact = ast.analyzeImpact(params.file as string)

                return {
                    success: true,
                    file: impact.changedFile,
                    riskLevel: impact.riskLevel,
                    totalImpact: impact.totalImpact,
                    directDependents: impact.directDependents,
                    indirectDependents: impact.indirectDependents.slice(0, 10),
                    formatted: ast.formatImpact(impact),
                }
            } catch (err) {
                return { success: false, error: `Impact-Analyse fehlgeschlagen: ${err}` }
            }
        },
    })

    registry.register({
        name: 'explain_architecture',
        description: 'Erklärt die Architektur des Repositories (Kern-Module, Entry Points, Verzeichnisse).',
        category: 'other',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zum Repository (optional, default: aktuelles Verzeichnis)', required: false },
        ],
        handler: async (params) => {
            try {
                const { getASTAnalyzer } = await import('../layers/L13-ast-analyzer.js')
                const rootPath = params.path as string | undefined
                const ast = getASTAnalyzer(rootPath)

                const summary = await ast.explainArchitecture()

                return {
                    success: true,
                    summary,
                }
            } catch (err) {
                return { success: false, error: `Architektur-Analyse fehlgeschlagen: ${err}` }
            }
        },
    })

    // --- Cost Tracker Tool (L14) ---

    registry.register({
        name: 'cost_status',
        description: 'Zeigt API-Kosten und Budget-Status an.',
        category: 'other',
        parameters: [],
        handler: async () => {
            try {
                const { getCostTracker } = await import('../layers/L14-cost-tracker.js')
                const tracker = getCostTracker()

                const today = tracker.getTodayStats()
                const remaining = tracker.getRemainingBudget()

                return {
                    success: true,
                    today: {
                        requests: today.totalRequests,
                        tokens: today.totalTokens,
                        cost: today.totalCost / 100,  // Convert to dollars
                    },
                    remaining: {
                        daily: remaining.daily / 100,
                        monthly: remaining.monthly / 100,
                    },
                    formatted: tracker.formatStatus(),
                }
            } catch (err) {
                return { success: false, error: `Cost Tracker nicht verfügbar: ${err}` }
            }
        },
    })

    // --- Security Scanner Tool (L15) ---

    registry.register({
        name: 'security_scan',
        description: 'Scannt Code auf Sicherheitslücken (OWASP, SQL Injection, XSS, etc.).',
        category: 'other',
        parameters: [
            { name: 'path', type: 'string', description: 'Pfad zum Scannen (optional, default: aktuelles Verzeichnis)', required: false },
        ],
        handler: async (params) => {
            try {
                const { getSecurityScanner } = await import('../layers/L15-security-scanner.js')
                const scanner = getSecurityScanner()

                const path = (params.path as string) || process.cwd()
                const result = await scanner.scanDirectory(path)

                return {
                    success: true,
                    passed: result.passed,
                    scannedFiles: result.scannedFiles,
                    summary: result.summary,
                    issues: result.issues.slice(0, 10),
                    formatted: scanner.formatResult(result),
                }
            } catch (err) {
                return { success: false, error: `Security Scan fehlgeschlagen: ${err}` }
            }
        },
    })

    // --- Business Sense Tool (L16) ---

    registry.register({
        name: 'clarify',
        description: 'Analysiert eine Anforderung auf Klarheit und generiert Rückfragen bei vagen Anforderungen.',
        category: 'other',
        parameters: [
            { name: 'request', type: 'string', description: 'Die zu analysierende Anforderung', required: true },
        ],
        handler: async (params) => {
            try {
                const { getBusinessSenseAnalyzer } = await import('../layers/L16-business-sense.js')
                const analyzer = getBusinessSenseAnalyzer()

                const request = params.request as string
                const result = await analyzer.analyzeRequest(request)

                return {
                    success: true,
                    needsClarification: result.needsClarification,
                    confidence: result.confidence,
                    questions: result.questions,
                    analysis: result.analysis,
                    formatted: analyzer.formatClarificationRequest(result),
                }
            } catch (err) {
                return { success: false, error: `Analyse fehlgeschlagen: ${err}` }
            }
        },
    })


    // --- Autonomous Mission Tool ---
    // Lets Nova self-trigger autonomous multi-step task chains

    registry.register({
        name: 'start_autonomous_mission',
        description: 'Starte eine autonome Mission mit mehreren Schritten. Nutze dies wenn der User eine komplexe Aufgabe gibt die mehrere Schritte erfordert (z.B. "baue eine App", "erstelle ein Projekt mit Tests"). Nova zerlegt das Ziel in Sub-Tasks und arbeitet sie nacheinander autonom ab.',
        category: 'system',
        parameters: [
            { name: 'goal', type: 'string', description: 'Das Gesamtziel der Mission (was soll am Ende erreicht sein?)', required: true },
            { name: 'userId', type: 'string', description: 'User-ID des Auftraggebers', required: false },
            { name: 'channel', type: 'string', description: 'Kanal (telegram/discord/cli)', required: false },
        ],
        handler: async (params) => {
            try {
                const { startMission, getActiveMission } = await import('../core/autonomous-executor.js')

                // Check if mission is already running
                const active = getActiveMission()
                if (active && active.status === 'active') {
                    return {
                        success: false,
                        error: `Eine Mission läuft bereits: "${active.goal.slice(0, 60)}". Erst /mission stop um sie zu beenden.`,
                        currentMission: active.goal.slice(0, 100),
                    }
                }

                const goal = params.goal as string
                const userId = (params.userId as string) || 'system'
                const channel = (params.channel as string) || 'telegram'

                const mission = await startMission(goal, userId, channel)

                return {
                    success: true,
                    missionId: mission.id,
                    goal: mission.goal,
                    steps: mission.steps.length,
                    stepDescriptions: mission.steps.map(s => s.description),
                    message: `🚀 Mission gestartet! ${mission.steps.length} Schritte werden autonom abgearbeitet.`,
                }
            } catch (err: any) {
                return {
                    success: false,
                    error: `Mission konnte nicht gestartet werden: ${err?.message || err}`,
                }
            }
        },
    })

    registry.register({
        name: 'mission_status',
        description: 'Zeige den aktuellen Status einer laufenden autonomen Mission an.',
        category: 'system',
        parameters: [],
        handler: async () => {
            try {
                const { getMissionStatus, getActiveMission } = await import('../core/autonomous-executor.js')
                const active = getActiveMission()
                return {
                    success: true,
                    hasActiveMission: !!active,
                    status: getMissionStatus(),
                    progress: active ? {
                        goal: active.goal,
                        done: active.steps.filter(s => s.status === 'done').length,
                        failed: active.steps.filter(s => s.status === 'failed').length,
                        total: active.steps.length,
                        currentStep: active.currentStep,
                    } : null,
                }
            } catch (err: any) {
                return { success: false, error: String(err) }
            }
        },
    })

    console.log(`[Tools] Registered ${registry.getAll().length} built-in tools`)
}

// ============================================
// Global Instance
// ============================================

let registryInstance: ToolRegistry | null = null

export function getToolRegistry(): ToolRegistry {
    if (!registryInstance) {
        registryInstance = new ToolRegistry()
        registerBuiltinTools(registryInstance)
    }
    return registryInstance
}

export function createToolRegistry(): ToolRegistry {
    return new ToolRegistry()
}

export default { ToolRegistry, getToolRegistry, createToolRegistry, registerBuiltinTools }
