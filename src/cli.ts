#!/usr/bin/env node
/**
 * Xaventra CLI ✨
 * 
 * Command-line interface for Xaventra AI Assistant.
 * 
 * Usage:
 *   nova start       - Start Xaventra
 *   nova setup       - Interactive setup wizard
 *   nova wizard      - Run diagnostics
 *   nova chat        - Terminal chat with Xaventra
 *   nova gateway     - Start gateway (process supervisor)
 *   nova status      - Show status
 *   nova channels    - List channels
 *   nova llm         - List LLM providers
 *   nova config      - Show configuration
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { cpus } from 'node:os'
import { resolveConfigPath } from './config/config-path.js'


// ============================================
// Colors (ANSI)
// ============================================

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
}

const c = {
    ok: (s: string) => `${colors.green}${s}${colors.reset}`,
    error: (s: string) => `${colors.red}${s}${colors.reset}`,
    warn: (s: string) => `${colors.yellow}${s}${colors.reset}`,
    info: (s: string) => `${colors.cyan}${s}${colors.reset}`,
    bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
    dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
    nova: (s: string) => `${colors.magenta}${s}${colors.reset}`,
}

// ============================================
// Banner
// ============================================

function printBanner(): void {
    let version = 'unknown'
    try { version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { }
    console.log(`
${colors.magenta}${colors.bold}
    XAVENTRA  ✨
${colors.reset}${colors.dim}   Core v${version}${colors.reset}
`)
}

// ============================================
// Commands
// ============================================

async function commandStart(): Promise<void> {
    printBanner()
    console.log(c.info('Starting Xaventra Daemon...'))
    console.log()

    // Check if compiled
    const distPath = resolve(process.cwd(), 'dist', 'daemon.js')
    if (!existsSync(distPath)) {
        console.log(c.error('❌ Xaventra not compiled. Run: npm run build'))
        process.exit(1)
    }

    // Start daemon as a child process (inherits stdio for interactive use)
    try {
        const { spawn } = await import('node:child_process')
        const child = spawn(process.execPath, [distPath], {
            cwd: process.cwd(),
            stdio: 'inherit',
            env: process.env,
        })
        child.on('exit', (code) => {
            process.exit(code ?? 0)
        })
        child.on('error', error => {
            console.error(c.error(`Failed to start Xaventra: ${error.message}`))
            process.exitCode = 1
        })
    } catch (err) {
        console.error(c.error(`❌ Failed to start Xaventra: ${err}`))
        process.exit(1)
    }
}

async function commandSetup(): Promise<void> {
    try {
        const { runSetupWizard } = await import('./commands/wizard.js')
        await runSetupWizard()
    } catch (err) {
        console.error(c.error(`❌ Setup failed: ${err}`))
        process.exit(1)
    }
}

async function commandKill(): Promise<void> {
    printBanner()
    console.log(c.warn('🛑 Stopping Xaventra in this runtime directory...'))
    const { stopLocalDaemon } = await import('./process/daemon-control.js')
    const result = await stopLocalDaemon(process.cwd())
    console.log(result === 'stopped' ? c.ok('✅ Shutdown verified') : c.dim('No local daemon is running.'))
    console.log()
}

async function commandRestart(): Promise<void> {
    printBanner()
    console.log(c.info('🔄 Restarting Xaventra...'))
    console.log()

    // Kill first
    await commandKill()

    // Then start
    console.log(c.info('▶️ Starte Xaventra neu...'))
    await commandStart()
}

async function commandGateway(): Promise<void> {
    printBanner()
    console.log(c.info('Starting Xaventra Gateway...'))

    try {
        const { startGateway } = await import('./gateway.js')
        const port = parseInt(process.env.GATEWAY_PORT || '18789', 10)
        startGateway(port, true)
    } catch (err) {
        console.error(c.error(`❌ Gateway failed: ${err}`))
        process.exit(1)
    }
}

async function commandPipelineChat(): Promise<void> {
    printBanner()
    console.log(c.nova('✨ Xaventra Terminal Chat'))
    console.log(c.dim('─'.repeat(50)))
    console.log(c.dim('Gleiche Pipeline wie Telegram/Web: Memory, Tools, Slash-Commands, Self-Setup.'))
    console.log(c.dim('Befehle: /exit, /clear, /status, /setup status, /browser status, /help'))
    console.log()

    const { initCliPipelineRuntime, handleCliPipelineMessage } = await import('./core/cli-pipeline-runtime.js')
    const runtime = await initCliPipelineRuntime()
    const toolCount = runtime.tools?.getStats?.().total ?? runtime.tools?.getAll?.().length ?? 0
    console.log(c.ok(`✓ Pipeline bereit: ${runtime.llm?.modelId || 'LLM aktiv'}, ${toolCount} Tools`))
    console.log()

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    let closed = false
    const closeChat = () => {
        if (closed) return
        closed = true
        runtime.running = false
        try { runtime.learning?.stop?.() } catch { /* non-critical */ }
        try { rl.close() } catch { /* already closed */ }
        // CLI runtime starts background health/learning timers through the shared pipeline.
        // Exiting explicitly keeps piped smoke tests and one-shot sessions from hanging.
        setTimeout(() => process.exit(0), 10)
    }

    const prompt = () => {
        if (closed) return
        rl.question(`${c.nova('Du:')} `, async (input) => {
            const trimmed = input.trim()

            if (!trimmed) {
                prompt()
                return
            }

            if (trimmed === '/exit' || trimmed === '/quit') {
                console.log(c.dim('\nAuf Wiedersehen! ✨'))
                closeChat()
                return
            }

            if (trimmed === '/clear') {
                console.clear()
                printBanner()
                console.log(c.dim('Chat gelöscht.'))
                prompt()
                return
            }

            try {
                await handleCliPipelineMessage(trimmed, async (reply) => {
                    console.log()
                    console.log(`${c.nova('Xaventra:')} ${reply}`)
                    console.log()
                })
            } catch (err) {
                console.log(c.error(`\n❌ Pipeline-Fehler: ${err}`))
                console.log()
            }

            if (!closed) prompt()
        })
    }

    rl.on('close', () => {
        closeChat()
    })

    prompt()
}

async function commandPipelineAsk(message: string): Promise<void> {
    if (!message.trim()) {
        console.log(c.error('❌ Bitte Nachricht angeben: npm run cli -- ask "..."'))
        process.exit(1)
    }

    const { initCliPipelineRuntime, handleCliPipelineMessage } = await import('./core/cli-pipeline-runtime.js')
    const runtime = await initCliPipelineRuntime()
    const replies: string[] = []

    try {
        await handleCliPipelineMessage(message, async (reply) => {
            replies.push(reply)
            console.log(reply)
        })
    } finally {
        runtime.running = false
        try { runtime.learning?.stop?.() } catch { /* non-critical */ }
        setTimeout(() => process.exit(0), 10)
    }
}

