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
import type { PrincipalContext } from '../users/principal-id.js'
import { claimTelegramPairing, isTelegramPairingMessage } from '../onboarding/telegram-pairing.js'

// ============================================
// Types
// ============================================

export interface TelegramConfig {
    token: string
    /**
     * DM allowlist. Numeric entries match the immutable Telegram user id.
     * Entries starting with `@` match the (mutable, re-assignable) username and
     * log a warning. Bare non-numeric entries match nothing (since 29.09.2026;
     * previously they matched the username).
     */
    allowFrom?: string[]
    groupPolicy?: 'allow' | 'mention-only' | 'deny'
    username?: string
    /** Runtime-owned Main + Telegram lease verifier. Never inferred from the bot token. */
    verifyAuthority?: () => Promise<boolean>
    /**
     * Durable inbound log. Called synchronously from the update listener,
     * i.e. before the library acknowledges the update with the next poll
     * offset and before any (network) authority check. When set, a persisted
     * text/photo update is always handed to the message handler, which owns
     * the authority decision (defer instead of drop).
     */
    persistInbound?: (message: { id: string; chatId: string; from: string; content: string }) => void
}

/** Allowlist entry matching: numeric ids only; `@name` explicitly opts into username matching. */
export function telegramAllowlistMatches(entry: string, userId: string, username: string): boolean {
    const value = String(entry ?? '').trim()
    if (!value) return false
    if (value.startsWith('@')) {
        return Boolean(username) && value.slice(1).toLowerCase() === username.toLowerCase()
    }
    return /^-?\d+$/.test(value) && value === userId
}

function warnAboutAllowlist(entries: string[]): void {
    const usernames = entries.filter(entry => String(entry).trim().startsWith('@'))
    const ignored = entries.filter(entry => {
        const value = String(entry).trim()
        return value && !value.startsWith('@') && !/^-?\d+$/.test(value)
    })
    if (usernames.length) {
        console.warn(`[Nova Telegram] ⚠ allowFrom enthält Username-Einträge (${usernames.join(', ')}): Usernames sind änderbar und können neu vergeben werden — besser numerische User-IDs verwenden.`)
    }
    if (ignored.length) {
        console.warn(`[Nova Telegram] ⚠ allowFrom-Einträge ohne numerische ID werden ignoriert: ${ignored.join(', ')} (Username bewusst mit "@" kennzeichnen)`)
    }
}

const UPDATE_ID_PROPERTY = '__novaUpdateId'
const PERSISTED_PROPERTY = '__novaPersisted'

/** Copy the raw update_id onto the message object (non-enumerable) so the
 * 'message' listeners can build a globally unique dedup key. */
export function stampTelegramUpdate(update: any): void {
    const message = update?.message
    if (!message || typeof message !== 'object' || !Number.isSafeInteger(update.update_id)) return
    Object.defineProperty(message, UPDATE_ID_PROPERTY, { value: update.update_id, enumerable: false, configurable: true })
}

/** Globally unique inbound key: Telegram update_id when known, otherwise
 * chat-scoped message_id (message_id alone is only unique per chat). */
export function telegramInboundKey(msg: any, updateId: unknown = msg?.[UPDATE_ID_PROPERTY]): string {
    if (Number.isSafeInteger(updateId)) return `tg-update:${updateId}`
    return `tg:${msg?.chat?.id ?? 'unknown'}:${msg?.message_id ?? 'unknown'}`
}

// ============================================
// Telegram Adapter Class
// ============================================

/**
 * P9 „ein Knopf-Rahmen“: approvals run only through Knopf-Karten (`ac:`). The
 * pre-P9 callback buttons that acted on their own — PATCH_GATE `patch_ok/no`,
 * Skill-Forge `skill_ok/no` and the model install `ni:` — are refused: they run
 * nothing and point to a fresh card.
 */
const RETIRED_APPROVAL_CALLBACK = /^(?:patch_ok|patch_no|skill_ok|skill_no|ni):/
export function retiredApprovalHint(data: unknown): string | null {
    if (typeof data !== 'string' || !RETIRED_APPROVAL_CALLBACK.test(data)) return null
    if (data.startsWith('patch_')) return '⌛ Veralteter Knopf — nichts ausgeführt. Bitte neue Karte: /patch approve <id>.'
    if (data.startsWith('skill_')) return '⌛ Veralteter Knopf — nichts ausgeführt. Bitte neue Karte (Skill-Forge schickt sie).'
    return '⌛ Veralteter Knopf — nichts installiert. Modelle zieht eine neue Karte (Modellsteuerung).'
}

export class TelegramAdapter implements ChannelAdapter {
    type = 'telegram'
    private bot: any = null
    private config: TelegramConfig
    private messageHandler?: (msg: IncomingMessage) => void
    private botUsername?: string
    private lastActiveChat?: string  // Track last chat for proactive messages
    private typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
    private typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
    private conflictRetryTimer?: ReturnType<typeof setTimeout>
    private disconnecting = false
    /** 2.86 Paket O: Antworttexte je Chat, solange eine Sprachnachricht bearbeitet wird (für die Sprachantwort). */
    private voiceCapture = new Map<string, string[]>()
    // Per-chat message queue to prevent concurrent LLM API calls (prevents 403 rate-limiting)
    private messageQueue = new Map<string, Promise<void>>()
    /** 2.89.4: newest user message_id per chat (updated when the update arrives, not when it is processed). */
    private latestUserMessageId = new Map<string, number>()
    /** 2.89.4: message_id currently being answered — the reply anchor when the chat has already moved on. */
    private answeringMessageId = new Map<string, number>()

    constructor(config: TelegramConfig) {
        this.config = {
            allowFrom: [],
            groupPolicy: 'mention-only',
            ...config,
        }
        warnAboutAllowlist(this.config.allowFrom || [])
    }

    private async hasLiveAuthority(): Promise<boolean> {
        try {
            if (this.config.verifyAuthority) return await this.config.verifyAuthority()
            const { MAIN_SERVICE, verifyLiveServiceLeadership } = await import('../mesh/leader-election.js')
            return await verifyLiveServiceLeadership(MAIN_SERVICE)
                && await verifyLiveServiceLeadership('telegram')
        } catch {
            return false
        }
    }

