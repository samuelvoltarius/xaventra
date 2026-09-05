/**
 * Nova - Telegram Channel Adapter
 * 
 * Uses node-telegram-bot-api for Telegram connection
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'
import { isInternalOutboundArtifact, sanitizeInternalOutboundArtifacts } from '../core/outbound-content-guard.js'
import { createDraftStream, type DraftStream } from './telegram-stream.js'
import { mayRetryTelegramPolling, telegramConflictRetryDelay } from './telegram-polling-guard.js'
import { formatTelegramMessage } from './telegram-presentation.js'

// ============================================
// Types
// ============================================

export interface TelegramConfig {
    token: string
    allowFrom?: string[]
    groupPolicy?: 'allow' | 'mention-only' | 'deny'
    username?: string
}

// ============================================
// Telegram Adapter Class
// ============================================

export class TelegramAdapter implements ChannelAdapter {
    type = 'telegram'
    private bot: any = null
    private config: TelegramConfig
    private messageHandler?: (msg: IncomingMessage) => void
    private botUsername?: string
    private lastActiveChat?: string  // Track last chat for proactive messages
    private typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
    private conflictRetryTimer?: ReturnType<typeof setTimeout>
    private disconnecting = false
    // Per-chat message queue to prevent concurrent LLM API calls (prevents 403 rate-limiting)
    private messageQueue = new Map<string, Promise<void>>()

    constructor(config: TelegramConfig) {
        this.config = {
            allowFrom: [],
            groupPolicy: 'mention-only',
            ...config,
        }
    }

    // Serialize message processing per chat to avoid concurrent API calls
    private enqueueMessage(chatId: string, handler: () => Promise<void>): void {
        const prev = this.messageQueue.get(chatId) ?? Promise.resolve()
        const next = prev.then(handler, handler) // Run even if previous failed
        this.messageQueue.set(chatId, next.then(() => {
            // Cleanup if this was the last in queue
            if (this.messageQueue.get(chatId) === next) {
                this.messageQueue.delete(chatId)
            }
        }))
    }

    // ============================================
    // Connection
    // ============================================

    async connect(): Promise<void> {
        console.log('[Nova Telegram] Connecting...')
        this.disconnecting = false

        // Dynamic import
        const TelegramBot = (await import('node-telegram-bot-api')).default

        // Step 1: Start WITHOUT polling to clear webhook first
        this.bot = new TelegramBot(this.config.token, { polling: false })

        // Step 2: Delete any existing webhook — KEEP pending updates (drop_pending_updates: false)
        // This is critical: an active webhook silently blocks all polling-based updates,
        // including messages sent while Nova was offline.
        try {
            await this.bot.deleteWebHook({ drop_pending_updates: false })
            console.log('[Nova Telegram] ✓ Webhook gelöscht — Offline-Nachrichten werden verarbeitet')
        } catch (err) {
            console.warn('[Nova Telegram] Webhook-Delete fehlgeschlagen (ignoriert):', err)
        }

        // Get bot info
        const me = await this.bot.getMe()
        this.botUsername = me.username
        console.log(`[Nova Telegram] Connected as @${this.botUsername}`)

        // Register ALL slash commands with Telegram — shows suggestions when user types /
        try {
            // Force-clear old commands first (Telegram caches aggressively)
            await this.bot.deleteMyCommands()
            await this.bot.setMyCommands([
                // Core
                { command: 'help', description: '✨ Alle Befehle anzeigen' },
                { command: 'status', description: '📊 System-Status & Uptime' },
                { command: 'info', description: 'ℹ️ System-Info & Version' },
                // AI & Mesh
                { command: 'ai', description: '🤖 AI Services scannen/anzeigen' },
                { command: 'nodes', description: '🌐 Mesh-Nodes anzeigen/verwalten' },
                { command: 'update', description: '📦 Update auf alle Edge-Nodes' },
                { command: 'preflight', description: '✈️ Pre-Flight Check' },
                // LLM
                { command: 'models', description: '🤖 Verfügbare LLM-Modelle' },
                { command: 'model', description: '🔄 Modell wechseln' },
                { command: 'think', description: '🧠 Reasoning ein/aus' },
                // Memory & Learning
                { command: 'memory', description: '💾 Memory-Status' },
                { command: 'skills', description: '📚 Gelernte Skills' },
                { command: 'learn', description: '📖 Neues Wissen beibringen' },
                // Multi-Agent
                { command: 'bot', description: '🤖 Bot-Team & Instanzen' },
                { command: 'subagent', description: '🎯 Sub-Agent starten' },
                { command: 'agents', description: '🤖 Agent-Status anzeigen' },
                { command: 'swarm', description: '🐝 Swarm-Status' },
                // Users
                { command: 'users', description: '👥 User-Verwaltung' },
                // Intelligence
                { command: 'wave', description: '🌊 Wave-Pipeline (Strukturierte Missionen)' },
                { command: 'roi', description: '📊 ROI Dashboard (Cost/Value)' },
                { command: 'graph', description: '🕸️ Knowledge Graph' },
                { command: 'scan', description: '📁 File-Index scannen' },
                // Autonomy
                { command: 'autonom', description: '🚀 Autonomie-Modus' },
                { command: 'mission', description: '🎯 Mission starten/verwalten' },
                { command: 'remind', description: '⏰ Erinnerung setzen' },
                // Session
                { command: 'clear', description: '🧹 Konversation zurücksetzen' },
                { command: 'save', description: '💾 Sitzung speichern' },
                { command: 'compact', description: '📦 Kontext komprimieren' },
                // Tools
                { command: 'task', description: '📋 Aktive Aufgaben' },
                { command: 'log', description: '📜 Session-Log anzeigen' },
                { command: 'monitor', description: '📈 System-Monitor' },
                { command: 'hosts', description: '🖥️ SSH-Hosts verwalten' },
                { command: 'bots', description: '🤖 Bot-Flotte anzeigen' },
                // System
                { command: 'layers', description: '🧠 Layer-Status' },
                { command: 'verbose', description: '🔊 Verbose-Modus' },
                { command: 'strict', description: '🔒 Strict-Mode' },
                { command: 'commands', description: '📝 Alle Befehle auflisten' },
                { command: 'heartbeat', description: '❤️ Heartbeat routines' },
                // Self-Evolution & Self-Setup
                { command: 'setup', description: '🔧 Self-Setup Scan & Plan anzeigen' },
                { command: 'patches', description: '🧬 Patch-Vorschläge anzeigen' },
                { command: 'patch', description: '🧬 Patch freigeben / ablehnen' },
                // Browser
                { command: 'browser', description: '🌐 Browser-Status & Web-Suche' },
            ])
            console.log('[Nova Telegram] ✓ Slash-Commands registriert')
        } catch (err) {
            console.log(`[Nova Telegram] ⚠ setMyCommands failed: ${err}`)
        }

        // Handle incoming messages (queued per chat to prevent API rate-limiting)
        this.bot.on('message', (msg: any) => {
            const chatId = String(msg.chat?.id || 'unknown')
            this.enqueueMessage(chatId, () => this.handleMessage(msg))
        })

        // Handle voice messages
        this.bot.on('voice', (msg: any) => {
            const chatId = String(msg.chat?.id || 'unknown')
            this.enqueueMessage(chatId, () => this.handleVoiceMessage(msg))
        })

        // Handle documents (PDFs, files, images sent as files)
        this.bot.on('document', (msg: any) => {
            const chatId = String(msg.chat?.id || 'unknown')
            this.enqueueMessage(chatId, () => this.handleDocumentMessage(msg))
        })

        // Handle feedback callbacks (👍/👎)
        this.bot.on('callback_query', async (query: any) => {
            await this.handleFeedback(query)
        })

        // Handle message reactions (👍❤️🔥 etc.) from users
        this.bot.on('message_reaction', async (reaction: any) => {
            await this.handleReaction(reaction)
        })

        // === 409 Conflict: stop first, then retry only with a live fenced lease ===
        let conflictBackoffActive = false
        this.bot.on('polling_error', async (err: any) => {
            const msg = err?.message || ''
            if (msg.includes('409 Conflict') && !conflictBackoffActive) {
                conflictBackoffActive = true
                console.warn('[Nova Telegram] ⚠️ 409 Conflict: another bot instance is polling; stopping before authority check')
                try {
                    await this.bot?.stopPolling({ cancel: true })
                } catch { /* ignore */ }

                if (this.disconnecting || !(await mayRetryTelegramPolling())) {
                    console.warn('[Nova Telegram] 🛡️ Poller fenced: live Telegram authority is absent; no retry')
                    return
                }

                const delay = telegramConflictRetryDelay()
                console.warn(`[Nova Telegram] Live authority confirmed; retrying polling in ${Math.round(delay / 1000)}s`)
                this.conflictRetryTimer = setTimeout(async () => {
                    this.conflictRetryTimer = undefined
                    if (this.disconnecting || !(await mayRetryTelegramPolling())) {
                        console.warn('[Nova Telegram] 🛡️ Poller fenced before retry: Telegram lease changed')
                        return
                    }
                    console.log('[Nova Telegram] 🔄 Authority revalidated — re-starting polling...')
                    try {
                        await this.bot?.startPolling({ restart: true })
                        conflictBackoffActive = false
                    } catch (retryErr) {
                        console.warn(`[Nova Telegram] ❌ Re-poll failed: ${retryErr}`)
                        conflictBackoffActive = false
                    }
                }, delay)
            }
        })

        // Start polling only after every update listener is registered. Telegram
        // may deliver buffered offline updates immediately; starting earlier
        // acknowledges those updates before the 'message' listener can see them.
        await this.bot.startPolling()
    }

    private async handleVoiceMessage(msg: any): Promise<void> {
        const chatId = msg.chat.id.toString()
        const userId = msg.from?.id?.toString() ?? ''

        try {
            // Download voice file
            const fileInfo = await this.bot.getFile(msg.voice.file_id)
            const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${fileInfo.file_path}`

            const response = await fetch(fileUrl)
            const buffer = await response.arrayBuffer()

            // Save temporarily
            const { writeFileSync, unlinkSync } = await import('node:fs')
            const { join } = await import('node:path')
            const tempPath = join(process.cwd(), '.nova-voice', `voice_${Date.now()}.ogg`)

            const { mkdirSync, existsSync } = await import('node:fs')
            const dir = join(process.cwd(), '.nova-voice')
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

            writeFileSync(tempPath, Buffer.from(buffer))
            console.log(`[Nova Telegram] Voice message received: ${tempPath}`)

            // Transcribe with Whisper
            try {
                const { transcribe } = await import('../voice/voice-input.js')
                const result = await transcribe(tempPath, { model: 'whisper-local' })

                console.log(`[Nova Telegram] Transcribed: "${result.text}"`)

                // Create message with transcribed text
                const incoming: IncomingMessage = {
                    id: msg.message_id.toString(),
                    channel: 'telegram',
                    from: userId,
                    to: chatId,
                    content: result.text,
                    timestamp: msg.date * 1000,
                    isGroup: false,
                }

                if (this.messageHandler) {
                    this.startTyping(chatId)
                    try {
                        await (this.messageHandler(incoming) as unknown as Promise<void>)
                    } catch (err) {
                        console.error(`[Nova Telegram] Voice messageHandler threw: ${err}`)
                    } finally {
                        this.stopTyping(chatId)
                    }
                }

                // Cleanup
                try { unlinkSync(tempPath) } catch { }
            } catch (err) {
                console.log(`[Nova Telegram] Whisper not available — invoking CapabilityRouter...`)
                await this.bot.sendMessage(chatId, '🎤 Sprachnachricht empfangen!\n\n⏳ *Wird automatisch aufgelöst — bitte kurz warten...*', { parse_mode: 'Markdown' })

                try {
                    const { resolveCapability, CAPABILITIES, formatResolution } = await import('../intelligence/capability-router.js')
                    const query = CAPABILITIES.whisper()
                    const resolution = await resolveCapability(query)

                    if (resolution.error) {
                        await this.bot.sendMessage(chatId, `❌ ${formatResolution(query, resolution)}\n\nInstalliere manuell: \`pip3 install openai-whisper\``, { parse_mode: 'Markdown' })
                    } else if (resolution.runRemotely) {
                        const { execSync } = await import('node:child_process')
                        const remoteResult = execSync(
                            `${resolution.sshPrefix} 'python3 -c "import whisper; m=whisper.load_model(chr(98)+chr(97)+chr(115)+chr(101)); r=m.transcribe(chr(47)+chr(116)+chr(109)+chr(112)+chr(47)+chr(118).join([])); print(r[chr(116)+chr(101)+chr(120)+chr(116)])"; echo done'`,
                            { timeout: 60_000 }
                        ).toString().trim()
                        const incoming: IncomingMessage = {
                            id: msg.message_id.toString(), channel: 'telegram', from: userId,
                            to: chatId, content: remoteResult, timestamp: msg.date * 1000, isGroup: false,
                        }
                        if (this.messageHandler) {
                            this.startTyping(chatId)
                            try {
                                await (this.messageHandler(incoming) as unknown as Promise<void>)
                            } catch (err) {
                                console.error(`[Nova Telegram] Remote-voice messageHandler threw: ${err}`)
                            } finally {
                                this.stopTyping(chatId)
                            }
                        }
                        await this.bot.sendMessage(chatId, `${formatResolution(query, resolution)}\n\n_"${remoteResult}"_`, { parse_mode: 'Markdown' })
                    } else {
                        const { transcribe } = await import('../voice/voice-input.js')
                        const result = await transcribe(tempPath, { model: 'whisper-local' })
                        const incoming: IncomingMessage = {
                            id: msg.message_id.toString(), channel: 'telegram', from: userId,
                            to: chatId, content: result.text, timestamp: msg.date * 1000, isGroup: false,
                        }
                        if (this.messageHandler) {
                            this.startTyping(chatId)
                            try {
                                await (this.messageHandler(incoming) as unknown as Promise<void>)
                            } catch (err) {
                                console.error(`[Nova Telegram] Local-voice messageHandler threw: ${err}`)
                            } finally {
                                this.stopTyping(chatId)
                            }
                        }
                        await this.bot.sendMessage(chatId, `${formatResolution(query, resolution)}\n\n_"${result.text}"_`, { parse_mode: 'Markdown' })
                    }
                } catch (capErr) {
                    await this.bot.sendMessage(chatId, `❌ Transkription fehlgeschlagen: ${capErr}`)
                }
            }
        } catch (err) {
            console.error(`[Nova Telegram] Voice error: ${err}`)
        }
    }



    private async handleDocumentMessage(msg: any): Promise<void> {
        const chatId = msg.chat.id.toString()
        const userId = msg.from?.id?.toString() ?? ''
        const doc = msg.document

        if (!doc) return

        try {
            const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
            const { join } = await import('node:path')

            // Download the document
            const fileInfo = await this.bot.getFile(doc.file_id)
            const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${fileInfo.file_path}`

            const response = await fetch(fileUrl)
            const buffer = await response.arrayBuffer()

            // Save to .nova-data/media/inbound/ (like OpenClaw does)
            const mediaDir = join(process.cwd(), '.nova-data', 'media', 'inbound')
            if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true })

            const fileName = doc.file_name || `file_${Date.now()}`
            const savePath = join(mediaDir, fileName)
            writeFileSync(savePath, Buffer.from(buffer))

            console.log(`[Nova Telegram] Dokument gespeichert: ${savePath} (${Math.round(buffer.byteLength / 1024)} KB)`)

            // Determine if it's an image sent as document
            const mimeType = doc.mime_type || ''
            const isImage = mimeType.startsWith('image/')

            let imageData: { data: string; mimeType: string } | undefined
            if (isImage) {
                imageData = {
                    data: Buffer.from(buffer).toString('base64'),
                    mimeType,
                }
            }

            // Build content with file info
            const caption = msg.caption || ''
            const content = caption
                ? `${caption}\n\n📄 Datei: ${fileName} (${mimeType}, ${Math.round(buffer.byteLength / 1024)} KB)\nGespeichert unter: ${savePath}`
                : `📄 Datei empfangen: ${fileName} (${mimeType}, ${Math.round(buffer.byteLength / 1024)} KB)\nGespeichert unter: ${savePath}\n\nBitte analysiere diese Datei.`

            const incoming: IncomingMessage = {
                id: msg.message_id.toString(),
                channel: 'telegram',
                from: userId,
                to: chatId,
                content,
                timestamp: msg.date * 1000,
                isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
                ...(imageData && { image: imageData }),
            }

            if (this.messageHandler) {
                this.startTyping(chatId)
                try {
                    await (this.messageHandler(incoming) as unknown as Promise<void>)
                } catch (err) {
                    console.error(`[Nova Telegram] Document messageHandler threw: ${err}`)
                } finally {
                    this.stopTyping(chatId)
                }
            }
        } catch (err) {
            console.error(`[Nova Telegram] Dokument-Fehler: ${err}`)
        }
    }

    private async handleFeedback(query: any): Promise<void> {
        const data = query.data
        const chatId = query.message?.chat?.id?.toString()
        const userId = query.from?.id?.toString() ?? ''

        if (data?.startsWith('feedback_')) {
            const [, rating, messageId] = data.split('_')

            try {
                const { recordFeedback } = await import('../training/feedback-learner.js')
                recordFeedback(
                    'user_message',  // We'd need to store this
                    query.message?.text || '',
                    rating === 'up' ? 'positive' : 'negative'
                )

                await this.bot.answerCallbackQuery(query.id, {
                    text: rating === 'up' ? '👍 Danke für das Feedback!' : '👎 Danke, ich lerne daraus!'
                })

                // Remove buttons after feedback
                await this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [] },
                    { chat_id: chatId, message_id: query.message.message_id }
                )
            } catch (err) {
                console.log(`[Nova Telegram] Feedback error: ${err}`)
            }
        }

        // Provider selection → show models for that provider
        if (data?.startsWith('provider_')) {
            const provider = data.replace('provider_', '')
            try {
                const { availableLLMs } = await import('../core/llm-factory.js')
                if (provider === 'openai-codex') {
                    const { resolvePrincipalId } = await import('../users/principal-id.js')
                    const { getCodexDisplayModel } = await import('../auth/codex-runtime.js')
                    const principalId = resolvePrincipalId((globalThis as any).__novaState?.config, 'telegram', userId || String(chatId))
                    const codex = await getCodexDisplayModel(principalId)
                    const statusText = codex.authenticated
                        ? `🔐 *OpenAI Codex (OAuth)*\n\n✅ Verbunden für diesen Nova-User\n📍 Modell: \`${codex.model}\`\n🖥️ Node: \`${codex.nodeId}\`\n⚡ Wird automatisch bevorzugt\n\nBei einem Fehler fällt Nova auf das lokale vLLM zurück.`
                        : `🔐 *OpenAI Codex (OAuth)*\n\n⚪ Nicht für diesen Nova-User verbunden.\nAnmeldung: /codex login`
                    await this.bot.editMessageText(statusText, {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '⬅️ Zurück', callback_data: 'models_back' }]] },
                    })
                    await this.bot.answerCallbackQuery(query.id)
                    return
                }
                const modelsForProvider = availableLLMs.filter(l => l.provider === provider)

                // Only show dynamically discovered models (no stale catalog merge)
                const allModels = modelsForProvider.map(m => ({
                    id: m.model,
                    name: m.model
                }))

                if (allModels.length === 0) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: `Keine Modelle für ${provider} verfügbar`
                    })
                    return
                }

                const buttons = allModels.map(m => {
                    // Telegram limits callback_data to 64 bytes
                    let cbData = `sw_${provider.slice(0, 8)}_${m.id}`
                    if (cbData.length > 64) {
                        // Hash long model names
                        const hash = m.id.split('').reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString(36)
                        cbData = `sw_${provider.slice(0, 8)}_${m.id.slice(0, 45)}_${hash}`
                        if (cbData.length > 64) cbData = cbData.slice(0, 64)
                    }
                    return [{ text: m.name, callback_data: cbData }]
                })
                // Add back button
                buttons.push([{ text: '⬅️ Zurück', callback_data: 'models_back' }])

                await this.bot.editMessageText(`🤖 *${provider}* — Modell wählen:`, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buttons }
                })
                await this.bot.answerCallbackQuery(query.id)
            } catch (err) {
                console.log(`[Nova Telegram] Provider selection error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Model switch → apply (handles both sw_ and legacy switch_ prefix)
        if (data?.startsWith('sw_') || data?.startsWith('switch_')) {
            const parts = data.split('_')
            const provider = parts[1]
            const model = parts.slice(2).join('_').replace(/_[a-z0-9]+$/, '')  // Remove hash suffix if present
            try {
                const { createLLM } = await import('../core/llm-factory.js')
                // Get the wrapper from the global state (stored by message-pipeline)
                const state = (globalThis as any).__novaState
                if (state?.llm?.switchModel) {
                    const success = await state.llm.switchModel(model, provider)
                    if (success) {
                        await this.bot.editMessageText(`✅ Gewechselt zu *${provider}/${model}*`, {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            parse_mode: 'Markdown',
                        })
                        await this.bot.answerCallbackQuery(query.id, { text: `✅ ${model}` })
                    } else {
                        await this.bot.answerCallbackQuery(query.id, { text: '❌ Wechsel fehlgeschlagen' })
                    }
                } else {
                    await this.bot.answerCallbackQuery(query.id, { text: '❌ LLM nicht initialisiert' })
                }
            } catch (err) {
                console.log(`[Nova Telegram] Model switch error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Back to provider list
        if (data === 'models_back') {
            try {
                const { resolvePrincipalId } = await import('../users/principal-id.js')
                const principalId = resolvePrincipalId((globalThis as any).__novaState?.config, 'telegram', userId || String(chatId))
                await this.sendModelSelector(chatId!, query.message.message_id, principalId)
                await this.bot.answerCallbackQuery(query.id)
            } catch (err) {
                console.log(`[Nova Telegram] Back navigation error: ${err}`)
            }
        }

        // Command buttons (from /help, /status, /layers etc.)
        if (data?.startsWith('cmd_')) {
            const cmd = data.replace('cmd_', '')
            try {
                const state = (globalThis as any).__novaState
                if (!state) {
                    await this.bot.answerCallbackQuery(query.id, { text: '❌ Nova nicht initialisiert' })
                    return
                }

                const { handleCommand } = await import('../core/slash-commands.js')
                const { availableLLMs } = await import('../core/llm-factory.js')

                // Special routing for some commands
                if (cmd === 'models') {
                    const { resolvePrincipalId } = await import('../users/principal-id.js')
                    const principalId = resolvePrincipalId(state?.config, 'telegram', userId || String(chatId))
                    await this.sendModelSelector(chatId!, undefined, principalId)
                    await this.bot.answerCallbackQuery(query.id)
                    return
                }

                if (cmd === 'mission_config') {
                    const { formatMissionConfig } = await import('../core/autonomous-executor.js')
                    const text = formatMissionConfig()
                    const buttons = this.getMissionConfigButtons()
                    await this.bot.sendMessage(chatId, text, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: buttons }
                    })
                    await this.bot.answerCallbackQuery(query.id)
                    return
                }

                if (cmd === 'helptext') {
                    // Full text help (no buttons)
                    const helpText = `✨ *Nova Befehle*

*System:* /status /layers /model /models /strict /persona /info
*Reasoning:* /think /reasoning /verbose /debug
*Tasks:* /task /task history /log
*Memory:* /memory /skills /learn /lernstatus /korrektur
*SSH:* /hosts /hosts new /hosts del
*Mesh:* /nodes /nodes info /nodes sync /nodes restart
*Session:* /clear /save /compact /apikey
*Bots:* /bots /bot /swarm
*Agents:* /agents /factory
*Projekt:* /project
*Monitor:* /monitor
*Autonomie:* /autonom /mission /remind
*Pre-Flight:* /preflight /preflight local /preflight <host>
*Auth:* /login /callback`
                    await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' })
                    await this.bot.answerCallbackQuery(query.id)
                    return
                }

                // Route to handleCommand — chatId is used as 'from' for button responses
                const response = await handleCommand(cmd, '', chatId!, state, availableLLMs)
                if (response) {
                    // handleCommand returned text (non-Telegram fallback or no-button command)
                    await this.bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })
                }
                await this.bot.answerCallbackQuery(query.id)
            } catch (err) {
                console.log(`[Nova Telegram] Command callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Persona presets
        if (data?.startsWith('persona_')) {
            const preset = data.replace('persona_', '')
            const presets: Record<string, string> = {
                nova: 'Du heißt Nova, bist ein hilfreicher KI-Assistent. Freundlich, präzise, auf Deutsch.',
                business: 'Du heißt Nova, bist ein professioneller Business-Berater. Formell, analytisch, strategisch.',
                creative: 'Du heißt Nova, bist ein kreativer Assistent. Inspirierend, experimentell, out-of-the-box.',
                devops: 'Du heißt Nova, bist ein DevOps-Experte. Technisch, effizient, sicherheitsbewusst.',
            }
            try {
                const state = (globalThis as any).__novaState
                if (state) {
                    const { handleCommand } = await import('../core/slash-commands.js')
                    const { availableLLMs } = await import('../core/llm-factory.js')
                    const response = await handleCommand('persona', presets[preset] || preset, chatId!, state, availableLLMs)
                    if (response) await this.bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })
                }
                await this.bot.answerCallbackQuery(query.id, { text: `✅ Persona: ${preset}` })
            } catch (err) {
                console.log(`[Nova Telegram] Persona callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Learn skills
        if (data?.startsWith('learn_')) {
            const skill = data.replace('learn_', '')
            try {
                const state = (globalThis as any).__novaState
                if (state) {
                    const { handleCommand } = await import('../core/slash-commands.js')
                    const { availableLLMs } = await import('../core/llm-factory.js')
                    await this.bot.answerCallbackQuery(query.id, { text: `⏳ Lerne ${skill}...` })
                    const response = await handleCommand('learn', skill, chatId!, state, availableLLMs)
                    if (response) await this.bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })
                }
            } catch (err) {
                console.log(`[Nova Telegram] Learn callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // LLM actions
        if (data?.startsWith('llm_')) {
            const action = data.replace('llm_', '')
            try {
                const state = (globalThis as any).__novaState
                if (state) {
                    const { handleCommand } = await import('../core/slash-commands.js')
                    const { availableLLMs } = await import('../core/llm-factory.js')
                    const response = await handleCommand('llm', action, chatId!, state, availableLLMs)
                    if (response) await this.bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })
                }
                await this.bot.answerCallbackQuery(query.id)
            } catch (err) {
                console.log(`[Nova Telegram] LLM callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Memory actions
        if (data?.startsWith('memory_')) {
            const action = data.replace('memory_', '')
            try {
                const state = (globalThis as any).__novaState
                if (state) {
                    if (action === 'clear') {
                        if (state.memory) {
                            await state.memory.clear(chatId!)
                            await this.bot.sendMessage(chatId, '🗑️ Memory gelöscht!', { parse_mode: 'Markdown' })
                        } else {
                            await this.bot.sendMessage(chatId, '❌ Memory nicht aktiviert', { parse_mode: 'Markdown' })
                        }
                    } else if (action === 'search') {
                        await this.bot.sendMessage(chatId, '🔍 Sende mir einen Suchbegriff und ich durchsuche dein Memory.', { parse_mode: 'Markdown' })
                    } else if (action === 'export') {
                        await this.bot.sendMessage(chatId, '💾 Memory-Export ist noch in Entwicklung.', { parse_mode: 'Markdown' })
                    }
                }
                await this.bot.answerCallbackQuery(query.id)
            } catch (err) {
                console.log(`[Nova Telegram] Memory callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Mission config buttons (from /mission config)
        if (data?.startsWith('mcfg_')) {
            try {
                const { updateMissionConfig, getMissionConfig, formatMissionConfig } = await import('../core/autonomous-executor.js')
                const action = data.replace('mcfg_', '')
                const cfg = getMissionConfig()

                const adjustments: Record<string, { key: string; delta: number; unit?: string }> = {
                    cont_up: { key: 'maxContinuations', delta: 1 },
                    cont_down: { key: 'maxContinuations', delta: -1 },
                    steps_up: { key: 'maxSteps', delta: 5 },
                    steps_down: { key: 'maxSteps', delta: -5 },
                    timeout_up: { key: 'timeoutPerStep', delta: 30000, unit: 's' },
                    timeout_down: { key: 'timeoutPerStep', delta: -30000, unit: 's' },
                    retries_up: { key: 'maxRetries', delta: 1 },
                    retries_down: { key: 'maxRetries', delta: -1 },
                }

                const adj = adjustments[action]
                if (adj) {
                    const current = (cfg as any)[adj.key] || 0
                    const newVal = Math.max(1, current + adj.delta)
                    updateMissionConfig({ [adj.key]: newVal })
                    const updatedText = formatMissionConfig()
                    const buttons = this.getMissionConfigButtons()
                    await this.bot.editMessageText(updatedText, {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: buttons }
                    })
                }

                await this.bot.answerCallbackQuery(query.id, { text: '✅ Updated' })
            } catch (err) {
                console.log(`[Nova Telegram] Mission config callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // ── Patch approval: patch_ok:<id> / patch_no:<id> ──────────────────────
        if (data.startsWith('patch_ok:') || data.startsWith('patch_no:')) {
            try {
                const { getUserPermission } = await import('../users/multi-user-middleware.js')
                const callbackUserId = String(query.from?.id || chatId)
                if (getUserPermission(callbackUserId, 'telegram') !== 'owner') {
                    await this.bot.answerCallbackQuery(query.id, { text: 'Nur der Owner darf PATCH_GATE freigeben.' })
                    return
                }
                const approve = data.startsWith('patch_ok:')
                const proposalId = data.slice(approve ? 9 : 9)

                await this.bot.answerCallbackQuery(query.id, { text: approve ? '⏳ Anwenden…' : '🗑️ Ablehnen…' })

                if (approve) {
                    const token = process.env.NOVA_PATCH_GATE_TOKEN
                    if (!token) {
                        await this.bot.sendMessage(chatId, '❌ `NOVA_PATCH_GATE_TOKEN` ist nicht gesetzt.', { parse_mode: 'Markdown' })
                    } else {
                        const { getPatchProposals, evolve } = await import('../synthesis/self-evolution.js')
                        const proposals = getPatchProposals(200)
                        const proposal = proposals.find((p: any) => p.id === proposalId)
                        if (!proposal) {
                            await this.bot.sendMessage(chatId, `❌ Proposal nicht gefunden: \`${proposalId}\``, { parse_mode: 'Markdown' })
                        } else if (proposal.status !== 'queued') {
                            await this.bot.sendMessage(chatId, `⚠️ Bereits: ${proposal.status}`, { parse_mode: 'Markdown' })
                        } else {
                            const result = proposal.kind === 'doctor-config'
                                ? await (async () => {
                                    const { applyApprovedDoctorProposal } = await import('../doctor/safe-fixes.js')
                                    const applied = await applyApprovedDoctorProposal(proposal, token)
                                    return { success: applied.applied, error: applied.applied ? undefined : applied.message,
                                        branch: 'doctor-config', duration: 0, rollbackPerformed: false }
                                })()
                                : await evolve({
                                    file: proposal.file,
                                    description: proposal.description,
                                    search: proposal.search,
                                    replace: proposal.replace,
                                    reason: proposal.reason,
                                    apply: true,
                                    approvalToken: token,
                                })
                            // Mark status in file
                            try {
                                const { readFileSync, writeFileSync } = await import('node:fs')
                                const { join } = await import('node:path')
                                const pPath = join(process.cwd(), '.nova-data', 'patch-proposals.json')
                                const all = JSON.parse(readFileSync(pPath, 'utf-8'))
                                const idx = all.findIndex((p: any) => p.id === proposalId)
                                if (idx >= 0) { all[idx].status = result.success ? 'applied' : 'failed'; all[idx].appliedAt = Date.now() }
                                writeFileSync(pPath, JSON.stringify(all, null, 2))
                            } catch { /* non-critical */ }
                            const msg = result.success
                                ? `✅ *Patch angewendet!*\n🌿 Branch: \`${result.branch}\`\n⏱️ ${result.duration}ms\n🔄 Nova startet neu…`
                                : `❌ *Patch fehlgeschlagen*\n${result.error || 'Unbekannter Fehler'}${result.rollbackPerformed ? '\n↩️ Rollback durchgeführt.' : ''}`
                            await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
                        }
                    }
                } else {
                    // Reject
                    try {
                        const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
                        const { join } = await import('node:path')
                        const pPath = join(process.cwd(), '.nova-data', 'patch-proposals.json')
                        if (existsSync(pPath)) {
                            const all = JSON.parse(readFileSync(pPath, 'utf-8'))
                            const idx = all.findIndex((p: any) => p.id === proposalId)
                            if (idx >= 0) { all[idx].status = 'rejected'; all[idx].rejectedAt = Date.now() }
                            writeFileSync(pPath, JSON.stringify(all, null, 2))
                        }
                        await this.bot.sendMessage(chatId, `🗑️ Patch \`${proposalId}\` abgelehnt.`, { parse_mode: 'Markdown' })
                    } catch (err) {
                        await this.bot.sendMessage(chatId, `❌ Fehler beim Ablehnen: ${err}`)
                    }
                }

                // Remove buttons from original message
                try {
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: chatId, message_id: query.message.message_id }
                    )
                } catch { /* message may be too old */ }
            } catch (err) {
                console.log(`[Nova Telegram] Patch callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // ── Skill approval: skill_ok:<id> / skill_no:<id> ────────────────────
        if (data.startsWith('skill_ok:') || data.startsWith('skill_no:')) {
            try {
                const approve = data.startsWith('skill_ok:')
                const proposalId = data.slice(9)

                await this.bot.answerCallbackQuery(query.id, { text: approve ? '🧪 Sandbox freigeben…' : '🗑️ Ablehnen…' })

                const { updateSkillProposalStatus, getSkillProposals } = await import('../tools/skill-builder.js')

                if (approve) {
                    const proposals = getSkillProposals(200)
                    const proposal = proposals.find(p => p.id === proposalId)
                    if (!proposal) {
                        await this.bot.sendMessage(chatId, `❌ Skill-Proposal nicht gefunden: \`${proposalId}\``, { parse_mode: 'Markdown' })
                    } else if (proposal.status !== 'proposed') {
                        await this.bot.sendMessage(chatId, `⚠️ Bereits: ${proposal.status}`, { parse_mode: 'Markdown' })
                    } else {
                        const queued = updateSkillProposalStatus(proposalId, 'approved', proposal.ownerId)
                        const msg = queued
                            ? `🧪 *Skill \`${proposal.name}\`: Sandbox freigegeben*\n\nNoch nicht aktiv. Nova benötigt verifizierte Sandbox-, Benchmark- und Canary-Ergebnisse sowie die abschließende Owner-Freigabe.`
                            : `❌ Sandbox-Freigabe fehlgeschlagen für \`${proposal.name}\`.`
                        await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
                    }
                } else {
                    const existing = getSkillProposals(200).find(p => p.id === proposalId)
                    const proposal = existing ? updateSkillProposalStatus(proposalId, 'rejected', existing.ownerId) : null
                    const name = proposal?.name || proposalId
                    await this.bot.sendMessage(chatId, `🗑️ Skill \`${name}\` abgelehnt.`, { parse_mode: 'Markdown' })
                }

                // Remove buttons
                try {
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: chatId, message_id: query.message.message_id }
                    )
                } catch { /* message may be too old */ }
            } catch (err) {
                console.log(`[Nova Telegram] Skill callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // ── Node-Install: ni:<model>:<node> ──────────────────────────────────
        if (data.startsWith('ni:')) {
            try {
                await this.bot.answerCallbackQuery(query.id, { text: '⏳ Installiere…' })

                // Format: ni:<model>:<node>  (model may contain colons — split from right)
                const withoutPrefix = data.slice(3)
                const lastColon = withoutPrefix.lastIndexOf(':')
                const model = lastColon > 0 ? withoutPrefix.slice(0, lastColon) : withoutPrefix
                const nodeName = lastColon > 0 ? withoutPrefix.slice(lastColon + 1) : 'local'

                await this.bot.sendMessage(chatId, `📥 Installiere \`${model}\` auf *${nodeName}*…`, { parse_mode: 'Markdown' })

                try {
                    if (nodeName === 'local' || nodeName === 'localhost') {
                        const { execSync } = await import('child_process')
                        execSync(`ollama pull ${model}`, { timeout: 300_000, encoding: 'utf-8' })
                        await this.bot.sendMessage(chatId, `✅ Modell \`${model}\` lokal installiert!`, { parse_mode: 'Markdown' })
                    } else {
                        // Remote node via mesh
                        const { discoverNodes } = await import('../mesh/mesh-registry.js')
                        const nodes = await discoverNodes()
                        const node = nodes.find((n: any) =>
                            n.hostname?.toLowerCase() === nodeName.toLowerCase() ||
                            n.ip === nodeName ||
                            n.node_id?.includes(nodeName.toLowerCase())
                        )
                        if (!node?.ip) {
                            await this.bot.sendMessage(chatId, `❌ Node *${nodeName}* nicht gefunden.`, { parse_mode: 'Markdown' })
                        } else {
                            const { execSync } = await import('child_process')
                            const sshUser = node.ssh_user || 'root'
                            const sshPort = node.ssh_port || 22
                            execSync(
                                `ssh -o ConnectTimeout=10 -p ${sshPort} ${sshUser}@${node.ip} "ollama pull ${model}"`,
                                { timeout: 300_000, encoding: 'utf-8' }
                            )
                            await this.bot.sendMessage(chatId, `✅ Modell \`${model}\` auf *${nodeName}* installiert!`, { parse_mode: 'Markdown' })
                        }
                    }
                } catch (execErr: any) {
                    await this.bot.sendMessage(chatId, `❌ Installation fehlgeschlagen:\n\`${String(execErr?.message || execErr).slice(0, 300)}\``, { parse_mode: 'Markdown' })
                }

                // Remove buttons
                try {
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: chatId, message_id: query.message.message_id }
                    )
                } catch { /* message may be too old */ }
            } catch (err) {
                console.log(`[Nova Telegram] Node-install callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }

        // Doctor buttons: fix / deep / json
        if (data === 'doctor_fix' || data === 'doctor_deep' || data === 'doctor_json') {
            try {
                const { getUserPermission } = await import('../users/multi-user-middleware.js')
                const callbackUserId = String(query.from?.id || chatId)
                if (data === 'doctor_fix' && !['owner', 'admin'].includes(getUserPermission(callbackUserId, 'telegram'))) {
                    await this.bot.answerCallbackQuery(query.id, { text: 'Nur Owner/Admin dürfen Doctor-Fixes vorschlagen.' })
                    return
                }
                await this.bot.answerCallbackQuery(query.id, { text: '⏳ Läuft...' })

                const {
                    collectDiagnostics,
                    formatReportFull,
                    formatReportJson,
                    applySafeFixes,
                    formatFixRunResult,
                } = await import('../doctor/index.js')

                if (data === 'doctor_fix') {
                    const report = await collectDiagnostics()
                    const safeFixes = report.issues.filter((i: any) => i.fix?.safe)
                    if (safeFixes.length === 0) {
                        await this.bot.sendMessage(chatId, '✅ *Keine sicheren Fixes nötig.*', { parse_mode: 'Markdown' })
                    } else {
                        const fixResult = await applySafeFixes(report)
                        const text = formatFixRunResult(fixResult)
                        await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
                    }
                } else if (data === 'doctor_deep') {
                    const report = await collectDiagnostics()
                    const text = '```\n' + formatReportFull(report) + '\n```'
                    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
                } else if (data === 'doctor_json') {
                    const report = await collectDiagnostics()
                    const text = '```json\n' + formatReportJson(report) + '\n```'
                    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
                }

                // Remove buttons from original message
                try {
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: chatId, message_id: query.message.message_id }
                    )
                } catch { /* message may be too old */ }
            } catch (err) {
                console.log(`[Nova Telegram] Doctor callback error: ${err}`)
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Fehler' })
            }
        }
    }

    /**
     * Get mission config inline keyboard buttons
     */
    getMissionConfigButtons(): Array<Array<{ text: string; callback_data: string }>> {
        return [
            [
                { text: '🔄 Continuations ➖', callback_data: 'mcfg_cont_down' },
                { text: '🔄 Continuations ➕', callback_data: 'mcfg_cont_up' },
            ],
            [
                { text: '📝 Steps ➖', callback_data: 'mcfg_steps_down' },
                { text: '📝 Steps ➕', callback_data: 'mcfg_steps_up' },
            ],
            [
                { text: '⏱️ Timeout ➖', callback_data: 'mcfg_timeout_down' },
                { text: '⏱️ Timeout ➕', callback_data: 'mcfg_timeout_up' },
            ],
            [
                { text: '🔁 Retries ➖', callback_data: 'mcfg_retries_down' },
                { text: '🔁 Retries ➕', callback_data: 'mcfg_retries_up' },
            ],
        ]
    }

    /**
     * Send model selector with inline keyboard buttons
     * Shows available providers as buttons, grouped by type
     */
    async sendModelSelector(chatId: string, editMessageId?: number, principalId?: string): Promise<void> {
        if (!this.bot) return

        const { availableLLMs } = await import('../core/llm-factory.js')
        const visibleLLMs = [...availableLLMs]
        try {
            const { resolvePrincipalId } = await import('../users/principal-id.js')
            const { getCodexDisplayModel } = await import('../auth/codex-runtime.js')
            const resolvedPrincipal = principalId
                || resolvePrincipalId((globalThis as any).__novaState?.config, 'telegram', chatId)
            const codex = await getCodexDisplayModel(resolvedPrincipal)
            if (codex.available && codex.authenticated && !visibleLLMs.some(entry =>
                entry.provider === codex.provider && entry.model === codex.model)) {
                visibleLLMs.push(codex)
            }
        } catch { /* Codex is optional. */ }

        // Group by provider
        const providers = new Set(visibleLLMs.map(l => l.provider))

        const providerLabels: Record<string, string> = {
            'openai': '🟢 OpenAI',
            'openrouter': '🔀 OpenRouter',
            'groq': '⚡ Groq',
            'anthropic': '🟠 Anthropic',
            'openai-codex': '🔐 OpenAI Codex',
            'local': '🏠 Lokal (vLLM/Ollama)',
            'ollama': '🏠 Ollama',
        }

        const buttons = [...providers].map(p => [{
            text: providerLabels[p] || `📦 ${p}`,
            callback_data: `provider_${p}`
        }])

        const state = (globalThis as any).__novaState
        const activeProvider = state?.llm?.provider || 'auto'
        const activeModel = state?.llm?.modelId || state?.activeModel || 'unbekannt'
        const text = `🤖 *Modelle*\n\nAktiv: \`${activeProvider}/${activeModel}\`\n\nProvider auswählen, um das Runtime-Modell ausdrücklich zu wechseln:`

        if (editMessageId) {
            await this.bot.editMessageText(text, {
                chat_id: chatId,
                message_id: editMessageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            })
        } else {
            await this.bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            })
        }
    }

    /**
     * Send a message with inline keyboard buttons
     * General-purpose: used by all slash commands for interactive UX
     */
    async sendWithButtons(chatId: string, text: string, buttons: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
        if (!this.bot) return
        try {
            await this.bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            })
        } catch (err: any) {
            // Markdown failed → try plain text
            if (err.message?.includes("can't parse entities")) {
                await this.bot.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ''), {
                    reply_markup: { inline_keyboard: buttons }
                })
            }
        }
    }

    private async handleMessage(msg: any): Promise<void> {
        const chatId = msg.chat.id.toString()
        const userId = msg.from?.id?.toString() ?? ''
        const username = msg.from?.username ?? ''
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'

        // Check allowlist for DMs
        if (!isGroup && this.config.allowFrom?.length) {
            const allowed = this.config.allowFrom.some(
                a => a === userId || a === username || a === `@${username}`
            )
            if (!allowed) {
                console.log(`[Nova Telegram] Ignoring from non-allowed: ${username || userId}`)
                return
            }
        }

        // Check group mention requirement
        if (isGroup && this.config.groupPolicy === 'mention-only') {
            const mentioned = msg.text?.includes(`@${this.botUsername}`)
            if (!mentioned && !msg.photo) return
        }

        // Handle text or caption
        let content = msg.text || msg.caption || ''

        // Handle photos (Vision support)
        let imageData: { data: string; mimeType: string } | undefined
        if (msg.photo && msg.photo.length > 0) {
            try {
                // Get the largest photo (last in array)
                const photo = msg.photo[msg.photo.length - 1]
                const fileInfo = await this.bot.getFile(photo.file_id)
                const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${fileInfo.file_path}`

                // Download and convert to base64
                const response = await fetch(fileUrl)
                const buffer = await response.arrayBuffer()
                const base64 = Buffer.from(buffer).toString('base64')

                // Determine MIME type from extension
                const ext = fileInfo.file_path?.split('.').pop()?.toLowerCase() || 'jpg'
                const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'

                imageData = { data: base64, mimeType }
                console.log(`[Nova Telegram] Foto empfangen: ${Math.round(buffer.byteLength / 1024)} KB`)

                // If no caption, add default prompt
                if (!content) {
                    content = 'Was zeigt dieses Bild?'
                }
            } catch (err) {
                console.error(`[Nova Telegram] Foto-Fehler: ${err}`)
            }
        }

        // Skip if no content and no image
        if (!content && !imageData) return

        // Create incoming message
        const incoming: IncomingMessage = {
            id: msg.message_id.toString(),
            channel: 'telegram',
            from: userId,
            to: chatId,  // <-- chatId for replies
            content,
            timestamp: msg.date * 1000,
            isGroup,
            groupId: isGroup ? chatId : undefined,
            // Add image data for Vision
            ...(imageData && { image: imageData }),
        }

        // Track last active chat for proactive messages
        this.lastActiveChat = chatId

        // Auto-react to user message based on sentiment (emojis!)
        this.autoReactToMessage(chatId, msg.message_id, content)

        // Show "typing..." indicator while processing
        this.startTyping(chatId)

        if (this.messageHandler) {
            // MUST await so errors are caught and typing is always stopped
            try {
                await (this.messageHandler(incoming) as unknown as Promise<void>)
            } catch (err) {
                console.error(`[Nova Telegram] messageHandler threw: ${err}`)
            } finally {
                // Guarantee typing stops even if pipeline crashes or never sends
                this.stopTyping(chatId)
            }
        } else {
            this.stopTyping(chatId)
        }
    }

    async disconnect(): Promise<void> {
        console.log('[Nova Telegram] Disconnecting...')
        this.disconnecting = true
        if (this.conflictRetryTimer) {
            clearTimeout(this.conflictRetryTimer)
            this.conflictRetryTimer = undefined
        }
        if (this.bot) {
            await this.bot.stopPolling({ cancel: true })
            this.bot = null
        }
    }

    // ============================================
    // Messaging
    // ============================================

    async send(msg: OutgoingMessage): Promise<void> {
        if (!this.bot) {
            throw new Error('Telegram not connected')
        }

        // Sanitize content for Telegram
        let cleanContent = this.sanitizeForTelegram(formatTelegramMessage(sanitizeInternalOutboundArtifacts(msg.content)))

        // Skip if content is empty after sanitization
        if (!cleanContent.trim()) {
            const rawFallback = String(msg.content || '').trim()
            if (rawFallback && !isInternalOutboundArtifact(rawFallback)) {
                cleanContent = rawFallback.replace(/[*_`\[\]]/g, '')
                console.log('[Nova Telegram] Sanitizer produced empty text; using plain fallback')
            } else {
                console.log('[Nova Telegram] Skipped empty message after sanitization')
                return
            }
        }

        // Smart chunking for long messages (Telegram limit: 4096 chars)
        let chunks: string[] = [cleanContent]
        if (cleanContent.length > 4000) {
            try {
                const { chunkMessage } = await import('../utils/message-chunking.js')
                chunks = chunkMessage(cleanContent)
                if (chunks.length > 1) {
                    console.log(`[Nova Telegram] Splitting into ${chunks.length} chunks`)
                }
            } catch {
                // Fallback: simple split at 4000 chars
                chunks = []
                for (let i = 0; i < cleanContent.length; i += 4000) {
                    chunks.push(cleanContent.slice(i, i + 4000))
                }
            }
        }

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]
            try {
                await this.bot.sendMessage(msg.to, chunk, {
                    parse_mode: 'Markdown',
                    reply_to_message_id: i === 0 && msg.replyTo ? parseInt(msg.replyTo) : undefined,
                })
            } catch (err: any) {
                // If Markdown parsing fails, try plain text
                if (err.message?.includes("can't parse entities")) {
                    console.log('[Nova Telegram] Markdown failed, sending as plain text')
                    await this.bot.sendMessage(msg.to, chunk.replace(/[*_`\[\]]/g, ''), {
                        reply_to_message_id: i === 0 && msg.replyTo ? parseInt(msg.replyTo) : undefined,
                    })
                } else {
                    throw err
                }
            }

            // Pause between chunks for natural feel
            if (i < chunks.length - 1) {
                await new Promise(r => setTimeout(r, 300))
            }
        }

        // Stop typing indicator after sending
        this.stopTyping(msg.to)
    }

    /**
     * Send a ⏳ thinking indicator and return the message ID.
     * Used for pseudo-streaming: send ⏳ → pipeline runs → edit with response.
     */
    async sendThinking(chatId: string): Promise<number | null> {
        if (!this.bot) return null
        try {
            const sent = await this.bot.sendMessage(chatId, '⏳')
            return sent.message_id
        } catch {
            return null
        }
    }

    /** Send the single request-scoped progress bubble without notifying the user. */
    async sendProgress(chatId: string, text: string): Promise<number | null> {
        if (!this.bot) return null
        const clean = this.sanitizeForTelegram(formatTelegramMessage(text)) || '⏳ Nova arbeitet…'
        try {
            const sent = await this.bot.sendMessage(chatId, clean, {
                parse_mode: 'Markdown',
                disable_notification: true,
            })
            return sent.message_id
        } catch (err: any) {
            if (err.message?.includes("can't parse entities")) {
                const sent = await this.bot.sendMessage(chatId, clean.replace(/[*_`\[\]]/g, ''), {
                    disable_notification: true,
                })
                return sent.message_id
            }
            return null
        }
    }

    // Typing Indicator
    // ============================================

    /**
     * Start showing "typing..." in Telegram chat.
     * Re-sends every 4s (Telegram typing expires after 5s).
     * Inspired by OpenClaw's createTypingCallbacks().
     */
    startTyping(chatId: string): void {
        // Don't stack intervals for same chat
        this.stopTyping(chatId)

        const sendAction = () => {
            try {
                this.bot?.sendChatAction(chatId, 'typing')
            } catch {
                // Silently ignore typing failures
            }
        }

        // Send immediately, then every 4 seconds
        sendAction()
        const interval = setInterval(sendAction, 4000)
        this.typingIntervals.set(chatId, interval)

        // Safety timeout: auto-stop after 30s to prevent infinite typing
        setTimeout(() => this.stopTyping(chatId), 30000)
    }

    /**
     * Stop the typing indicator for a chat.
     */
    stopTyping(chatId: string): void {
        const interval = this.typingIntervals.get(chatId)
        if (interval) {
            clearInterval(interval)
            this.typingIntervals.delete(chatId)
        }
    }

    /**
     * Send a message with streaming (draft mode).
     * Shows ⏳ then progressively edits with incoming text.
     */
    async sendStreaming(chatId: string): Promise<DraftStream | null> {
        if (!this.bot) return null

        try {
            const stream = createDraftStream()
            await stream.start(
                chatId,
                async (cid: number | string, text: string) => {
                    const sent = await this.bot.sendMessage(cid, text)
                    return sent.message_id
                },
                async (cid: number | string, msgId: number, text: string) => {
                    const clean = this.sanitizeForTelegram(text)
                    try {
                        await this.bot.editMessageText(clean, {
                            chat_id: cid,
                            message_id: msgId,
                            parse_mode: 'Markdown',
                        })
                    } catch (err: any) {
                        // Fallback: plain text edit
                        if (err.message?.includes("can't parse entities")) {
                            await this.bot.editMessageText(clean.replace(/[*_`\[\]]/g, ''), {
                                chat_id: cid,
                                message_id: msgId,
                            })
                        }
                    }
                }
            )
            return stream
        } catch (err) {
            console.error(`[Nova Telegram] Streaming start failed: ${err}`)
            return null
        }
    }

    /**
     * Edit an existing message.
     */
    async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
        if (!this.bot) return
        const clean = this.sanitizeForTelegram(text)
        try {
            await this.bot.editMessageText(clean, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
            })
        } catch (err: any) {
            if (err.message?.includes("can't parse entities")) {
                await this.bot.editMessageText(clean.replace(/[*_`\[\]]/g, ''), {
                    chat_id: chatId,
                    message_id: messageId,
                })
            }
        }
    }

    /**
     * Delete a message by ID. Used to clean up thinking indicators.
     */
    async deleteMessage(chatId: string, messageId: number): Promise<void> {
        if (!this.bot) return
        try {
            await this.bot.deleteMessage(chatId, messageId.toString())
        } catch {
            // Silently ignore — message might already be gone
        }
    }

    async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
        if (!this.bot) {
            throw new Error('Telegram not connected')
        }
        await this.bot.sendDocument(chatId, filePath, { caption })
        console.log(`[Nova Telegram] Sent document to ${chatId}: ${filePath}`)
    }

    async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
        if (!this.bot) {
            throw new Error('Telegram not connected')
        }
        await this.bot.sendPhoto(chatId, filePath, { caption })
        console.log(`[Nova Telegram] Sent photo to ${chatId}: ${filePath}`)
    }

    // ============================================
    // Emoji Reactions — Nova reacts to user messages!
    // ============================================

    /**
     * Send an emoji reaction to a message.
     * Uses Telegram Bot API setMessageReaction.
     * Supported emojis: 👍👎❤️🔥🎉😂😢🤔👀✅
     */
    async setReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
        if (!this.bot) return
        try {
            await this.bot.setMessageReaction(chatId, messageId, {
                reaction: [{ type: 'emoji', emoji }],
            })
            console.log(`[Nova Telegram] 💬 Reacted with ${emoji} to message ${messageId}`)
        } catch (err: any) {
            // Some bots/chats don't support reactions — silently ignore
            if (!err.message?.includes('REACTION_INVALID')) {
                console.log(`[Nova Telegram] Reaction failed: ${err.message?.slice(0, 100)}`)
            }
        }
    }

    /**
     * Auto-react to a user message based on content sentiment.
     * Called from handleMessage to make Nova feel more alive.
     */
    private async autoReactToMessage(chatId: string, messageId: number, content: string): Promise<void> {
        const lower = content.toLowerCase()

        // Detect sentiment and react appropriately
        const reactionMap: Array<{ patterns: RegExp; emoji: string; chance: number }> = [
            { patterns: /danke|thanks|thx|merci/i, emoji: '❤️', chance: 0.8 },
            { patterns: /super|toll|geil|perfekt|genial|amazing|awesome|klasse|stark/i, emoji: '🔥', chance: 0.7 },
            { patterns: /lol|haha|😂|🤣|witzig|lustig|funny/i, emoji: '😂', chance: 0.6 },
            { patterns: /gut gemacht|well done|nice|bravo|top/i, emoji: '👍', chance: 0.7 },
            { patterns: /wow|krass|omg|wahnsinn|unglaublich/i, emoji: '😮', chance: 0.5 },
            { patterns: /🎉|feier|party|geschafft|fertig/i, emoji: '🎉', chance: 0.6 },
            { patterns: /❤️|💕|🥰|lieb|love/i, emoji: '❤️', chance: 0.9 },
        ]

        for (const { patterns, emoji, chance } of reactionMap) {
            if (patterns.test(lower) && Math.random() < chance) {
                // Small delay to feel natural
                setTimeout(() => this.setReaction(chatId, messageId, emoji), 500 + Math.random() * 1500)
                break  // Only one reaction per message
            }
        }
    }

    /**
     * Handle reactions from users (when they react to Nova's messages).
     * Telegram sends message_reaction events with new/old reactions.
     */
    private async handleReaction(reaction: any): Promise<void> {
        try {
            const chatId = reaction.chat?.id?.toString()
            const userId = reaction.user?.id?.toString()
            const messageId = reaction.message_id
            const newReactions = reaction.new_reaction || []
            const oldReactions = reaction.old_reaction || []

            if (!chatId || newReactions.length === 0) return

            const emojis = newReactions.map((r: any) => r.emoji).filter(Boolean)
            if (emojis.length === 0) return

            console.log(`[Nova Telegram] 💬 User ${userId} reacted: ${emojis.join(' ')} on message ${messageId}`)

            // Track reaction as feedback
            const isPositive = emojis.some((e: string) => ['👍', '❤️', '🔥', '🎉', '😍', '🥰', '💯', '✅'].includes(e))
            const isNegative = emojis.some((e: string) => ['👎', '😢', '💩', '🤮', '❌'].includes(e))

            try {
                const { recordFeedback } = await import('../training/feedback-learner.js')
                recordFeedback(
                    'reaction',
                    `Reaction ${emojis.join(' ')
                    } on message ${messageId} `,
                    isPositive ? 'positive' : 'negative'
                )
            } catch { /* feedback module not available */ }

            // Nova reacts back to positive reactions! 🥰
            if (isPositive && Math.random() < 0.5) {
                const thankReactions = ['❤️', '🥰', '✨', '💪']
                const randomReaction = thankReactions[Math.floor(Math.random() * thankReactions.length)]
                // Find the latest message from Nova to react to (or react to same message)
                setTimeout(() => {
                    this.setReaction(chatId, messageId, randomReaction)
                }, 1000 + Math.random() * 2000)
            }
        } catch (err) {
            console.log(`[Nova Telegram] Reaction handler error: ${err} `)
        }
    }

    private sanitizeForTelegram(text: string): string {
        let clean = sanitizeInternalOutboundArtifacts(text)

        // Defense in depth: provider/PTY escape sequences must never become
        // visible Telegram text, even if a caller bypasses L0 supervision.
        clean = clean
            .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
            .replace(/(?:\[?e~\[?)+\s*$/gi, '')

        // Remove tool call blocks - comprehensive patterns
        // Pattern: TOOL:name({...}) or TOOL:name({"key":"value"})
        clean = clean.replace(/TOOL:\w+\(\{[\s\S]*?\}\)/g, '')
        clean = clean.replace(/TOOL:\w+\([^)]*\)/g, '')

        // Pattern: [TOOL:name({...})]
        clean = clean.replace(/\[TOOL:\w+\(\{[\s\S]*?\}\)\]/g, '')
        clean = clean.replace(/\[TOOL:\w+\([^)]*\)\]/g, '')

        // Remove provider reasoning blocks. Some Qwen-compatible servers emit
        // <think> while older adapters used <thinking>; neither is user text.
        clean = clean
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<(?:think|thinking)>[\s\S]*$/gi, '')
            .replace(/^[\s\S]*?<\/think>\s*/i, '')

        // Remove code execution artifacts
        clean = clean.replace(/\[Tool:.*?\]/gi, '')
        clean = clean.replace(/\[Executing:.*?\]/gi, '')

        // Fix unbalanced markdown that breaks Telegram
        const backtickCount = (clean.match(/`/g) || []).length
        if (backtickCount % 2 !== 0) {
            clean = clean.replace(/`/g, "'")
        }


        // Remove excessive whitespace
        clean = clean.replace(/\n{3,}/g, '\n\n')

        return clean.trim()
    }

    // ============================================
    // Event Handling
    // ============================================

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }

    // ============================================
    // Status
    // ============================================

    getUsername(): string | undefined {
        return this.botUsername
    }

    // ============================================
    // Proactive Messaging (for idle learning)
    // ============================================

    /**
     * Send a proactive message to the last active chat
     * Used by L15 Self-Check to ask user about learning topics
     */
    async sendProactive(message: string): Promise<void> {
        if (!this.bot || !this.lastActiveChat) {
            console.log('[Nova Telegram] Cannot send proactive: no bot or no active chat')
            return
        }

        try {
            // Telegram limit: 4096 chars per message — split if longer
            const MAX_LEN = 4000
            if (message.length <= MAX_LEN) {
                await this.bot.sendMessage(this.lastActiveChat, message, {
                    parse_mode: 'Markdown',
                })
            } else {
                // Split at line breaks, respecting max length
                const lines = message.split('\n')
                let chunk = ''
                for (const line of lines) {
                    if ((chunk + '\n' + line).length > MAX_LEN && chunk.length > 0) {
                        await this.bot.sendMessage(this.lastActiveChat, chunk, {
                            parse_mode: 'Markdown',
                        })
                        chunk = line
                    } else {
                        chunk += (chunk ? '\n' : '') + line
                    }
                }
                if (chunk) {
                    await this.bot.sendMessage(this.lastActiveChat, chunk, {
                        parse_mode: 'Markdown',
                    })
                }
            }
            console.log(`[Nova Telegram] Sent proactive message to ${this.lastActiveChat} (${message.length} chars)`)
        } catch (err: any) {
            console.log(`[Nova Telegram] Proactive send failed: ${err.message}`)
            // Fallback: try without markdown
            try {
                await this.bot.sendMessage(this.lastActiveChat, message.replace(/[*_`\[\]]/g, ''))
            } catch { /* give up */ }
        }
    }

    getLastActiveChat(): string | undefined {
        return this.lastActiveChat
    }
}

// ============================================
// Factory
// ============================================

// Singleton reference for L15 idle learning to access
let telegramInstance: TelegramAdapter | null = null

export function createTelegramAdapter(config: TelegramConfig): TelegramAdapter {
    const adapter = new TelegramAdapter(config)
    telegramInstance = adapter  // Store reference for L15
    return adapter
}

/**
 * Get the active Telegram adapter instance
 * Used by L15 Self-Check for proactive messaging
 */
export function getTelegramAdapter(): TelegramAdapter | null {
    return telegramInstance
}

/**
 * Connect L15 notify callback to Telegram proactive messaging
 * Call this after Telegram adapter is created
 */
export async function connectL15NotifyCallback(): Promise<void> {
    if (!telegramInstance) {
        console.log('[Nova Telegram] Cannot connect L15: no adapter yet')
        return
    }

    try {
        const { getSelfCheckManager } = await import('../layers/L15-self-check.js')
        const selfCheck = getSelfCheckManager()

        // Register callback to send proactive messages via Telegram
        selfCheck.setNotifyCallback(async (message: string) => {
            if (telegramInstance) {
                const userId = telegramInstance.getLastActiveChat()
                if (!userId) return
                const { getProactiveMessenger } = await import('../core/proactive.js')
                const { assessmentFromEvent } = await import('../core/proactive-policy.js')
                await getProactiveMessenger().send({
                    userId, channel: 'telegram', content: message,
                    priority: 'normal', type: 'notification',
                    assessment: assessmentFromEvent({
                        source: 'L15-self-check', summary: message.slice(0, 500),
                        severity: 'warning', confidence: 0.9,
                        dedupeKey: `l15:${message.slice(0, 160)}`,
                    }),
                })
            }
        })

        console.log('[Nova Telegram] ✓ L15 notify callback connected')
    } catch (err) {
        console.log(`[Nova Telegram] L15 connection failed: ${err}`)
    }
}

export default { TelegramAdapter, createTelegramAdapter, getTelegramAdapter, connectL15NotifyCallback }