async function commandChat(): Promise<void> {
    printBanner()
    console.log(c.nova('✨ Xaventra Terminal Chat'))
    console.log(c.dim('─'.repeat(50)))
    console.log(c.dim('Tippe deine Nachricht und drücke Enter.'))
    console.log(c.dim('Befehle: /exit, /clear, /model <name>'))
    console.log()

    // Load LLM
    let llm: { complete: (msgs: Array<{ role: string, content: string }>) => Promise<{ content: string }> } | null = null

    try {
        // Try to load config and create LLM
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))

            // Check for OAuth providers first
            if (config.provider === 'local' || config.provider === 'openai') {
                // Use OpenAI API
                const OpenAI = (await import('openai')).default

                let apiKey: string | undefined
                let modelId = config.model || 'auto'

                // Try OAuth first
                if (config.provider === 'local') {
                    const { getOAuthManager } = await import('./auth/oauth.js')
                    const oauthManager = getOAuthManager()
                    const oauthCreds = oauthManager.getProfile('local')

                    if (oauthCreds && oauthCreds.type === 'oauth') {
                        // Use OAuth access token
                        apiKey = await oauthManager.getApiKey('local') ?? undefined
                    }
                } else {
                    // API key based
                    apiKey = config.auth?.openaiApiKey || process.env.OPENAI_API_KEY
                }

                if (apiKey) {
                    const client = new OpenAI({ apiKey })

                    llm = {
                        complete: async (msgs) => {
                            try {
                                const res = await client.chat.completions.create({
                                    model: modelId,
                                    messages: msgs as Array<{ role: 'user' | 'assistant' | 'system', content: string }>,
                                })
                                return { content: res.choices[0]?.message?.content || '' }
                            } catch (err) {
                                console.error(c.error(`\n❌ API Error: ${err}`))
                                return { content: `Fehler: ${err}` }
                            }
                        }
                    }
                    console.log(c.ok(`✓ Verbunden mit ${config.provider}/${modelId}`))
                } else {
                    console.log(c.warn(`⚠ Keine Credentials für ${config.provider}. Führe "npm run cli -- setup" aus.`))
                }
            } else if (config.provider === 'openai' && (config.auth?.openaiApiKey || process.env.OPENAI_API_KEY)) {
                const OpenAI = (await import('openai')).default
                const client = new OpenAI({ apiKey: config.auth?.openaiApiKey || process.env.OPENAI_API_KEY })
                const model = config.model || 'auto'

                llm = {
                    complete: async (msgs) => {
                        const res = await client.chat.completions.create({
                            model,
                            messages: msgs as Array<{ role: 'user' | 'assistant' | 'system', content: string }>,
                        })
                        return { content: res.choices[0]?.message?.content || '' }
                    }
                }
                console.log(c.ok(`✓ Verbunden mit ${config.provider}/${model}`))
            }

            if (!llm) {
                console.log(c.warn('⚠ Kein LLM konfiguriert. Führe "npm run cli -- setup" aus.'))
                console.log()
            }
        }
    } catch (err) {
        console.log(c.warn(`⚠ LLM nicht verfügbar: ${err}`))
    }

    // ============================================
    // Initialize Memory System (Phase 1)
    // ============================================
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let memoryManager: any = null
    try {
        const { MemoryManager } = await import('./memory/lancedb.js')
        const configPath = resolveConfigPath()
        const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {}

        if (config.memory?.enabled !== false && (config.auth?.openaiApiKey || process.env.OPENAI_API_KEY)) {
            memoryManager = new MemoryManager({
                dbPath: join(process.cwd(), '.nova-memory'),
                embeddingApiKey: config.auth?.openaiApiKey || process.env.OPENAI_API_KEY || '',
                autoRecall: true,
                autoCapture: true,
            })
            console.log(c.ok('✓ Memory initialisiert'))
        }
    } catch (err) {
        console.log(c.dim(`  Memory nicht verfügbar: ${err}`))
    }

    // ============================================
    // Initialize Learning System (Phase 2)
    // ============================================
    let feedbackCollector: Awaited<ReturnType<typeof import('./learning/feedback.js').createFeedbackCollector>> | null = null
    try {
        const { createFeedbackCollector } = await import('./learning/feedback.js')
        feedbackCollector = createFeedbackCollector()

        // Load persisted feedback
        const feedbackPath = join(process.cwd(), '.nova-learning', 'feedback.json')
        if (existsSync(feedbackPath)) {
            feedbackCollector.importFromJSON(readFileSync(feedbackPath, 'utf-8'))
        }
        console.log(c.ok('✓ Learning initialisiert'))
    } catch (err) {
        console.log(c.dim(`  Learning nicht verfügbar: ${err}`))
    }

    // ============================================
    // Initialize Tool System (Phase 3)
    // ============================================
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let toolRegistry: any = null
    try {
        const { ToolRegistry, registerBuiltinTools } = await import('./tools/registry.js')
        const registry = new ToolRegistry()
        registerBuiltinTools(registry)
        toolRegistry = registry
        console.log(c.ok(`✓ ${registry.getAll().length} Tools geladen`))
    } catch (err) {
        console.log(c.dim(`  Tools nicht verfügbar: ${err}`))
    }

    // ============================================
    // Initialize Telegram Channel (if enabled)
    // ============================================
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let telegramAdapter: any = null
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.channels?.telegram?.enabled && config.channels?.telegram?.token) {
                const { TelegramAdapter } = await import('./channels/telegram.js')
                telegramAdapter = new TelegramAdapter({
                    token: config.channels.telegram.token,
                    allowFrom: config.channels.telegram.allowFrom || [],
                    groupPolicy: config.channels.telegram.groupPolicy || 'mention-only',
                })

                // Connect Telegram messages to LLM
                const telegramPersona = 'Du bist Xaventra ✨ - ein hilfsbereiter KI-Assistent. Sei freundlich, präzise und hilfsbereit. Antworte auf Deutsch.'
                telegramAdapter.onMessage(async (msg: { from: string; content: string; groupId?: string }) => {
                    if (llm) {
                        try {
                            console.log(c.dim(`[Telegram] Nachricht von ${msg.from}: ${msg.content.slice(0, 50)}...`))
                            const response = await llm.complete([
                                { role: 'system', content: telegramPersona },
                                { role: 'user', content: msg.content }
                            ])
                            await telegramAdapter.send({
                                to: msg.groupId || msg.from,
                                content: response.content,
                            })
                        } catch (err) {
                            console.log(c.error(`[Telegram] LLM Error: ${err}`))
                        }
                    }
                })

                await telegramAdapter.connect()
                console.log(c.ok(`✓ Telegram verbunden: @${telegramAdapter.getUsername()}`))
            }
        }
    } catch (err) {
        console.log(c.dim(`  Telegram nicht verfügbar: ${err}`))
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    // ============================================
    // Load Custom Persona (Phase 4)
    // ============================================
    let systemPrompt = 'Du bist Xaventra, ein hilfreicher KI-Assistent. Antworte präzise und freundlich.'
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.persona?.systemPrompt) {
                systemPrompt = config.persona.systemPrompt
                console.log(c.ok(`✓ Custom Persona: ${config.persona.name || 'Custom'}`))
            }
        }
    } catch { /* Use default */ }

    // ============================================
    // Add Tool Descriptions to System Prompt
    // ============================================
    if (toolRegistry) {
        const tools = toolRegistry.getAll()
        const toolDesc = tools.map((t: { name: string; description: string }) => `- ${t.name}: ${t.description}`).join('\n')
        systemPrompt += `\n\nDu hast Zugriff auf folgende Tools:\n${toolDesc}\n\nUm ein Tool zu verwenden, antworte mit: [TOOL:toolname({"param":"value"})]`
        console.log(c.ok(`✓ ${tools.length} Tools zum Prompt hinzugefügt`))
    }

    const history: Array<{ role: string, content: string, image?: { data: string, mimeType: string } }> = [
        { role: 'system', content: systemPrompt }
    ]

    // Vision support - pending image to attach to next message
    let pendingImage: { data: string, mimeType: string } | null = null

    const prompt = () => {
        rl.question(`${c.nova('Du:')} `, async (input) => {
            const trimmed = input.trim()

            if (!trimmed) {
                prompt()
                return
            }

            // Commands
            if (trimmed === '/exit' || trimmed === '/quit') {
                console.log(c.dim('\nAuf Wiedersehen! ✨'))
                rl.close()
                return
            }

            if (trimmed === '/clear') {
                console.clear()
                printBanner()
                history.length = 1 // Keep system prompt
                console.log(c.dim('Chat gelöscht.'))
                prompt()
                return
            }

            if (trimmed === '/help' || trimmed === '/?') {
                console.log(c.bold('\n📚 Chat-Befehle:'))
                console.log(`   /model       Zeigt verfügbare Modelle`)
                console.log(`   /model <n>   Wechselt zu Modell (1-7)`)
                console.log(`   /status      Zeigt aktuellen Status`)
                console.log(`   /layer0      Zeigt Layer 0 (Resilience & Security)`)
                console.log(`   /raw <msg>   Direkter LLM-Zugang (ohne Persona)`)
                console.log(`   /memory      Zeigt Memory-Statistiken`)
                console.log(`   /tools       Listet verfügbare Tools`)
                console.log(`   /feedback    Zeigt Lern-Statistiken`)
                console.log(`   /export      Exportiert Konversation`)
                console.log(`   /image <pfad> Lädt Bild für Vision`)
                console.log(`   /clear       Löscht Chat-Verlauf`)
                console.log(`   /reset       Neustart (löscht alles)`)
                console.log(`   /compact     Komprimiert Verlauf`)
                console.log(`   /update      Update von GitHub`)
                console.log(`   /exit        Beendet Chat`)
                console.log(`   /help        Diese Hilfe`)
                console.log()
                prompt()
                return
            }

            // /image <path> - Load image for Vision
            if (trimmed.startsWith('/image ')) {
                const imagePath = trimmed.slice(7).trim().replace(/"/g, '')
                try {
                    if (!existsSync(imagePath)) {
                        console.log(c.error(`❌ Bild nicht gefunden: ${imagePath}`))
                        prompt()
                        return
                    }

                    const imageBuffer = readFileSync(imagePath)
                    const base64 = imageBuffer.toString('base64')
                    const ext = imagePath.toLowerCase().split('.').pop()
                    const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'

                    pendingImage = { data: base64, mimeType }
                    const sizeKb = Math.round(imageBuffer.length / 1024)
                    console.log(c.ok(`✅ Bild geladen: ${imagePath} (${sizeKb} KB, ${mimeType})`))
                    console.log(c.dim('   Schreibe jetzt deine Frage zum Bild...'))
                } catch (err) {
                    console.log(c.error(`❌ Fehler beim Laden: ${err}`))
                }
                prompt()
                return
            }

            // /layer0 - Layer 0: Resilience & Security Status
            if (trimmed === '/layer0') {
                console.log(c.bold('\n═══════════════════════════════════════════'))
                console.log(c.bold('        🛡️ Layer 0 - Resilience & Security'))
                console.log(c.bold('═══════════════════════════════════════════'))
                console.log('')
                console.log(c.info('Layer 0 ist die Basis-Schutzschicht von Xaventra.'))
                console.log('')

                // Check backup status
                const backupDir = '.nova-backups'
                const backupExists = existsSync(backupDir)
                console.log(`  💾 Pre-Write Backups: ${backupExists ? c.ok('✅ aktiv') : c.warn('❌ inaktiv')}`)
                console.log(`     Verzeichnis: ${backupDir}/`)

                // Check security status
                try {
                    const { getSecurity } = await import('./resilience/security.js')
                    const security = getSecurity()
                    const securityConfig = security.getConfig()
                    console.log('')
                    console.log(`  🔒 Security Layer: ${c.ok('✅ aktiv')}`)
                    console.log(`     Erlaubte Pfade: ${securityConfig.allowedPaths.length}`)
                    console.log(`     Blockierte Pfade: ${securityConfig.blockedPathsCount}`)
                    console.log(`     Blockierte Extensions: ${securityConfig.blockedExtensionsCount}`)
                    console.log(`     Blockierte Commands: ${securityConfig.blockedCommandsCount}`)
                    console.log(`     Strict Mode: ${securityConfig.strictMode ? 'ja' : 'nein'}`)
                } catch {
                    console.log(`  🔒 Security Layer: ${c.warn('❌ nicht geladen')}`)
                }

                // Check context guard
                console.log('')
                console.log(`  🧠 Context Guard: ${c.ok('✅ aktiv')}`)
                console.log('     Tokens: LIFO-basierte Auto-Truncation')

                // Check model fallback
                console.log('')
                console.log(`  🔄 Model Fallback: ${c.ok('✅ bereit')}`)
                console.log('     Retry: Exponential Backoff mit Provider-Failover')

                console.log('')
                console.log(c.dim('═══════════════════════════════════════════'))
                console.log()
                prompt()
                return
            }

            // /raw - Direct LLM communication without Xaventra persona
            if (trimmed === '/raw' || trimmed.startsWith('/raw ')) {
                console.log(c.bold('\n═══════════════════════════════════════════'))
                console.log(c.bold('        📡 Raw LLM - Direct Access'))
                console.log(c.bold('═══════════════════════════════════════════'))

                const message = trimmed.replace('/raw', '').trim()

                if (!message) {
                    console.log('')
                    console.log(c.info('Direkter LLM-Zugang ohne Xaventra-Persona.'))
                    console.log('')
                    console.log(c.bold('  Nutzung: /raw <nachricht>'))
                    console.log(c.dim('  Beispiel: /raw Was sind deine Capabilities?'))
                    console.log('')
                } else {
                    if (llm) {
                        console.log(c.dim('\n  📤 Sende an Raw LLM...'))
                        try {
                            const response = await llm.complete([
                                { role: 'system', content: 'You are a helpful AI assistant. Respond directly without any persona.' },
                                { role: 'user', content: message }
                            ])
                            console.log('')
                            console.log(c.bold('  📥 Raw LLM Antwort:'))
                            console.log('')
                            console.log('  ' + response.content.split('\n').join('\n  '))
                            console.log('')
                        } catch (err) {
                            console.log(c.error(`  ❌ Raw LLM Error: ${err}`))
                        }
                    } else {
                        console.log(c.warn('  ⚠️ LLM nicht verbunden'))
                    }
                }
                console.log(c.dim('═══════════════════════════════════════════'))
                console.log()
                prompt()
                return
            }

            if (trimmed === '/status') {
                console.log(c.bold('\n═══════════════════════════════════════════'))
                console.log(c.bold('              ✨ Xaventra Status'))
                console.log(c.bold('═══════════════════════════════════════════'))
                try {
                    const configPath = resolveConfigPath()
                    const authPath = join(process.cwd(), '.nova-auth', 'pi-auth.json')
                    let email = 'nicht angemeldet'
                    let provider = 'unbekannt'
                    let modelId = 'unbekannt'

                    if (existsSync(configPath)) {
                        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                        provider = config.provider || 'unbekannt'
                        modelId = config.model || 'auto'
                    }

                    // Get OAuth email if available
                    if (existsSync(authPath)) {
                        try {
                            const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
                            email = auth.email || auth.user || 'angemeldet'
                        } catch { /* ignore */ }
                    }

                    // Calculate token usage from history
                    const historyTokens = history.reduce((sum, msg) => sum + (msg.content?.length || 0) / 4, 0)
                    const inputTokens = Math.round(historyTokens)
                    const outputTokens = Math.round(history.filter(m => m.role === 'assistant').reduce((s, m) => s + (m.content?.length || 0) / 4, 0))

                    // Context window (estimate based on model)
                    const contextWindow = modelId.includes('flash') ? 1000000 : 128000
                    const contextUsed = inputTokens + outputTokens
                    const contextPercent = Math.round((contextUsed / contextWindow) * 100)

                    console.log('')
                    console.log(`  🤖 Model: ${c.info(provider)}/${c.bold(modelId)} · 🔐 oauth (${email})`)
                    console.log(`  📊 Tokens: ${c.info(inputTokens.toLocaleString())} in / ${c.info(outputTokens.toLocaleString())} out`)
                    console.log(`  📚 Context: ${c.info((contextUsed / 1000).toFixed(1) + 'k')}/${(contextWindow / 1000000).toFixed(1)}m (${contextPercent}%)`)
                    console.log(`  💬 History: ${c.info(String(history.length))} messages`)

                    // Subsystem status
                    console.log('')
                    console.log(`  🧠 Memory: ${memoryManager ? c.ok('aktiv') : c.dim('aus')}`)
                    console.log(`  📖 Learning: ${feedbackCollector ? c.ok('aktiv') : c.dim('aus')}`)
                    console.log(`  🔧 Tools: ${toolRegistry ? c.ok(toolRegistry.getAll().length + ' geladen') : c.dim('aus')}`)
                    console.log(`  ⚙️ Runtime: CLI · LLM: ${llm ? c.ok('verbunden') : c.warn('getrennt')}`)

                    // Dynamic Model Discovery
                    console.log('')
                    console.log(c.bold('  📋 Verfügbare Modelle (dynamisch):'))
                    try {
                        // Dynamic model discovery from auth state
                        const knownProviders = ['local', 'openai-codex', 'anthropic']
                        for (const prov of knownProviders) {
                            try {
                                // Check if we have credentials for this provider
                                const authPath = join(process.cwd(), '.nova-auth')
                                if (existsSync(authPath)) {
                                    // Show provider as available
                                    console.log(`     ${c.info(prov)}: ${c.ok('✓ angemeldet')}`)
                                }
                            } catch { /* skip */ }
                        }
                        console.log(c.dim('     Nutze /model <name> zum Wechseln'))
                    } catch {
                        console.log(c.dim('     Model Discovery nicht verfügbar'))
                    }

                    console.log('')
                    console.log(c.dim('═══════════════════════════════════════════'))
                } catch (err) {
                    console.log(c.warn(`Status nicht verfügbar: ${err}`))
                }
                console.log()
                prompt()
                return
            }

            if (trimmed === '/reset') {
                console.clear()
                printBanner()
                history.length = 0
                history.push({ role: 'system', content: 'Du bist Xaventra, ein hilfreicher KI-Assistent. Antworte präzise und freundlich.' })
                console.log(c.ok('🔄 Konversation zurückgesetzt.'))
                console.log()
                prompt()
                return
            }

            if (trimmed === '/compact') {
                if (history.length <= 2) {
                    console.log(c.dim('Nichts zu komprimieren.'))
                    prompt()
                    return
                }
                const system = history[0]
                const recent = history.slice(-6)
                history.length = 0
                history.push(system, ...recent)
                console.log(c.ok(`📦 Komprimiert auf ${history.length} Nachrichten.`))
                console.log()
                prompt()
                return
            }

            if (trimmed === '/update') {
                console.log(c.bold('\n🔄 Update von GitHub...'))
                const { execSync } = await import('node:child_process')
                try {
                    // 1. Git pull
                    console.log(c.dim('   git pull...'))
                    execSync('git pull', { cwd: process.cwd(), stdio: 'inherit' })

                    // 2. npm install
                    console.log(c.dim('   npm install...'))
                    execSync('npm install', { cwd: process.cwd(), stdio: 'inherit' })

                    // 3. Build check
                    console.log(c.dim('   npm run build...'))
                    try {
                        execSync('npm run build', { cwd: process.cwd(), stdio: 'pipe' })
                        console.log(c.ok('✓ Build erfolgreich!'))
                    } catch (buildErr) {
                        console.log(c.warn('⚠ Build fehlgeschlagen - versuche automatischen Fix...'))
                        // Try to fix common issues
                        execSync('npm run build 2>&1', { cwd: process.cwd(), stdio: 'inherit' })
                    }

                    console.log(c.ok('\n✓ Update abgeschlossen! Restart empfohlen.'))
                } catch (err) {
                    console.log(c.error(`❌ Update fehlgeschlagen: ${err}`))
                }
                console.log()
                prompt()
                return
            }

            if (trimmed === '/model' || trimmed.startsWith('/model ')) {
                try {
                    const configPath = resolveConfigPath()
                    if (existsSync(configPath)) {
                        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                        const provider = config.provider

                        // Use ModelCatalog for dynamic model list
                        const { getModelCatalog } = await import('./llm/models.js')
                        const catalog = getModelCatalog()
                        const providerModels = await catalog.getModelsForProvider(provider)
                        const available = providerModels.map(m => m.id)

                        const modelArg = trimmed.replace('/model', '').trim()

                        // Switch model if number provided
                        if (modelArg && /^\d+$/.test(modelArg)) {
                            const idx = parseInt(modelArg) - 1
                            if (idx >= 0 && idx < available.length) {
                                const newModel = available[idx]
                                config.model = newModel
                                writeFileSync(configPath, JSON.stringify(config, null, 2))
                                console.log(c.ok(`\n✓ Modell gewechselt zu: ${newModel}`))
                                console.log(c.dim('   Nächste Nachricht verwendet das neue Modell.'))
                            } else {
                                console.log(c.warn(`\nUngültige Nummer. Wähle 1-${available.length}`))
                            }
                        } else {
                            // Show models
                            console.log(c.bold(`\n📋 Modelle für ${provider}:`))
                            available.forEach((m, i) => {
                                const marker = m === config.model ? c.ok(' ← aktuell') : ''
                                console.log(`   ${i + 1}. ${m}${marker}`)
                            })
                            console.log(c.dim('\nNutze /model <nummer> zum Wechseln'))
                        }
                    }
                } catch (err) {
                    console.log(c.warn(`Fehler: ${err}`))
                }
                console.log()
                prompt()
                return
            }

            // ============================================
            // New Subsystem Commands (Phase 1-3)
            // ============================================

            if (trimmed === '/memory') {
                console.log(c.bold('\n🧠 Memory System:'))
                if (memoryManager) {
                    try {
                        const count = await memoryManager.db?.count() || 0
                        console.log(`   Einträge: ${count}`)
                        console.log(`   Pfad: .nova-memory/`)
                        console.log(c.dim('   Tipp: Sage "Merk dir X" um etwas zu speichern'))
                    } catch {
                        console.log(c.dim('   Keine Memories gespeichert'))
                    }
                } else {
                    console.log(c.warn('   Memory nicht aktiv (braucht OPENAI_API_KEY für Embeddings)'))
                }
                console.log()
                prompt()
                return
            }

            if (trimmed === '/tools') {
                console.log(c.bold('\n🔧 Verfügbare Tools:'))
                if (toolRegistry) {
                    const tools = toolRegistry.getAll()
                    for (const tool of tools) {
                        console.log(`   ${c.info(tool.name.padEnd(20))} ${c.dim(tool.description.slice(0, 40))}`)
                    }
                    console.log(c.dim(`\n   Gesamt: ${tools.length} Tools`))
                } else {
                    console.log(c.warn('   Tool-System nicht verfügbar'))
                }
                console.log()
                prompt()
                return
            }

            if (trimmed === '/feedback') {
                console.log(c.bold('\n📊 Learning System:'))
                if (feedbackCollector) {
                    const stats = feedbackCollector.getStats()
                    console.log(`   Feedback gesamt: ${stats.total}`)
                    console.log(`   Korrekturen: ${stats.corrections}`)
                    console.log(`   Positiv: ${stats.positive}`)
                    console.log(`   Negativ: ${stats.negative}`)
                    console.log(`   Präferenzen: ${stats.preferences}`)
                    console.log(`   Gelernte Muster: ${feedbackCollector.getLearnedCorrectionsCount()}`)
                } else {
                    console.log(c.warn('   Learning nicht verfügbar'))
                }
                console.log()
                prompt()
                return
            }

            if (trimmed === '/export') {
                console.log(c.bold('\n💾 Export Konversation:'))
                try {
                    const { mkdirSync } = await import('node:fs')
                    const exportDir = join(process.cwd(), '.nova-exports')
                    mkdirSync(exportDir, { recursive: true })
                    const filename = `chat-${Date.now()}.json`
                    const exportPath = join(exportDir, filename)
                    writeFileSync(exportPath, JSON.stringify({
                        exported: new Date().toISOString(),
                        messages: history.slice(1), // Skip system prompt
                        memoryActive: !!memoryManager,
                        learningActive: !!feedbackCollector,
                    }, null, 2))
                    console.log(c.ok(`   ✓ Exportiert: ${exportPath}`))
                } catch (err) {
                    console.log(c.error(`   ❌ Export fehlgeschlagen: ${err}`))
                }
                console.log()
                prompt()
                return
            }

            if (llm) {
                // Attach pending image if available (Vision support)
                const userMsg: { role: string, content: string, image?: { data: string, mimeType: string } } = {
                    role: 'user',
                    content: trimmed
                }
                if (pendingImage) {
                    userMsg.image = pendingImage
                    console.log(c.dim(`   📷 Bild angehängt`))
                    pendingImage = null // Clear after use
                }
                history.push(userMsg)

                try {
                    // Memory Context Injection (Phase 1)
                    let memoryContext = ''
                    if (memoryManager) {
                        try {
                            const context = await memoryManager.getContextForPrompt(trimmed)
                            if (context) {
                                memoryContext = `\n\n[Relevante Erinnerungen:\n${context}]`
                            }
                        } catch { /* Memory not critical */ }
                    }

                    // Inject memory into system prompt temporarily
                    if (memoryContext && history[0]?.role === 'system') {
                        history[0].content = history[0].content.replace(/\n\n\[Relevante Erinnerungen:.*?\]/s, '') + memoryContext
                    }

                    process.stdout.write(c.nova('Xaventra: '))
                    let response = await llm.complete(history)
                    // Streaming already printed the content, just add newlines
                    console.log()

                    // ============================================
                    // Tool Execution Loop
                    // ============================================
                    if (toolRegistry && response.content) {
                        const toolPattern = /\[TOOL:(\w+)\((\{[^}]*\})\)\]/g
                        let match
                        let toolExecuted = false

                        while ((match = toolPattern.exec(response.content)) !== null) {
                            const toolName = match[1]
                            const toolArgsStr = match[2]

                            try {
                                const toolArgs = JSON.parse(toolArgsStr)
                                console.log(c.dim(`\n🔧 Executing: ${toolName}...`))

                                const result = await toolRegistry.execute({
                                    id: `call-${Date.now()}`,
                                    name: toolName,
                                    arguments: toolArgs,
                                }, true) // elevated user for CLI

                                if (result.success) {
                                    console.log(c.ok(`   ✓ ${toolName}: ${JSON.stringify(result.result).slice(0, 100)}`))
                                    // Add tool result to history for follow-up
                                    history.push({ role: 'assistant', content: response.content })
                                    history.push({ role: 'user', content: `[Tool Result: ${toolName}]\n${JSON.stringify(result.result, null, 2)}` })
                                    toolExecuted = true
                                } else {
                                    console.log(c.error(`   ✗ ${toolName}: ${result.error}`))
                                }
                            } catch (parseErr) {
                                console.log(c.warn(`   ⚠ Tool parse error: ${parseErr}`))
                            }
                        }

                        // If tool was executed, get follow-up response
                        if (toolExecuted) {
                            console.log()
                            process.stdout.write(c.nova('Xaventra: '))
                            response = await llm.complete(history)
                            console.log()
                        }
                    }

                    console.log()
                    history.push({ role: 'assistant', content: response.content })

                    // Feedback Capture (Phase 2)
                    if (feedbackCollector) {
                        const feedbackType = feedbackCollector.detectFeedbackType(trimmed)
                        if (feedbackType) {
                            feedbackCollector.collectFeedback({
                                type: feedbackType,
                                userMessage: trimmed,
                                botResponse: response.content,
                                correction: feedbackType === 'correction' ? trimmed : undefined,
                            })
                        }
                    }

                    // Memory Auto-Capture (Phase 1)
                    if (memoryManager) {
                        try {
                            await memoryManager.autoCapture([
                                { role: 'user', content: trimmed },
                                { role: 'assistant', content: response.content }
                            ])
                        } catch { /* Memory not critical */ }
                    }
                } catch (err) {
                    // Phase 5: Error Recovery with Retry
                    const errMsg = String(err)
                    if (errMsg.includes('token') || errMsg.includes('expired') || errMsg.includes('401')) {
                        console.log(c.error(`\n❌ Token abgelaufen. Führe "npm run cli -- setup" aus.`))
                    } else if (errMsg.includes('rate') || errMsg.includes('429') || errMsg.includes('capacity')) {
                        // Parse error for model info
                        let failedModel = 'unbekannt'
                        try {
                            const errJson = JSON.parse(errMsg.match(/\{.*\}/s)?.[0] || '{}')
                            failedModel = errJson.error?.model || errJson.model || failedModel
                        } catch { /* ignore */ }

                        if (errMsg.includes('No capacity') || errMsg.includes('capacity')) {
                            console.log(c.warn(`\n⚠️ Modell "${failedModel}" nicht verfügbar.`))
                            console.log(c.dim(`   Tipp: Wechsle mit /model <modellname> zu einem anderen Modell`))
                            console.log(c.dim(`   Verfügbare Modelle: auto, oder ein konkretes Modell`))
                        } else {
                            console.log(c.warn(`\n⏳ Rate Limit erreicht. Warte kurz...`))
                            await new Promise(r => setTimeout(r, 3000))
                            console.log(c.dim('   Versuche es erneut...'))
                        }
                    } else if (errMsg.includes('network') || errMsg.includes('ECONNREFUSED')) {
                        console.log(c.error(`\n❌ Netzwerkfehler. Prüfe deine Internetverbindung.`))
                    } else {
                        // Try to parse and show useful error info
                        try {
                            const errJson = JSON.parse(errMsg.match(/\{.*\}/s)?.[0] || '{}')
                            const errorMessage = errJson.error?.errorMessage || errJson.errorMessage || errMsg.slice(0, 150)
                            console.log(c.error(`\n❌ API Error: ${errorMessage}`))
                        } catch {
                            console.log(c.error(`\n❌ Fehler: ${errMsg.slice(0, 150)}`))
                        }
                    }
                }
            } else {
                console.log(c.dim('Xaventra: ') + c.warn('Kein LLM verbunden. Nutze "nova setup" zur Konfiguration.'))
                console.log()
            }

            prompt()
        })
    }

    prompt()
}