    private async requireLiveAuthority(action: string): Promise<void> {
        if (this.disconnecting || !(await this.hasLiveAuthority())) {
            throw new Error(`Telegram ${action} fenced: live Main/Telegram authority is absent`)
        }
    }

    private async acceptInbound(): Promise<boolean> {
        if (!this.disconnecting && await this.hasLiveAuthority()) return true
        console.warn('[Nova Telegram] Eingang verworfen: live Main-/Telegram-Autorität fehlt')
        return false
    }

    /**
     * Guard the Bot API effect boundary itself. Several legacy command handlers
     * still call the SDK directly, so guarding only public adapter methods would
     * leave a stale node able to emit a late reply after lease loss.
     */
    private guardBotEffects(bot: any): any {
        // CL-07: defensively include every effect method of the SDK, also the
        // ones no handler uses today, so a future call cannot bypass the fence.
        const effectMethods = [
            'answerCallbackQuery', 'deleteMessage', 'deleteMyCommands', 'deleteWebHook',
            'editMessageReplyMarkup', 'editMessageText', 'sendChatAction', 'sendDocument',
            'sendMessage', 'sendPhoto', 'setMessageReaction', 'setMyCommands', 'startPolling',
            'sendVoice', 'sendAudio', 'sendVideo', 'sendVideoNote', 'sendAnimation', 'sendSticker',
            'sendMediaGroup', 'sendLocation', 'sendVenue', 'sendContact', 'sendPoll', 'sendDice',
            'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages',
            'pinChatMessage', 'unpinChatMessage', 'unpinAllChatMessages',
            'editMessageCaption', 'editMessageMedia', 'editMessageLiveLocation', 'stopMessageLiveLocation',
            'stopPoll', 'setWebHook', 'answerInlineQuery', 'setChatTitle', 'setChatDescription',
        ]
        for (const method of effectMethods) {
            if (typeof bot?.[method] !== 'function') continue
            const effect = bot[method].bind(bot)
            bot[method] = async (...args: any[]) => {
                await this.requireLiveAuthority(`Bot API ${method}`)
                return effect(...args)
            }
        }
        return bot
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
        await this.requireLiveAuthority('connect')

        // Dynamic import
        const TelegramBot = (await import('node-telegram-bot-api')).default

        // Step 1: Start WITHOUT polling to clear webhook first
        this.bot = this.guardBotEffects(new TelegramBot(this.config.token, { polling: false }))
        const processUpdate = typeof this.bot.processUpdate === 'function' ? this.bot.processUpdate.bind(this.bot) : undefined
        if (processUpdate) {
            this.bot.processUpdate = (update: any) => {
                stampTelegramUpdate(update)
                return processUpdate(update)
            }
        }

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
            // 2.86: generated from the one command menu next to the handlers.
            const { COMMAND_MENU } = await import('../core/slash-commands.js')
            await this.bot.setMyCommands(COMMAND_MENU.map(({ command, description }) => ({ command, description })))
            console.log('[Nova Telegram] ✓ Slash-Commands registriert')
        } catch (err) {
            console.log(`[Nova Telegram] ⚠ setMyCommands failed: ${err}`)
        }