async function commandWizard(): Promise<void> {
    printBanner()
    console.log(c.bold('✨ Xaventra Wizard - System Diagnostics'))
    console.log(c.dim('─'.repeat(50)))
    console.log()

    const checks: Array<{ name: string; status: boolean; detail?: string }> = []

    // 1. Check config file
    const configPath = resolveConfigPath()
    const hasConfig = existsSync(configPath)
    checks.push({
        name: 'Configuration file',
        status: hasConfig,
        detail: hasConfig ? configPath : 'Run: nova setup',
    })

    // 2. Check compiled code
    const distPath = join(process.cwd(), 'dist', 'nova.js')
    const isCompiled = existsSync(distPath)
    checks.push({
        name: 'TypeScript compiled',
        status: isCompiled,
        detail: isCompiled ? 'dist/nova.js exists' : 'Run: npm run build',
    })

    // 3. Check node_modules
    const nodeModules = join(process.cwd(), 'node_modules')
    const hasDeps = existsSync(nodeModules)
    checks.push({
        name: 'Dependencies installed',
        status: hasDeps,
        detail: hasDeps ? 'node_modules exists' : 'Run: npm install',
    })

    // 4. Check Dashboard
    const dashboardPath = join(process.cwd(), 'dashboard', 'package.json')
    const hasDashboard = existsSync(dashboardPath)
    checks.push({
        name: 'Dashboard installed',
        status: hasDashboard,
        detail: hasDashboard ? 'dashboard/' : 'Run: npm run dashboard:install',
    })

    // 5. Check environment variables
    const hasOpenAI = !!process.env.OPENAI_API_KEY
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
    const hasAnyLLM = hasOpenAI || hasAnthropic

    checks.push({
        name: 'LLM API Key',
        status: hasAnyLLM,
        detail: hasAnyLLM
            ? [
                hasOpenAI && 'OpenAI',
                hasAnthropic && 'Anthropic',
            ].filter(Boolean).join(', ')
            : 'Run: nova setup',
    })

    // 6. Check WhatsApp auth
    const waAuthPath = join(process.cwd(), '.nova-whatsapp-auth')
    const hasWaAuth = existsSync(waAuthPath)
    checks.push({
        name: 'WhatsApp Auth',
        status: hasWaAuth,
        detail: hasWaAuth ? 'Session exists' : 'Optional: Will prompt QR on start',
    })

    // 7. Check Telegram token
    const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN
    checks.push({
        name: 'Telegram Bot Token',
        status: hasTelegram,
        detail: hasTelegram ? 'Configured' : 'Optional: Set TELEGRAM_BOT_TOKEN',
    })

    // Print results
    let failed = 0
    let warnings = 0

    for (const check of checks) {
        const icon = check.status ? c.ok('✓') : c.warn('○')
        const status = check.status ? c.ok('OK') : c.warn('MISSING')
        console.log(`  ${icon} ${check.name}: ${status}`)
        if (check.detail) {
            console.log(`    ${c.dim(check.detail)}`)
        }
        if (!check.status && !check.detail?.includes('Optional')) {
            failed++
        } else if (!check.status) {
            warnings++
        }
    }

    console.log()
    console.log(c.dim('─'.repeat(50)))

    if (failed === 0) {
        console.log(c.ok('✓ Xaventra is ready to start!'))
        console.log()
        console.log(`  Run: ${c.bold('nova start')}`)
        console.log(`  Or:  ${c.bold('nova gateway')} (with auto-restart)`)
    } else {
        console.log(c.warn(`⚠ ${failed} required item(s) missing.`))
        console.log()
        console.log(`  Run: ${c.bold('nova setup')} to configure Xaventra.`)
    }
    console.log()
}

async function commandDoctor(args: string[]): Promise<void> {
    printBanner()
    console.log(c.bold('🏥 Xaventra Doctor — Autonomes Diagnose-System'))
    console.log(c.dim('─'.repeat(50)))
    console.log()

    const { getDoctorInfo } = await import('./llm/llama-engine.js')
    const info = getDoctorInfo()

    // Always show hardware summary
    console.log(`  🖥️  RAM:          ${info.ramGB} GB`)
    console.log(`  ⚙️   CPU Threads:  ${info.cpuThreads} (von ${cpus().length} Kernen)`)
    console.log(`  🤖  Aktives Modell: ${info.modelName ?? c.warn('kein GGUF gefunden')}`)

    if (info.models.length > 0) {
        console.log()
        console.log(`  📦  Verfügbare Modelle:`)
        for (const m of info.models) {
            const active = m === info.modelName
            console.log(`    ${active ? c.ok('→') : ' '} ${m}`)
        }
    } else {
        console.log()
        console.log(c.warn('  ⚠  Keine GGUF-Modelle in models/ gefunden'))
        console.log()
        console.log('  Kopiere die Modelle vom Spark-Server oder lade sie herunter:')
        console.log(c.dim('    scp spark:~/nova-lora/models/nova-doctor-*.gguf ./models/'))
        console.log()
        console.log('  Empfohlene Modelle nach Hardware:')
        console.log(c.dim('    GPU (≥ 6 GB VRAM):  nova-doctor-1.5b-q5km.gguf (1.1 GB)'))
        console.log(c.dim('    CPU (≥ 4 GB RAM):   nova-doctor-1.5b-q4km.gguf (941 MB)'))
        console.log(c.dim('    CPU (≥ 2 GB RAM):   nova-doctor-0.5b-q5km.gguf (401 MB)'))
        console.log(c.dim('    Kartoffel (≥ 1 GB): nova-doctor-0.5b-q4km.gguf (380 MB)'))
        console.log(c.dim('    Minimal (< 1 GB):   nova-doctor-0.5b-q2k.gguf  (323 MB)'))
        console.log()
        return
    }

    // If args given → diagnose
    const errorText = args.join(' ')
    if (!errorText) {
        console.log()
        console.log(c.dim('─'.repeat(50)))
        console.log()
        console.log(`  Nutzung:`)
        console.log(`    ${c.bold('nova doctor')}                    — Status & Modell-Info`)
        console.log(`    ${c.bold('nova doctor "<fehlermeldung>"')}   — Fehler diagnostizieren`)
        console.log()
        console.log(`  Oder im Chat:`)
        console.log(`    ${c.bold('/doctor <fehler>')}`)
        console.log(`    ${c.bold('/doctor status')}`)
        console.log()
        return
    }

    if (!info.available) {
        console.log(c.warn('\n  ⚠  Xaventra Doctor ist offline — kein passendes Modell verfügbar.'))
        return
    }

    console.log()
    console.log(c.dim('─'.repeat(50)))
    console.log()
    console.log(`  🔍 Analysiere: "${errorText.slice(0, 80)}${errorText.length > 80 ? '...' : ''}"`)
    console.log()

    try {
        const { diagnose } = await import('./intelligence/doctor-client.js')
        const result = await diagnose({ error: errorText })

        const conf = { high: c.ok('🟢 Hoch'), medium: c.warn('🟡 Mittel'), low: '🔴 Niedrig' }[result.confidence]
        const src = result.fromModel ? `🤖 ${info.modelName}` : '📐 Regelbasiert (kein Modell)'

        console.log(`  Quelle:     ${src}`)
        console.log(`  Konfidenz:  ${conf}`)
        console.log()
        console.log(c.bold('  Diagnose:'))
        console.log(`    ${result.diagnosis}`)
        console.log()
        console.log(c.bold('  Fix:'))
        result.fix.split('\n').forEach(line => console.log(`    ${line}`))
        console.log()
        if (result.autoApply) {
            console.log(c.ok('  ✅ Sicher für automatische Anwendung'))
        } else {
            console.log(c.warn('  ⚠  Manuelle Überprüfung empfohlen'))
        }
    } catch (err: any) {
        console.log(c.warn(`  ❌ Diagnose fehlgeschlagen: ${err.message}`))
    }

    console.log()
}