        // Handle incoming messages (queued per chat to prevent API rate-limiting)
        this.bot.on('message', (msg: any) => this.onRawMessage(msg))

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
        if (!(await this.acceptInbound())) return
        const chatId = msg.chat.id.toString()
        const userId = msg.from?.id?.toString() ?? ''
        const isOwner = this.getOwnerChatIds().includes(userId)
        const { join } = await import('node:path')
        const { mkdirSync, writeFileSync, unlinkSync } = await import('node:fs')
        const dir = join(process.cwd(), '.nova-voice')
        const tempPath = join(dir, `voice_${Date.now()}.ogg`)
        try {
            const fileInfo = await this.bot.getFile(msg.voice.file_id)
            const response = await fetch(`https://api.telegram.org/file/bot${this.config.token}/${fileInfo.file_path}`)
            const audio = Buffer.from(await response.arrayBuffer())
            mkdirSync(dir, { recursive: true })
            writeFileSync(tempPath, audio, { mode: 0o600 })

            // 2.86 Paket O: zuerst der Sprachdienst im eigenen Mesh, sonst lokales Whisper; nie die Cloud.
            // No capability resolution here: installs go through the Werkzeugkasten card only.
            const voice = await import('./telegram-voice.js')
            const heard = await voice.transcribeVoiceNote(audio, String(msg.voice.mime_type || 'audio/ogg'), tempPath, Number(msg.voice.duration) || undefined)
            // 2.86.1: too long and not splittable → an honest sentence, not „cannot listen“.
            if (heard?.zuLang) {
                await this.bot.sendMessage(chatId, voice.voiceTooLongNotice())
                return
            }
            if (!heard) {
                // 2.89.4: erst live prüfen, ob ein Sprachdienst antwortet — die
                // Install-Karte kommt nur, wenn keiner da ist.
                let probed: { anyStt?: boolean; anyTts?: boolean } | undefined
                try {
                    const { probeSpeechServices } = await import('../voice/openai-audio.js')
                    probed = await probeSpeechServices()
                } catch { /* optional */ }
                // 2.85: an owner voice message without speech recognition is a recorded need
                // for the Software-Scout (capability + time only, no content, no user id).
                if (isOwner && !probed?.anyStt) {
                    try { (await import('../install/software-demand.js')).recordCapabilityNeed('stt', 'sprachnachricht-ohne-stt') } catch { /* optional */ }
                }
                const notice = voice.voiceUnavailableNotice(probed)
                await this.bot.sendMessage(chatId, notice.text, isOwner && notice.keyboard.length ? { reply_markup: { inline_keyboard: notice.keyboard } } : {})
                return
            }
            console.log(`[Nova Telegram] Sprachnachricht verstanden (${heard.via})`)
            const incoming: IncomingMessage = {
                id: telegramInboundKey(msg),
                channel: 'telegram',
                from: userId,
                to: chatId,
                content: heard.text,
                timestamp: msg.date * 1000,
                isGroup: false,
            }
            if (!this.messageHandler) return
            const reply = voice.shouldReplyByVoice(heard.text, isOwner)
            const captured: string[] = []
            if (reply.speak) this.voiceCapture.set(chatId, captured)
            this.startTyping(chatId)
            try {
                await (this.messageHandler(incoming) as unknown as Promise<void>)
            } catch (err) {
                console.error(`[Nova Telegram] Voice messageHandler threw: ${err}`)
            } finally {
                this.stopTyping(chatId)
                if (this.voiceCapture.get(chatId) === captured) this.voiceCapture.delete(chatId)
            }
            const answer = captured.filter(text => text.trim()).at(-1)
            if (reply.speak && answer) {
                const ogg = await voice.speakReply(answer, reply.voice)
                if (ogg) await this.sendVoice(chatId, ogg)
            }
        } catch (err) {
            console.error(`[Nova Telegram] Voice error: ${err}`)
        } finally {
            try { unlinkSync(tempPath) } catch { /* nicht angelegt */ }
        }
    }

    /** 2.86 Paket O: Sprachnachricht (Ogg/Opus) senden. */
    async sendVoice(chatId: string, audio: Buffer): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected')
        await this.bot.sendVoice(chatId, audio, {}, { filename: 'antwort.ogg', contentType: 'audio/ogg' })
    }

    private noteVoiceAnswer(chatId: unknown, text: unknown): void {
        const captured = this.voiceCapture.get(String(chatId))
        if (captured && typeof text === 'string') captured.push(text)
    }



    private async handleDocumentMessage(msg: any): Promise<void> {
        if (!(await this.acceptInbound())) return
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
                id: telegramInboundKey(msg),
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

    /**
     * INT-1: an inline button press is a request by `query.from`, not by the
     * chat. Resolve the same principal/role a normal text message from that
     * user would get (DM allowlist, multi-user checkAuth, userPrincipals) so
     * the central slash role gate sees the real role. Returns null when the
     * sender would not be admitted as a message sender either.
     */
    private async resolveCallbackPrincipal(query: any): Promise<PrincipalContext | null> {
        const userId = query?.from?.id?.toString() ?? ''
        if (!/^-?\d+$/.test(userId)) return null
        const chatType = query?.message?.chat?.type
        const isGroup = chatType === 'group' || chatType === 'supergroup'
        if (!isGroup && this.config.allowFrom?.length
            && !this.config.allowFrom.some(entry => telegramAllowlistMatches(entry, userId, query.from?.username ?? ''))) {
            return null
        }
        try {
            const mu = await import('../users/multi-user-middleware.js')
            mu.initMultiUser()
            const config = (globalThis as any).__novaState?.config
            const alias = config?.userAliases?.[userId] || userId
            const auth = mu.checkAuth(userId, 'telegram', alias)
            if (!auth.allowed) return null
            const { resolvePrincipalId } = await import('../users/principal-id.js')
            return {
                channel: 'telegram',
                rawUserId: userId,
                principalId: resolvePrincipalId(config, 'telegram', userId),
                permission: auth.permission,
            }
        } catch (error) {
            // Fail closed: without a positive auth decision the button acts as nobody.
            console.warn(`[Nova Telegram] Callback principal unresolved: ${String(error).slice(0, 120)}`)
            return null
        }
    }

    /**
     * 2.89.4: a command that already answered via buttons returns the silent
     * marker. Forwarding it as chat text showed the line „HANDLED“ (`/ai`,
     * Markdown ate the underscores). Only real text is ever sent.
     */
    private async sendCommandReply(chatId: string | undefined, response: string | null | undefined): Promise<void> {
        const { commandReplyText } = await import('../core/slash-commands.js')
        const text = commandReplyText(response)
        if (text) await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
    }

    private async handleFeedback(query: any): Promise<void> {
        if (!(await this.acceptInbound())) return
        const data = query.data
        if (typeof data === 'string' && data.startsWith('ac:')) {
            await this.handleApprovalCardPress(query)
            return
        }
        if (typeof data === 'string' && data.startsWith('dk:')) {
            await this.handleDesktopPress(query)
            return
        }
        if (typeof data === 'string' && data.startsWith('nv:')) {
            await this.handleNavPress(query)
            return
        }
        if (data === 'vo:install') {
            // 2.86 Paket O: „Sprachdienst einrichten“ → Werkzeugkasten-Karte (nur Owner, privater Chat).
            const userId = query.from?.id?.toString() ?? ''
            const isOwner = this.getOwnerChatIds().includes(userId) && String(query.message?.chat?.id ?? '') === userId
            const { pressVoiceInstall } = await import('./telegram-voice.js')
            const text = await pressVoiceInstall(isOwner)
            try { await this.bot.answerCallbackQuery(query.id, { text: text.slice(0, 190) }) } catch { /* ignore */ }
            return
        }
        if (typeof data === 'string' && data.startsWith('gf:')) {
            await this.handleGuidedPress(query)
            return
        }
        if (typeof data === 'string' && data.startsWith('ak:')) {
            // 2.88: „Was ich gerade tue“ — Stopp/Später (owner, private chat, single-use token).
            const userId = String(query.from?.id ?? '')
            const chatId = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
            let text = '❌ Gerade nicht möglich.'
            try {
                await this.requireLiveAuthority('activity control')
                const { drueckeAktivitaet } = await import('../sehen/telegram-sehen.js')
                const result = await drueckeAktivitaet(data, { userId, ownerIds: this.getOwnerChatIds(), chatId, privateChat: query.message?.chat?.type === 'private' })
                text = result.ok ? `✓ ${result.message}` : result.message
            } catch { /* answer below */ }
            try { await this.bot.answerCallbackQuery(query.id, { text: text.slice(0, 190), show_alert: text.length > 120 }) } catch { /* ignore */ }
            return
        }
        const chatId = query.message?.chat?.id?.toString()
        const userId = query.from?.id?.toString() ?? ''
        const retired = retiredApprovalHint(data)
        if (retired) {
            try { await this.bot.answerCallbackQuery(query.id, { text: retired, show_alert: true }) } catch { /* ignore */ }
            try { await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message?.chat?.id, message_id: query.message?.message_id }) } catch { /* message may be too old */ }
            return
        }
        const needsPrincipal = typeof data === 'string'
            && (/^(?:cmd_|persona_|learn_|llm_|sw_|switch_|mcfg_)/.test(data) || data === 'memory_clear')
        const principal = needsPrincipal ? await this.resolveCallbackPrincipal(query) : null
        if (needsPrincipal && !principal) {
            try { await this.bot.answerCallbackQuery(query.id, { text: '🔒 Zugriff verweigert.' }) } catch { /* ignore */ }
            return
        }
        const buttonDenial = async (command: string): Promise<boolean> => {
            const { getCommandMinimumRole } = await import('../core/slash-commands.js')
            const rank: Record<string, number> = { blocked: -1, guest: 0, user: 1, admin: 2, owner: 3 }
            const required = getCommandMinimumRole(command)
            if ((rank[principal?.permission || 'guest'] ?? -1) >= rank[required]) return false
            try { await this.bot.answerCallbackQuery(query.id, { text: `🔒 Nur für Rolle ${required}.` }) } catch { /* ignore */ }
            return true
        }

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
                        ? `🔐 *OpenAI Codex (OAuth)*\n\n✅ Verbunden für diesen Xaventra-User\n📍 Modell: \`${codex.model}\`\n🖥️ Node: \`${codex.nodeId}\`\n⚡ Wird automatisch bevorzugt\n\nBei einem Fehler fällt Nova auf das lokale vLLM zurück.`
                        : `🔐 *OpenAI Codex (OAuth)*\n\n⚪ Nicht für diesen Xaventra-User verbunden.\nAnmeldung: /codex login`
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
            if (await buttonDenial('model')) return
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
                    await this.bot.answerCallbackQuery(query.id, { text: '❌ Xaventra nicht initialisiert' })
                    return
                }

                const { handleCommand } = await import('../core/slash-commands.js')
                const { availableLLMs } = await import('../core/llm-factory.js')

                // Special routing for some commands
                if (cmd === 'mission_config' && await buttonDenial('mission')) return
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
                    // Full text help (no buttons), from the one command menu (2.86)
                    const { formatCommandMenu } = await import('../core/slash-commands.js')
                    const helpText = formatCommandMenu()
                    await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' })
                    await this.bot.answerCallbackQuery(query.id)
                    return
                }

                // Route to handleCommand — chatId is used as 'from' for button responses
                const response = await handleCommand(cmd, '', chatId!, state, availableLLMs, principal!)
                // 2.89.4: COMMAND_HANDLED is silent — never send it as chat text (`/ai` showed „HANDLED“)
                await this.sendCommandReply(chatId, response)
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
                    const response = await handleCommand('persona', presets[preset] || preset, chatId!, state, availableLLMs, principal!)
                    await this.sendCommandReply(chatId, response)
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
                    const response = await handleCommand('learn', skill, chatId!, state, availableLLMs, principal!)
                    await this.sendCommandReply(chatId, response)
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
                    const response = await handleCommand('llm', action, chatId!, state, availableLLMs, principal!)
                    await this.sendCommandReply(chatId, response)
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
                        // Wiping memory is destructive: a user may clear their own private
                        // chat; any other chat (groups) needs the owner-level role gate.
                        const ownPrivateChat = query.message?.chat?.type === 'private' && String(query.from?.id) === chatId
                        const rank: Record<string, number> = { blocked: -1, guest: 0, user: 1, admin: 2, owner: 3 }
                        if (ownPrivateChat ? (rank[principal?.permission || 'guest'] ?? -1) < rank.user : await buttonDenial('memory_clear')) {
                            if (ownPrivateChat) try { await this.bot.answerCallbackQuery(query.id, { text: '🔒 Nur für Rolle user.' }) } catch { /* ignore */ }
                            return
                        }
                        // Memory governance forgets record by record (with tombstone);
                        // there is no bulk wipe behind a button.
                        await this.bot.sendMessage(chatId, '🗑️ Einzelne Erinnerungen vergessen: /memory review, dann /memory reject <id>.')
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

        // Auftrags-Konfiguration (from /auftrag config)
        if (data?.startsWith('mcfg_')) {
            if (await buttonDenial('mission')) return
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
        await this.requireLiveAuthority('model selector')

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

    /** Numeric allowFrom entries = configured owners (private chat id == user id). Usernames never count. */
    getOwnerChatIds(): string[] {
        return (this.config.allowFrom || []).map(entry => String(entry).trim()).filter(entry => /^\d{1,20}$/.test(entry))
    }

    /** Live Main + Telegram authority for proactive card delivery. */
    async hasCardAuthority(): Promise<boolean> {
        return Boolean(this.bot) && !this.disconnecting && await this.hasLiveAuthority()
    }

    /** Knopf-Karte senden (plain text, code-id keyboard). Returns the message id. */
    async sendApprovalCard(chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<number | null> {
        if (!this.bot) return null
        await this.requireLiveAuthority('approval card')
        const sent = await this.bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } })
        return typeof sent?.message_id === 'number' ? sent.message_id : null
    }

    /** Phase 5a: a card answered on another channel (Even G2) — update every Telegram copy, no buttons left. */
    async syncApprovalCardMessages(card: { messages?: Array<{ chatId: string; messageId: number }> }, text: string): Promise<void> {
        if (!this.bot) return
        for (const target of (card.messages || []).slice(0, 5)) {
            try {
                await this.bot.editMessageText(text, { chat_id: target.chatId, message_id: target.messageId, reply_markup: { inline_keyboard: [] } })
            } catch { /* message may be too old; the decision is stored anyway */ }
        }
    }

    /** /desktop: picker as plain text (labels can never break Markdown). */
    async sendDesktopPicker(chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
        if (!this.bot) return
        await this.requireLiveAuthority('desktop picker')
        await this.bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } })
    }

    /**
     * /desktop button: same owner rule and single-use tokens as the Knopf-Karten.
     * The one-time link goes only into the owner's private chat, without link
     * preview (a preview fetch must never touch the link). It is not logged
     * and not passed through the message pipeline or memory.
     */
    private async handleDesktopPress(query: any): Promise<void> {
        const answer = async (text: string) => {
            try { await this.bot.answerCallbackQuery(query.id, { text: String(text).slice(0, 190) }) } catch { /* ignore */ }
        }
        try {
            const userId = String(query.from?.id ?? '')
            const chatId = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
            if (query.message?.chat?.type !== 'private' || chatId !== userId) {
                await answer('🔒 Desktop-Links gibt es nur im Privatchat mit dem Owner.')
                return
            }
            const { pressDesktopButton, formatLinkMessage } = await import('../desktop-direct/runtime.js')
            const result = pressDesktopButton(String(query.data), { userId, ownerIds: this.getOwnerChatIds() })
            await answer(result.ok ? `✓ ${result.message}` : result.message)
            if (!result.ok) return
            if (typeof query.message?.message_id === 'number') {
                try { await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }) } catch { /* cosmetic */ }
            }
            if (result.code === 'link' && result.link) {
                await this.requireLiveAuthority('desktop link')
                await this.bot.sendMessage(chatId, formatLinkMessage(result.link), {
                    disable_web_page_preview: true,
                    link_preview_options: { is_disabled: true },
                    ...(result.link.releaseKeyboard ? { reply_markup: { inline_keyboard: result.link.releaseKeyboard } } : {}),
                })
            }
        } catch (error) {
            console.warn(`[Nova Telegram] Desktop-Knopf: ${String((error as Error)?.message || error).slice(0, 120)}`)
            await answer('❌ Fehler — kein Link erstellt.')
        }
    }

    /** CL-10: a press on a Knopf-Karte. The callback carries only a code id; the card store decides. */
    private async handleApprovalCardPress(query: any): Promise<void> {
        const answer = async (text: string) => {
            try { await this.bot.answerCallbackQuery(query.id, { text: String(text).slice(0, 190) }) } catch { /* ignore */ }
        }
        try {
            const { answerApprovalCard } = await import('../core/approval-cards.js')
            const { ensureBuiltinCardExecutors } = await import('../core/approval-card-sources.js')
            await ensureBuiltinCardExecutors()
            const result = await answerApprovalCard(String(query.data), { userId: String(query.from?.id ?? ''), ownerIds: this.getOwnerChatIds() })
            await answer(result.ok ? `✓ ${result.message}` : result.message)
            // 2.86 Paket N: a login address comes as ONE URL button, never as (paged/filtered) text.
            const linkChat = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
            if (result.link && linkChat) await this.sendLinkButton(linkChat, result.card?.result?.message || '', result.link)
            if (!result.card || result.code === 'kein-owner' || result.code === 'nicht-erlaubt') return
            if (result.code === 'verbraucht' || result.code === 'unbekannt') return
            if (result.card.buendel) {
                // Paket L: a bundled question — the bundle message is edited (the other devices keep
                // their buttons); the result comes as one short message (e.g. the HA login address).
                const pressedChat = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
                const { ownerText } = await import('../core/owner-text.js')
                if (pressedChat && result.card.result?.message && !result.link) {
                    await this.requireLiveAuthority('card result')
                    await this.bot.sendMessage(pressedChat, `${result.card.result.ok ? '✅' : '⚠️'} ${ownerText(result.card.result.message)}`.slice(0, 900), { disable_web_page_preview: true })
                }
                const { deliverBundles } = await import('../core/card-bundle.js')
                await deliverBundles({ canSend: () => this.hasCardAuthority(), ownerChatIds: () => this.getOwnerChatIds(),
                    send: (chatId, text, keyboard) => this.sendApprovalCard(chatId, text, keyboard), edit: (chatId, messageId, text, keyboard) => this.editOwnerView(chatId, messageId, text, keyboard) })
                // 2.86 Paket M: one question at a time — a closed bundle frees the slot for the next one.
                this.nextQuestionSoon()
                return
            }
            const targets = [...(result.card.messages || [])]
            const pressedChat = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
            const pressedId = query.message?.message_id
            if (pressedChat && typeof pressedId === 'number' && !targets.some(item => item.chatId === pressedChat && item.messageId === pressedId)) {
                targets.push({ chatId: pressedChat, messageId: pressedId })
            }
            const { formatCardTextShort } = await import('../core/approval-cards.js')
            const text = formatCardTextShort(result.card)
            for (const target of targets) {
                try {
                    await this.bot.editMessageText(text, { chat_id: target.chatId, message_id: target.messageId, reply_markup: { inline_keyboard: [] } })
                } catch { /* message may be too old; the decision is stored anyway */ }
            }
            // 2.86 Paket M: one question at a time — the answer frees the slot for the next one.
            this.nextQuestionSoon()
        } catch (error) {
            console.warn(`[Nova Telegram] Knopf-Karte: ${String((error as Error)?.message || error).slice(0, 200)}`)
            await answer('❌ Fehler — nichts ausgeführt.')
        }
    }

    /** 2.86 Paket N: one sentence + one URL button. Fallback: the plain address in its own message (never cut, never Markdown). */
    private async sendLinkButton(chatId: string, sentence: string, link: { label: string; url: string }): Promise<void> {
        const { ownerText } = await import('../core/owner-text.js')
        const text = ownerText(sentence).replace(/https?:\/\/\S+/g, '').trim().slice(0, 500) || link.label
        await this.requireLiveAuthority('card link')
        try {
            await this.bot.sendMessage(chatId, text, { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: link.label, url: link.url }]] } } as any)
        } catch {
            await this.bot.sendMessage(chatId, text, { disable_web_page_preview: true })
            await this.bot.sendMessage(chatId, link.url, { disable_web_page_preview: true })
        }
    }

    /** Paket L: edit an owner view in place (plain text, never Markdown — ids or evidence can't break it). */
    async editOwnerView(chatId: string, messageId: number, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
        if (!this.bot) return
        await this.requireLiveAuthority('owner view')
        try {
            await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true })
        } catch (error) {
            if (!/message is not modified/i.test(String((error as Error)?.message || error))) throw error
        }
    }

    /** Paket L: open-question count for the main menu (cards + bundled device questions). */
    private async openQuestionCount(): Promise<number> {
        try { const { listApprovalCards } = await import('../core/approval-cards.js'); return listApprovalCards({ status: 'offen' }).length } catch { return 0 }
    }

    /** Paket L: the fixed main menu (Status · Braucht mich (n) · Geräte · Bericht · Mehr). */
    async sendMainMenu(chatId: string): Promise<void> {
        if (!this.bot) return
        await this.requireLiveAuthority('main menu')
        const offen = await this.openQuestionCount()
        const { menuKeyboard } = await import('./telegram-pages.js')
        // 2.86 Paket M: ONE question at a time — head „1 Frage für dich, n danach“, button „Braucht mich (1)“.
        const { fragenKopf } = await import('../guided/ampel.js')
        const fragen = Math.min(1, offen)
        // 2.86 Paket M: second row „Einrichtung“ · „Ich komm nicht weiter“ (guided/telegram-guided.ts).
        const { guidedMenuRow } = await import('../guided/telegram-guided.js')
        await this.bot.sendMessage(chatId, `${fragenKopf({ offen })}\nWas möchtest du sehen?`, { reply_markup: { inline_keyboard: [...menuKeyboard(chatId, { fragen }), ...guidedMenuRow(chatId)] } })
    }

    /** 2.86 Paket M: pin the status message silently (edited later, never resent). */
    async pinOwnerMessage(chatId: string, messageId: number): Promise<void> {
        if (!this.bot) return
        await this.requireLiveAuthority('pin status')
        await this.bot.pinChatMessage(chatId, messageId, { disable_notification: true })
    }

    /**
     * 2.86 Paket M: a guided button (`gf:`) — owner only, bound to its chat.
     * It sends a fixed sentence as a normal request, opens an existing
     * question or shows a read-only view; it never switches anything itself.
     */
    private async handleGuidedPress(query: any): Promise<void> {
        const answer = async (text = '') => { try { await this.bot.answerCallbackQuery(query.id, text ? { text: String(text).slice(0, 190) } : undefined) } catch { /* ignore */ } }
        try {
            const chatId = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
            const userId = String(query.from?.id ?? '')
            const { pressGuided } = await import('../guided/telegram-guided.js')
            const pressed = pressGuided(String(query.data), { userId, ownerIds: this.getOwnerChatIds(), chatId })
            if (!pressed.ok || !pressed.aktion) { await answer(pressed.message); return }
            const { runGuidedAction } = await import('../guided/guided-runtime.js')
            const result = await runGuidedAction(pressed.aktion, { chatId, by: `telegram:${userId}` })
            await answer(result.hinweis)
            if (result.anfrage) this.injectOwnerRequest(chatId, userId, result.anfrage)
            if (result.ansicht) {
                const messageId = query.message?.message_id
                if (result.ansicht.ersetzen && typeof messageId === 'number') await this.editOwnerView(chatId, messageId, result.ansicht.text, result.ansicht.keyboard)
                else await this.sendApprovalCard(chatId, result.ansicht.text, result.ansicht.keyboard)
            }
            if (result.weiter) this.nextQuestionSoon()
        } catch (error) {
            console.warn(`[Nova Telegram] Geführt: ${String((error as Error)?.message || error).slice(0, 160)}`)
            await answer('❌ Gerade nicht möglich.')
        }
    }

    /** 2.86 Paket M: an example sentence / tip button runs as if the owner had typed it (normal request path). */
    private injectOwnerRequest(chatId: string, userId: string, text: string): void {
        const incoming: IncomingMessage = {
            id: `tg-gf:${chatId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            channel: 'telegram', from: userId, to: chatId, content: String(text).slice(0, 200), timestamp: Date.now(), isGroup: false,
        }
        this.enqueueMessage(chatId, async () => {
            if (!this.messageHandler) return
            this.startTyping(chatId)
            try { await (this.messageHandler(incoming) as unknown as Promise<void>) }
            catch (error) { console.error(`[Nova Telegram] messageHandler threw: ${error}`) }
            finally { this.stopTyping(chatId) }
        })
    }

    /** 2.86 Paket M: after an answer the next waiting question goes out now, not at the next minute. */
    private nextQuestionSoon(): void {
        void (async () => {
            const { deliverPendingCards } = await import('../core/approval-card-sources.js')
            const { deliverBundles } = await import('../core/card-bundle.js')
            let bundleIntoReport = false
            try { bundleIntoReport = (await import('../planner/runtime.js')).getPlannerRuntime()?.settings.briefing.enabled === true } catch { bundleIntoReport = false }
            const sender = { canSend: () => this.hasCardAuthority(), ownerChatIds: () => this.getOwnerChatIds(), send: (chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>) => this.sendApprovalCard(chatId, text, keyboard) }
            await deliverPendingCards(sender, { bundleIntoReport })
            await deliverBundles({ ...sender, edit: (chatId, messageId, text, keyboard) => this.editOwnerView(chatId, messageId, text, keyboard) })
        })().catch(() => { /* the card loop retries every minute */ })
    }

    /** Paket L: read-only menu views; registered per press with the presser's own principal. */
    private async registerMenuViews(chatId: string, principal: PrincipalContext | null): Promise<void> {
        const pages = await import('./telegram-pages.js')
        pages.registerMenuProvider('status', async () => {
            const { handleCommand, commandReplyText } = await import('../core/slash-commands.js')
            const { availableLLMs } = await import('../core/llm-factory.js')
            // Menu page wants the text. A telegram principal would send buttons and
            // return the silent marker — which this page used to strip into „HANDLED“.
            const menuPrincipal = principal ? { ...principal, channel: 'menu' } : null
            const raw = menuPrincipal ? await handleCommand('status', '', chatId, (globalThis as any).__novaState, availableLLMs, menuPrincipal) : null
            const text = commandReplyText(raw)
            return { titel: 'Status', text: String(text || 'Status gerade nicht verfügbar.').replace(/[*_`]/g, '') }
        })
        pages.registerMenuProvider('fragen', async () => {
            const { listApprovalCards } = await import('../core/approval-cards.js')
            const open = listApprovalCards({ status: 'offen' })
            const lines = open.map(card => `• ${pages.ownerText(card.kurz || card.titel)}`)
            return { titel: 'Braucht dich', fragen: open.length, text: lines.length ? `${lines.join('\n')}\n\nDie Knöpfe stehen bei der jeweiligen Frage bzw. in der Geräte-Nachricht.` : 'Gerade wartet nichts auf dich.' }
        })
        pages.registerMenuProvider('geraete', async () => {
            const { loadConsolidatedDevices, formatGeraete } = await import('../sensing/device-consolidation.js')
            const { getNovaDataDir } = await import('../core/data-root.js')
            return { titel: 'Geräte', text: formatGeraete(await loadConsolidatedDevices(getNovaDataDir())) }
        })
        pages.registerMenuProvider('bericht', async () => {
            const report = pages.lastReport()
            if (!report) return { titel: 'Bericht', text: 'Noch kein Bericht zugestellt.' }
            return { titel: report.titel, text: report.sections.map(section => `${section.titel}:\n${section.zeilen.map(line => `• ${line}`).join('\n')}`).join('\n\n') || 'Nichts Neues.' }
        })
        pages.registerMenuProvider('mehr', async () => ({ titel: 'Mehr', text: 'Alles geht über die Knöpfe. Wer lieber tippt: /geraete, /status, /gedanken, /verbindungen, /hilfe. Fragen stellst du einfach in normalen Sätzen.' }))
    }

    /** Paket L: `nv:` navigation — owner only, bound to its chat, never executes an action. */
    private async handleNavPress(query: any): Promise<void> {
        const answer = async (text = '') => { try { await this.bot.answerCallbackQuery(query.id, text ? { text: String(text).slice(0, 190) } : undefined) } catch { /* ignore */ } }
        try {
            const chatId = query.message?.chat?.id !== undefined ? String(query.message.chat.id) : ''
            const messageId = query.message?.message_id
            const pages = await import('./telegram-pages.js')
            const fragen = Math.min(1, await this.openQuestionCount())
            const result = pages.pressNav(String(query.data), { userId: String(query.from?.id ?? ''), ownerIds: this.getOwnerChatIds(), chatId }, { counts: { fragen } })
            if (!result.ok) { await answer(result.message); return }
            await answer()
            let view = result.edit
            if (result.menu) {
                await this.registerMenuViews(chatId, await this.resolveCallbackPrincipal(query))
                view = await pages.runMenu(result.menu, chatId, { counts: { fragen } })
            } else if (result.bundle) {
                const { showBundlePage } = await import('../core/card-bundle.js')
                view = await showBundlePage(result.bundle.key, chatId, result.bundle.page) || undefined
            }
            if (result.send) {
                await this.requireLiveAuthority('details')
                await this.bot.sendMessage(chatId, result.send.text, { reply_markup: { inline_keyboard: result.send.keyboard }, disable_web_page_preview: true })
                return
            }
            if (view && typeof messageId === 'number') await this.editOwnerView(chatId, messageId, view.text, view.keyboard)
        } catch (error) {
            console.warn(`[Nova Telegram] Navigation: ${String((error as Error)?.message || error).slice(0, 160)}`)
            await answer('❌ Ansicht gerade nicht verfügbar.')
        }
    }

    /**
     * Send a message with inline keyboard buttons
     * General-purpose: used by all slash commands for interactive UX
     */
    async sendWithButtons(chatId: string, text: string, buttons: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
        if (!this.bot) return
        // 2.89.4: same reply anchor as send() — a queued answer must not look shifted.
        const reply_to_message_id = this.replyAnchorFor(chatId)
        try {
            await this.bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons },
                reply_to_message_id,
            })
        } catch (err: any) {
            // Markdown failed → try plain text
            if (err.message?.includes("can't parse entities")) {
                await this.bot.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ''), {
                    reply_markup: { inline_keyboard: buttons },
                    reply_to_message_id,
                })
            }
        }
    }

    /** 2.89.4: remember the newest user message_id of this chat (arrival time, not processing time). */
    private noteUserMessage(msg: any): void {
        const chatId = String(msg?.chat?.id ?? '')
        const messageId = Number(msg?.message_id)
        if (!chatId || !Number.isSafeInteger(messageId)) return
        const latest = this.latestUserMessageId.get(chatId)
        if (latest === undefined || messageId > latest) this.latestUserMessageId.set(chatId, messageId)
    }

    /**
     * 2.89.4: when the user already sent a newer message while this one was still
     * running, the answer is sent as a reply to the triggering message — otherwise
     * queued answers look shifted onto the newest input.
     */
    private replyAnchorFor(chatId: string): number | undefined {
        const key = String(chatId)
        const answering = this.answeringMessageId.get(key)
        const latest = this.latestUserMessageId.get(key)
        if (answering === undefined || latest === undefined || latest <= answering) return undefined
        return answering
    }

    /** Synchronous 'message' listener: persist first, then process per chat. */
    private onRawMessage(msg: any): void {
        this.noteUserMessage(msg)
        this.persistInboundSync(msg)
        const chatId = String(msg?.chat?.id || 'unknown')
        if (/^\/(?:log|status|cancel)\s*$/i.test(String(msg.text || '').trim())) {
            // Same allowlist, group admission, live authority and durable dedup
            // as ordinary input, but not blocked by that chat's inference.
            void this.handleMessage(msg).catch(error => console.warn('[Telegram] Control command failed:', String(error)))
            return
        }
        this.enqueueMessage(chatId, () => this.handleMessage(msg))
    }

    private persistInboundSync(msg: any): void {
        if (!this.config.persistInbound || !msg?.chat) return
        // A one-time pairing code is never queued for the pipeline (2.85 first start).
        if (isTelegramPairingMessage(msg)) return
        if (!this.passesInboundPolicy(msg, false)) return
        const content = msg.text || msg.caption || (msg.photo?.length ? 'Was zeigt dieses Bild?' : '')
        if (!content) return
        try {
            this.config.persistInbound({
                id: telegramInboundKey(msg), chatId: String(msg.chat.id),
                from: String(msg.from?.id ?? ''), content: String(content),
            })
            Object.defineProperty(msg, PERSISTED_PROPERTY, { value: true, enumerable: false, configurable: true })
        } catch (error) {
            console.warn(`[Nova Telegram] Inbound persistence failed; falling back to live-authority admission: ${error}`)
        }
    }

    /** Local, synchronous admission policy (allowlist for DMs, group mention rule). */
    private passesInboundPolicy(msg: any, log: boolean): boolean {
        const userId = msg.from?.id?.toString() ?? ''
        const username = msg.from?.username ?? ''
        const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup'

        // Check allowlist for DMs
        if (!isGroup && this.config.allowFrom?.length) {
            const allowed = this.config.allowFrom.some(entry => telegramAllowlistMatches(entry, userId, username))
            if (!allowed) {
                if (log) console.log(`[Nova Telegram] Ignoring from non-allowed: ${username || userId}`)
                return false
            }
        }

        // Check group mention requirement
        if (isGroup && this.config.groupPolicy === 'mention-only') {
            const mentioned = msg.text?.includes(`@${this.botUsername}`)
            if (!mentioned && !msg.photo) return false
        }
        return true
    }

    private async handleMessage(msg: any): Promise<void> {
        this.noteUserMessage(msg)
        const replyAnchorChat = String(msg?.chat?.id ?? '')
        const replyAnchorId = Number(msg?.message_id)
        if (replyAnchorChat && Number.isSafeInteger(replyAnchorId)) this.answeringMessageId.set(replyAnchorChat, replyAnchorId)
        try {
            await this.processMessage(msg)
        } finally {
            if (replyAnchorChat && this.answeringMessageId.get(replyAnchorChat) === replyAnchorId) {
                this.answeringMessageId.delete(replyAnchorChat)
            }
        }
    }

    private async processMessage(msg: any): Promise<void> {
        // A durably persisted update is never dropped here: without live
        // authority it is handed on (without Bot API effects) so the runtime can
        // defer it. Unpersisted updates keep the fail-closed drop.
        const persisted = msg?.[PERSISTED_PROPERTY] === true
        const authorized = !this.disconnecting && await this.hasLiveAuthority()
        if (!authorized && !persisted) {
            console.warn('[Nova Telegram] Eingang verworfen: live Main-/Telegram-Autorität fehlt')
            return
        }
        const chatId = msg.chat.id.toString()
        const userId = msg.from?.id?.toString() ?? ''
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
        // 2.85 first start: "/start <one-time code>" from the desktop pairing link binds
        // the sender as owner. Checked before the allowlist; never reaches the pipeline.
        if (authorized && !isGroup && isTelegramPairingMessage(msg)) {
            const pairing = claimTelegramPairing(msg.text, { id: userId, username: msg.from?.username, isGroup })
            if (pairing.handled) {
                if (pairing.ok && !(this.config.allowFrom || []).includes(pairing.userId)) {
                    this.config.allowFrom = [...(this.config.allowFrom || []), pairing.userId]
                }
                await this.bot.sendMessage(chatId, pairing.reply)
                return
            }
        }
        if (!this.passesInboundPolicy(msg, true)) return

        // Paket L: the fixed main menu — buttons instead of commands one has to know.
        if (authorized && !isGroup && chatId === userId && /^\/(?:menu|menü|menue)(?:@\w+)?\s*$/i.test(String(msg.text || '')) && this.getOwnerChatIds().includes(userId)) {
            try { await this.sendMainMenu(chatId) } catch (error) { console.warn(`[Nova Telegram] Menü: ${String((error as Error)?.message || error).slice(0, 120)}`) }
            return
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
            id: telegramInboundKey(msg),
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

        if (authorized) {
            // Auto-react to user message based on sentiment (emojis!)
            this.autoReactToMessage(chatId, msg.message_id, content)

            // Show "typing..." indicator while processing
            this.startTyping(chatId)
        }

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
        for (const chatId of new Set([...this.typingIntervals.keys(), ...this.typingTimeouts.keys()])) {
            this.stopTyping(chatId)
        }
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
        this.noteVoiceAnswer(msg.to, sanitizeInternalOutboundArtifacts(msg.content))
        // 2.89.4: an explicit replyTo wins; otherwise answer the triggering message when
        // the user already sent a newer one (otherwise queued answers look shifted).
        const replyTo = msg.replyTo
            ? parseInt(msg.replyTo)
            : this.replyAnchorFor(String(msg.to))

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

        // Paket L: owner chats get short messages — the first page plus „Mehr ▶“ (no text walls).
        if (cleanContent.length > 600 && this.getOwnerChatIds().includes(String(msg.to))) {
            const { pagedView } = await import('./telegram-pages.js')
            const view = pagedView(String(msg.to), cleanContent)
            const options = { reply_markup: { inline_keyboard: view.keyboard }, reply_to_message_id: replyTo }
            try {
                await this.bot.sendMessage(msg.to, view.text, { parse_mode: 'Markdown', ...options })
            } catch (err: any) {
                if (!err?.message?.includes("can't parse entities")) throw err
                await this.bot.sendMessage(msg.to, view.text.replace(/\\([_*`\[\]])/g, '$1'), options)
            }
            this.stopTyping(msg.to)
            return
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
                    reply_to_message_id: i === 0 ? replyTo : undefined,
                })
            } catch (err: any) {
                // If Markdown parsing fails, try plain text
                if (err.message?.includes("can't parse entities")) {
                    console.log('[Nova Telegram] Markdown failed, sending as plain text')
                    // No parse_mode: retain identifiers and code exactly. Removing
                    // underscores corrupted tool names in the October 3 report.
                    await this.bot.sendMessage(msg.to, chunk.replace(/\\([_*`\[\]])/g, '$1'), {
                        reply_to_message_id: i === 0 ? replyTo : undefined,
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
        const clean = this.sanitizeForTelegram(formatTelegramMessage(text)) || '⏳ Xaventra arbeitet…'
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

        const sendAction = async () => {
            try {
                await this.bot?.sendChatAction(chatId, 'typing')
            } catch {
                this.stopTyping(chatId)
            }
        }

        // Send immediately, then every 4 seconds
        void sendAction()
        const interval = setInterval(() => void sendAction(), 4000)
        this.typingIntervals.set(chatId, interval)

        // Safety timeout: auto-stop after 30s to prevent infinite typing
        const timeout = setTimeout(() => this.stopTyping(chatId), 30000)
        timeout.unref?.()
        this.typingTimeouts.set(chatId, timeout)
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
        const timeout = this.typingTimeouts.get(chatId)
        if (timeout) {
            clearTimeout(timeout)
            this.typingTimeouts.delete(chatId)
        }
    }

    /**
     * Send a message with streaming (draft mode).
     * Shows ⏳ then progressively edits with incoming text.
     */
    async sendStreaming(chatId: string): Promise<DraftStream | null> {
        if (!this.bot) return null

        try {
            await this.requireLiveAuthority('stream start')
            const stream = createDraftStream()
            await stream.start(
                chatId,
                async (cid: number | string, text: string) => {
                    const sent = await this.bot.sendMessage(cid, text)
                    return sent.message_id
                },
                async (cid: number | string, msgId: number, text: string) => {
                    this.noteVoiceAnswer(cid, text)
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
        this.noteVoiceAnswer(chatId, text)
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
            if (!(await this.acceptInbound())) return
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
            await this.requireLiveAuthority('proactive send')
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