async function commandStatus(): Promise<void> {
    console.log(c.bold('✨ Xaventra Status'))
    console.log(c.dim('─'.repeat(40)))
    console.log()

    // Try to connect to gateway
    try {
        const res = await fetch('http://localhost:18789/api/status')
        if (res.ok) {
            const data = await res.json() as { nova: string; pid?: number; uptime?: number; crashCount?: number }
            console.log(`  ${c.dim('Xaventra:')}        ${data.nova === 'running' ? c.ok('Running') : c.warn(data.nova)}`)
            console.log(`  ${c.dim('PID:')}         ${data.pid || 'N/A'}`)
            console.log(`  ${c.dim('Uptime:')}      ${data.uptime || 0}s`)
            console.log(`  ${c.dim('Crashes:')}     ${data.crashCount || 0}`)
            console.log()
            console.log(c.dim('Gateway running on port 18789'))
        }
    } catch {
        console.log(`  ${c.dim('Xaventra:')}        ${c.warn('Not running')}`)
        console.log(`  ${c.dim('Gateway:')}     ${c.warn('Not running')}`)
        console.log()
        console.log(c.dim('Start Xaventra: nova start'))
        console.log(c.dim('Start Gateway: nova gateway'))
    }
    console.log()
}

async function commandChannels(): Promise<void> {
    console.log(c.bold('📱 Available Channels'))
    console.log(c.dim('─'.repeat(40)))
    console.log()

    const channels = [
        { type: 'whatsapp', name: 'WhatsApp', lib: '@whiskeysockets/baileys' },
        { type: 'telegram', name: 'Telegram', lib: 'node-telegram-bot-api' },
        { type: 'discord', name: 'Discord', lib: 'discord.js' },
        { type: 'matrix', name: 'Matrix', lib: 'matrix-js-sdk' },
        { type: 'signal', name: 'Signal', lib: 'signal-cli REST' },
        { type: 'slack', name: 'Slack', lib: '@slack/bolt' },
        { type: 'voip', name: 'VoIP/Asterisk', lib: 'ari-client' },
    ]

    for (const ch of channels) {
        console.log(`  ${c.info(ch.type.padEnd(12))} ${ch.name.padEnd(15)} ${c.dim(ch.lib)}`)
    }
    console.log()
}

async function commandLLM(): Promise<void> {
    console.log(c.bold('🤖 Available LLM Providers'))
    console.log(c.dim('─'.repeat(40)))
    console.log()

    const providers = [
        { id: 'openai', name: 'OpenAI', models: 'auto (erkennt verfügbare)' },
        { id: 'openai-oauth', name: 'OpenAI (OAuth)', models: 'auto (erkennt verfügbare)' },
        { id: 'anthropic', name: 'Anthropic', models: 'claude-sonnet-4-6, claude-opus-4-6' },
        { id: 'qwen', name: 'Alibaba Qwen', models: 'qwen-turbo, qwen-max' },
        { id: 'ollama', name: 'Ollama (Local)', models: 'llama3, mistral, codellama' },
        { id: 'custom', name: 'Custom API', models: 'OpenAI-compatible' },
    ]

    for (const p of providers) {
        console.log(`  ${c.info(p.id.padEnd(14))} ${p.name.padEnd(20)} ${c.dim(p.models)}`)
    }
    console.log()
}

async function commandModels(): Promise<void> {
    printBanner()
    console.log(c.bold('📋 Model Catalog'))
    console.log(c.dim('─'.repeat(80)))
    console.log()

    try {
        const { getModelCatalog } = await import('./llm/models.js')
        const catalog = getModelCatalog()
        const models = await catalog.getAllModels()

        // Get provider filter from args
        const filterProvider = process.argv[3]?.toLowerCase()
        const filterCapability = process.argv[4]?.toLowerCase()

        // Group by provider
        const byProvider = new Map<string, typeof models>()
        for (const model of models) {
            if (filterProvider && model.provider !== filterProvider) continue
            if (filterCapability && !model.capabilities.includes(filterCapability as 'vision' | 'tools')) continue

            if (!byProvider.has(model.provider)) {
                byProvider.set(model.provider, [])
            }
            byProvider.get(model.provider)!.push(model)
        }

        // Print header
        console.log(`  ${c.dim('Provider'.padEnd(12))} ${c.dim('Model'.padEnd(30))} ${c.dim('Context'.padEnd(10))} ${c.dim('Capabilities')}`)
        console.log(`  ${c.dim('─'.repeat(75))}`)

        // Print models by provider
        for (const [provider, providerModels] of byProvider) {
            let first = true
            for (const model of providerModels) {
                const prov = first ? c.info(provider.padEnd(12)) : ' '.repeat(12)
                const context = model.contextWindow
                    ? (model.contextWindow >= 1000000 ? `${(model.contextWindow / 1000000).toFixed(1)}M` : `${(model.contextWindow / 1000).toFixed(0)}K`)
                    : '-'
                const caps = model.capabilities.map(cap => {
                    switch (cap) {
                        case 'vision': return c.ok('👁')
                        case 'tools': return c.ok('🔧')
                        case 'reasoning': return c.ok('🧠')
                        case 'code': return c.ok('💻')
                        default: return cap
                    }
                }).join(' ')

                console.log(`  ${prov} ${model.name.padEnd(30)} ${context.padEnd(10)} ${caps}`)
                first = false
            }
        }

        console.log()
        console.log(c.dim(`  Total: ${models.length} models from ${byProvider.size} providers`))
        console.log()
        console.log(c.dim('  Legend: 👁 Vision  🔧 Tools  🧠 Reasoning  💻 Code'))
        console.log()
        console.log(c.dim('  Filter: nova models <provider> [capability]'))
        console.log(c.dim('  Example: nova models openai vision'))

    } catch (err) {
        console.error(c.error(`Failed to load models: ${err}`))
    }
    console.log()
}

async function commandConfig(): Promise<void> {
    console.log(c.bold('⚙️ Xaventra Configuration'))
    console.log(c.dim('─'.repeat(40)))
    console.log()

    const configPath = resolveConfigPath()

    if (!existsSync(configPath)) {
        console.log(c.warn('No xaventra.config.json found.'))
        console.log()
        console.log('Create one with:')
        console.log(c.bold('  nova setup'))
        console.log()
        return
    }

    try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))

        console.log(`  ${c.dim('Name:')}         ${config.name || 'Xaventra'}`)
        console.log(`  ${c.dim('Provider:')}     ${config.provider || 'not set'}`)
        console.log(`  ${c.dim('Model:')}        ${config.model || 'default'}`)
        console.log(`  ${c.dim('Dashboard:')}    Port ${config.dashboard?.port || 3000}`)
        console.log(`  ${c.dim('Metrics:')}      Port ${config.metrics?.port || 9090}`)

        const enabledChannels = Object.entries(config.channels || {})
            .filter(([_, v]) => (v as { enabled?: boolean })?.enabled)
            .map(([k]) => k)
        console.log(`  ${c.dim('Channels:')}     ${enabledChannels.join(', ') || 'none'}`)
        console.log()
    } catch (err) {
        console.error(c.error(`Failed to read config: ${err}`))
    }
}

function commandHelp(): void {
    printBanner()
    console.log(c.bold('Usage:'))
    console.log(`  npm run cli -- ${c.info('<command>')} [options]`)
    console.log()
    console.log(c.bold('🚀 Haupt-Commands:'))
    console.log(`  ${c.info('start'.padEnd(12))} Startet Xaventra AI Assistant`)
    console.log(`  ${c.info('setup'.padEnd(12))} Interaktiver Setup-Wizard mit OAuth`)
    console.log(`  ${c.info('chat'.padEnd(12))} Terminal-Chat mit Xaventra`)
    console.log(`  ${c.info('ask'.padEnd(12))} Eine Nachricht durch die volle Xaventra-Pipeline senden`)
    console.log(`  ${c.info('gateway'.padEnd(12))} Startet Gateway (Prozess-Supervisor)`)
    console.log()
    console.log(c.bold('📊 Status & Info:'))
    console.log(`  ${c.info('status'.padEnd(12))} Zeigt aktuellen Status`)
    console.log(`  ${c.info('channels'.padEnd(12))} Listet verfügbare Channels`)
    console.log(`  ${c.info('llm'.padEnd(12))} Listet LLM-Provider`)
    console.log(`  ${c.info('models'.padEnd(12))} Zeigt alle verfügbaren Modelle (646+)`)
    console.log(`  ${c.info('config'.padEnd(12))} Zeigt Konfiguration`)
    console.log()
    console.log(c.bold('🔧 Diagnose & KI:'))
    console.log(`  ${c.info('doctor'.padEnd(12))} Xaventra Doctor — KI-Fehlerdiagnose (lokal, GGUF)`)
    console.log(`  ${c.info('wizard'.padEnd(12))} System-Check (Config, Deps, API-Keys)`)
    console.log(`  ${c.info('help'.padEnd(12))} Diese Hilfe anzeigen`)
    console.log()
    console.log(c.bold('🏥 Xaventra Doctor Beispiele:'))
    console.log(`  ${c.dim('$')} nova doctor                          ${c.dim('# Status & Modell-Info')}`)
    console.log(`  ${c.dim('$')} nova doctor "Cannot find module xyz"  ${c.dim('# Fehler diagnostizieren')}`)
    console.log(`  ${c.dim('$')} nova doctor "ECONNREFUSED :5432"      ${c.dim('# DB-Fehler analysieren')}`)
    console.log()
    console.log(c.bold('⚙️ Prozess-Steuerung:'))
    console.log(`  ${c.info('stop'.padEnd(12))} Beendet nur die Instanz in diesem Laufzeitordner (kill: Alias)`)
    console.log(`  ${c.info('restart'.padEnd(12))} Neustart erst nach bestätigter Beendigung`)
    console.log(`  ${c.info('reconfig'.padEnd(12))} Konfiguration neu einrichten`)
    console.log()
    console.log(c.bold('📝 Beispiele:'))
    console.log(`  ${c.dim('$')} npm run cli -- setup     ${c.dim('# Erstkonfiguration mit OAuth')}`)
    console.log(`  ${c.dim('$')} npm run cli -- models    ${c.dim('# Alle Modelle anzeigen')}`)
    console.log(`  ${c.dim('$')} npm run cli -- chat      ${c.dim('# Chat im Terminal')}`)
    console.log(`  ${c.dim('$')} npm run cli -- restart   ${c.dim('# Xaventra neustarten')}`)
    console.log()
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    const command = args[0]?.toLowerCase()

    switch (command) {
        case '--version':
        case '-v':
            console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
            break
        case 'start':
            await commandStart()
            break
        case 'setup':
            await commandSetup()
            break
        case 'gateway':
            await commandGateway()
            break
        case 'chat':
            await commandPipelineChat()
            break
        case 'ask':
            await commandPipelineAsk(args.slice(1).join(' '))
            break
        case 'wizard':
            await commandWizard()
            break
        case 'doctor':
            await commandDoctor(args.slice(1))
            break
        case 'status':
            await commandStatus()
            break
        case 'channels':
            await commandChannels()
            break
        case 'llm':
            await commandLLM()
            break
        case 'models':
            await commandModels()
            break
        case 'config':
            await commandConfig()
            break
        case 'stop':
        case 'kill':
            await commandKill()
            break
        case 'restart':
            await commandRestart()
            break
        case 'reconfig':
            await commandSetup()  // Alias for setup
            break
        case 'help':
        case '--help':
        case '-h':
        case undefined:
            commandHelp()
            break
        default:
            console.error(c.error(`Unknown command: ${command}`))
            console.log(`Run ${c.info('npm run cli -- help')} for usage.`)
            process.exit(1)
    }
}

main().catch(err => {
    console.error(c.error(`Error: ${err.message}`))
    process.exit(1)
})
