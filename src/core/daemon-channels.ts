/**
 * Nova Daemon - Channel Starters
 *
 * Extracted from daemon.ts: startTelegram, startWhatsApp, startDiscord, startDashboard
 *
 * These functions initialise each communication channel and wire up message routing
 * through the unified handleMessage pipeline. They are kept in a separate module to
 * keep daemon.ts focused on orchestration / layer initialisation rather than
 * per-channel boot logic.
*/

import { logRuntimeEvent } from './runtime-event-log.js'
import { TelegramPresentationSession } from '../channels/telegram-presentation.js'

// ============================================
// Types
// ============================================

/** Minimal slice of NovaConfig that the channel starters need. */
export interface ChannelStarterConfig {
    channels: {
        telegram?: { enabled: boolean; token: string; allowFrom?: string[] }
        whatsapp?: { enabled: boolean; authPath?: string }
        discord?: { enabled: boolean; token?: string }
        cli?: { enabled: boolean }
    }
    dashboard?: { enabled: boolean; host?: string; port: number; password?: string }
}

/**
 * The mutable runtime-state object that the channel starters write their adapter
 * instances into so the rest of the daemon can access them.
 */
export interface ChannelsState {
    channels: {
        telegram: any
        whatsapp: any
        discord: any
    }
    [key: string]: any
}

/**
 * Unified message handler signature — matches handleMessage() in daemon.ts.
 */
export type MessageHandler = (
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
    image?: { data: string; mimeType: string }
) => Promise<void>

export async function verifyTelegramAuthority(
    verify?: (service: string) => Promise<boolean>,
): Promise<boolean> {
    const checker = verify || (await import('../mesh/leader-election.js')).verifyLiveServiceLeadership
    if (!(await checker('nova-main'))) return false
    return checker('telegram')
}

// ============================================
// Telegram Channel
// ============================================

export async function startTelegram(
    config: ChannelStarterConfig['channels']['telegram'],
    messageHandler: MessageHandler,
    state: ChannelsState,
): Promise<void> {
    // Edge nodes must NOT run Telegram — only one bot instance per token allowed!
    const nodeOnly = process.env.NOVA_NODE_ONLY === 'true'
    const telegramMode = process.env.NOVA_TELEGRAM_MODE || (nodeOnly ? 'disabled' : 'primary')
    if (process.env.NOVA_NO_TELEGRAM === 'true' || telegramMode === 'disabled' || (nodeOnly && telegramMode !== 'standby')) {
        console.log('[Nova] Telegram übersprungen (Modus: disabled)')
        return
    }

    // Do not acquire the shared lease when this node cannot start the bot.
    if (!config?.enabled || !config.token) {
        console.log('[Nova] Telegram nicht konfiguriert')
        return
    }

    const { shouldStartExclusiveService, watchForServiceLeadership, onLeadershipLost, stopLeaseRenewal, MAIN_SERVICE } = await import('../mesh/leader-election.js')
    // Telegram follows the canonical control-plane Main. This prevents a node
    // from becoming channel owner merely because its independent Telegram
    // lease happened to expire first.
    if (!(await shouldStartExclusiveService(MAIN_SERVICE))) {
        watchForServiceLeadership(MAIN_SERVICE, () => startTelegram(config, messageHandler, state))
        return
    }
    if (!(await shouldStartExclusiveService('telegram'))) {
        watchForServiceLeadership('telegram', () => startTelegram(config, messageHandler, state))
        return
    }

    // A promoted standby may expose Telegram only after restoring the shared
    // channel state, governed memories/tombstones and durable message queue.
    let failoverMessages: Array<{ id: string; chatId: string; from: string; content: string; channel: string }> = []
    try {
        const { isHaStateAvailable, hydrateChannelState } = await import('./ha-state.js')
        const available = await isHaStateAvailable()
        if (!available && telegramMode === 'standby') {
            console.warn('[Nova] Telegram-Übernahme blockiert: gemeinsamer HA-Zustand nicht erreichbar')
            stopLeaseRenewal('telegram')
            watchForServiceLeadership('telegram', () => startTelegram(config, messageHandler, state))
            return
        }
        if (available) {
            const [{ hydrateSharedMessageQueue }, { syncFederatedMemoryOnce }] = await Promise.all([
                import('../channels/message-queue.js'),
                import('../layers/L22-federated-memory.js'),
            ])
            await hydrateChannelState('Telegram', state)
            const [queueState] = await Promise.all([
                hydrateSharedMessageQueue(),
                syncFederatedMemoryOnce(),
            ])
            failoverMessages = queueState.pending
            console.log(`[Nova] HA-Zustand hydriert: ${failoverMessages.length} offene Nachricht(en)`)
        }
    } catch (error) {
        if (telegramMode === 'standby') {
            console.warn(`[Nova] Telegram-Übernahme blockiert: HA-Hydrierung fehlgeschlagen (${error})`)
            stopLeaseRenewal('telegram')
            watchForServiceLeadership('telegram', () => startTelegram(config, messageHandler, state))
            return
        }
        console.warn(`[Nova] HA-Hydrierung übersprungen: ${error}`)
    }

    const { createTelegramAdapter } = await import('../channels/telegram.js')

    const adapter = createTelegramAdapter({
        token: config.token,
        allowFrom: config.allowFrom || [],
        groupPolicy: 'mention-only',
    })

    adapter.onMessage(async (msg: any) => {
        if (!(await verifyTelegramAuthority())) {
            console.warn('[Nova Telegram] Eingang verworfen: keine live verifizierte Main-/Telegram-Lease')
            return
        }
        const processingStartedAt = Date.now()
        // Store last active chat ID on global state for dynamic resolution
        const chatId = msg.to || msg.groupId || msg.from
        const presentation = new TelegramPresentationSession(adapter as any, String(chatId))
        if (chatId && (globalThis as any).__novaState) {
            (globalThis as any).__novaState.lastActiveChatId = chatId
            ;(globalThis as any).__novaState.lastActiveUserId = String(msg.from)
            state.lastActiveChatId = String(chatId)
            state.lastActiveUserId = String(msg.from)
            // Store as adminChatId so heartbeat always has a target
            if (!(globalThis as any).__novaState.adminChatId) {
                (globalThis as any).__novaState.adminChatId = chatId
                state.adminChatId = String(chatId)
                console.log(`[Nova] Admin chatId gespeichert: ${chatId}`)
            }
            const { publishChannelState } = await import('./ha-state.js')
            void publishChannelState('Telegram', {
                lastActiveChatId: String(chatId),
                adminChatId: String((globalThis as any).__novaState.adminChatId || chatId),
                lastActiveUserId: String(msg.from),
            }).catch(() => { /* local channel remains available */ })
        }

        // ---- Persistent Message Queue ----
        const msgId = String(msg.updateId || msg.id || `tg-${Date.now()}`)
        logRuntimeEvent({ event: 'telegram.message.received', channel: 'Telegram', userId: String(msg.from), messageId: msgId })
        let _queueMarkDone: ((id: string) => void) | undefined
        let _queueIncrementRetry: ((id: string) => void) | undefined
        let accepted = true
        try {
            const queue = await import('../channels/message-queue.js')
            accepted = queue.logIncoming({ id: msgId, chatId: String(chatId), from: String(msg.from), content: msg.content, channel: 'Telegram' })
            _queueMarkDone = queue.markDone
            _queueIncrementRetry = queue.incrementRetry
        } catch { /* queue optional */ }
        if (!accepted) {
            logRuntimeEvent({ event: 'telegram.message.duplicate', channel: 'Telegram', userId: String(msg.from), messageId: msgId, success: true })
            return
        }

        try {
            const { awaitRuntimeReady } = await import('./runtime-readiness.js')
            if (!(globalThis as any).__novaState?.runtimeReady) {
                console.log(`[Nova Telegram] ⏸ Nachricht ${msgId} persistent gepuffert — warte auf runtimeReady`)
            }
            await awaitRuntimeReady()
            const queue = await import('../channels/message-queue.js')
            queue.markProcessing(msgId)
            await messageHandler('Telegram', msg.from, msg.content, async (reply) => {
                if (!(await verifyTelegramAuthority())) {
                    throw new Error('Telegram reply fenced: Main-/Telegram-Lease ist nicht mehr gültig')
                }
                const delivery = await presentation.deliver(reply)
                logRuntimeEvent({ event: 'telegram.reply.sent', channel: 'Telegram', userId: String(msg.from), messageId: msgId, success: true, detail: delivery })
            }, msg.image)
            await presentation.clearProgress()
            _queueMarkDone?.(msgId)
            logRuntimeEvent({ event: 'telegram.message.completed', channel: 'Telegram', userId: String(msg.from), messageId: msgId, success: true, durationMs: Date.now() - processingStartedAt })
        } catch (err) {
            await presentation.clearProgress().catch(() => { /* best effort after failure */ })
            _queueIncrementRetry?.(msgId)
            logRuntimeEvent({ event: 'telegram.message.failed', channel: 'Telegram', userId: String(msg.from), messageId: msgId, success: false, durationMs: Date.now() - processingStartedAt, detail: String(err).slice(0, 500) })
            throw err
        }
    })

    try {
        await adapter.connect()
    } catch (error) {
        stopLeaseRenewal('telegram')
        watchForServiceLeadership('telegram', () => startTelegram(config, messageHandler, state))
        logRuntimeEvent({ event: 'telegram.connection.failed', channel: 'Telegram', success: false, detail: String(error).slice(0, 500) })
        throw error
    }
    state.channels.telegram = adapter
    const initialChatId = config.allowFrom?.[0]
        || (globalThis as any).__novaState?.lastActiveChatId
        || (globalThis as any).__novaState?.adminChatId
    if (initialChatId) {
        state.lastActiveChatId ||= String(initialChatId)
        state.adminChatId ||= String(initialChatId)
        const globalState = (globalThis as any).__novaState
        if (globalState) {
            globalState.lastActiveChatId ||= String(initialChatId)
            globalState.adminChatId ||= String(initialChatId)
        }
        const { publishChannelState } = await import('./ha-state.js')
        const mirrored = await publishChannelState('Telegram', {
            lastActiveChatId: String(initialChatId),
            adminChatId: String(initialChatId),
            lastActiveUserId: state.lastActiveUserId || globalState?.lastActiveUserId || null,
        }).catch(() => false)
        logRuntimeEvent({
            event: 'telegram.connection.ready',
            channel: 'Telegram',
            success: true,
            detail: mirrored ? 'ha-state-mirrored' : 'ha-state-mirror-failed',
        })
    }
    onLeadershipLost('telegram', async () => {
        await adapter.disconnect?.()
        if (state.channels.telegram === adapter) state.channels.telegram = null
        watchForServiceLeadership('telegram', () => startTelegram(config, messageHandler, state))
    })
    onLeadershipLost(MAIN_SERVICE, async () => {
        stopLeaseRenewal('telegram')
        await adapter.disconnect?.()
        if (state.channels.telegram === adapter) state.channels.telegram = null
        watchForServiceLeadership(MAIN_SERVICE, () => startTelegram(config, messageHandler, state))
    })
    console.log(`[Nova] ✓ Telegram verbunden: @${adapter.getUsername()}`)

    if (failoverMessages.length > 0) {
        const existing = Array.isArray(state._pendingReplayMessages) ? state._pendingReplayMessages : []
        const merged = new Map<string, any>()
        for (const message of [...existing, ...failoverMessages]) merged.set(message.id, message)
        state._pendingReplayMessages = [...merged.values()]

        // During a late promotion the normal startup drain has already passed.
        if ((globalThis as any).__novaState?.runtimeReady) {
            const pending = state._pendingReplayMessages
            delete state._pendingReplayMessages
            void (async () => {
                const queue = await import('../channels/message-queue.js')
                for (const message of pending) {
                    if (!queue.isMessageProcessable(message.id)) continue
                    try {
                        if (!(await verifyTelegramAuthority())) break
                        queue.markProcessing(message.id)
                        await messageHandler(message.channel, message.from, message.content, async reply => {
                            if (!(await verifyTelegramAuthority())) throw new Error('Telegram replay fenced')
                            await (adapter.send as any)({ to: message.chatId, content: reply })
                        })
                        queue.markDone(message.id)
                    } catch {
                        queue.incrementRetry(message.id)
                    }
                }
            })()
        }
    }

    // Startup greeting is handled by the System-Report below (line ~1921)
    // which includes version, model, AND node health — no duplicate messages

    // Wire up reminder notifications
    try {
        const { setReminderNotifyCallback, setReminderWakeupCallback, initReminders } = await import('../tools/reminder-tool.js')
        setReminderNotifyCallback(async (userId, channel, message) => {
            if (!(await verifyTelegramAuthority())) {
                console.log('[Reminder] Unterdrückt: Node besitzt keine live verifizierte Telegram-Autorität')
                return
            }
            // Resolve the actual Telegram chat ID dynamically
            // userId might be "Sample" (username), but Telegram needs numeric chatId
            let chatId = userId

            // If userId is not numeric, find the real chatId from all sources
            if (!/^\d+$/.test(userId)) {
                chatId = config?.allowFrom?.[0]
                    || adapter?.getLastActiveChat?.()
                    || (globalThis as any).__novaState?.lastActiveChatId
                    || userId
            }

            console.log(`[Reminder] 📨 Sending to ${chatId} (original userId: ${userId}): ${message.slice(0, 60)}...`)

            try {
                // Try direct bot API first (most reliable)
                if ((adapter as any)?.bot) {
                    await (adapter as any).bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(async () => {
                        // Markdown failed, try plain
                        await (adapter as any).bot.sendMessage(chatId, message)
                    })
                    console.log(`[Reminder] ✅ Sent successfully to ${chatId}`)
                } else {
                    // Fallback to adapter.send
                    await (adapter.send as any)({
                        to: chatId,
                        content: message,
                    })
                }
            } catch (err) {
                console.error(`[Reminder] ❌ Failed to send to ${chatId}: ${err}`)
                // Last resort: try sendProactive
                try {
                    await adapter.sendProactive?.(message)
                } catch { /* give up */ }
            }
        })

        // Wakeup callback — inject reminder into pipeline so Nova acts on it
        setReminderWakeupCallback(async (userId, channel, reminderContent) => {
            if (!(await verifyTelegramAuthority())) {
                console.log('[Reminder] Wakeup unterdrückt: Node besitzt keine live verifizierte Telegram-Autorität')
                return
            }
            let replyTo = config?.allowFrom?.[0]
                || adapter?.getLastActiveChat?.()
                || (globalThis as any).__novaState?.lastActiveChatId

            if (!replyTo) {
                console.log('[Reminder] ⚠ No chatId for wakeup — skipping pipeline injection')
                return
            }

            console.log(`[Reminder] 🧠 Waking Nova via pipeline: ${reminderContent.slice(0, 60)}...`)
            try {
                await messageHandler('Telegram', userId || 'System', reminderContent, async (reply) => {
                    if (!(await verifyTelegramAuthority())) return
                    try {
                        if ((adapter as any)?.bot) {
                            await (adapter as any).bot.sendMessage(replyTo, reply, { parse_mode: 'Markdown' }).catch(async () => {
                                await (adapter as any).bot.sendMessage(replyTo!, reply)
                            })
                        } else {
                            await (adapter.send as any)({ to: replyTo, content: reply })
                        }
                    } catch { /* non-critical */ }
                })
            } catch (err) {
                console.error(`[Reminder] Wakeup pipeline failed: ${err}`)
            }
        })

        await initReminders() // Load persisted reminders, fire overdue ones
        console.log('[Nova] ✓ Reminder-Callback registriert (persistent + wakeup)')
    } catch (err) {
        console.log(`[Nova] Reminder-Callback nicht verfügbar: ${err}`)
    }

    // Wire up Heartbeat Telegram callbacks (scheduler runs independently in startDaemon)
    try {
        const { setHeartbeatNotifyCallback, setHeartbeatWakeupCallback } = await import('../core/heartbeat.js')

        setHeartbeatNotifyCallback(async (message) => {
            if (!(await verifyTelegramAuthority())) {
                console.log('[Heartbeat] Notify unterdrückt: Node besitzt keine live verifizierte Telegram-Autorität')
                return
            }
            let chatId = config?.allowFrom?.[0]
                || adapter?.getLastActiveChat?.()
                || (globalThis as any).__novaState?.lastActiveChatId
                || (globalThis as any).__novaState?.adminChatId
            if (!chatId) {
                console.log('[Heartbeat] ⚠️ Notify: kein chatId')
                return
            }

            try {
                if ((adapter as any)?.bot) {
                    await (adapter as any).bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(async () => {
                        await (adapter as any).bot.sendMessage(chatId!, message)
                    })
                }
            } catch { /* non-critical */ }
        })

        setHeartbeatWakeupCallback(async (userId, channel, content) => {
            if (!(await verifyTelegramAuthority())) {
                console.log('[Heartbeat] Wakeup unterdrückt: Node besitzt keine live verifizierte Telegram-Autorität')
                return
            }
            let replyTo = config?.allowFrom?.[0]
                || adapter?.getLastActiveChat?.()
                || (globalThis as any).__novaState?.lastActiveChatId
                || (globalThis as any).__novaState?.adminChatId
            if (!replyTo) {
                try {
                    const { getAdminChatId } = await import('../tools/reminder-tool.js')
                    replyTo = getAdminChatId()
                } catch { }
            }
            if (!replyTo) {
                console.log('[Heartbeat] ⚠️ Kein chatId — Warte auf erste Telegram-Nachricht.')
                return
            }

            try {
                await messageHandler('Telegram', userId || 'System', content, async (reply) => {
                    if (!(await verifyTelegramAuthority())) return
                    try {
                        if ((adapter as any)?.bot) {
                            await (adapter as any).bot.sendMessage(replyTo, reply, { parse_mode: 'Markdown' }).catch(async () => {
                                await (adapter as any).bot.sendMessage(replyTo!, reply)
                            })
                        }
                    } catch { /* non-critical */ }
                })
            } catch (err) {
                console.error(`[Heartbeat] Wakeup failed: ${err}`)
            }
        })

        console.log('[Nova] ✓ Heartbeat Telegram-Callbacks registriert')
    } catch (err) {
        console.log(`[Nova] Heartbeat Telegram-Callbacks nicht verfügbar: ${err}`)
    }

    // Wire up L15 idle learning notifications
    try {
        const { connectL15NotifyCallback } = await import('../channels/telegram.js')
        await connectL15NotifyCallback()
    } catch (err) {
        console.log(`[Nova] L15 Notify-Callback nicht verfügbar: ${err}`)
    }
}

// ============================================
// WhatsApp Channel
// ============================================

export async function startWhatsApp(
    config: ChannelStarterConfig['channels']['whatsapp'],
    messageHandler: MessageHandler,
    state: ChannelsState,
): Promise<void> {
    if (process.env.NOVA_ROLE === 'edge' && process.env.NOVA_MESH_FAILOVER_MAIN === 'false') return
    const { shouldStartExclusiveService, watchForServiceLeadership, onLeadershipLost } = await import('../mesh/leader-election.js')
    if (!(await shouldStartExclusiveService('whatsapp'))) {
        watchForServiceLeadership('whatsapp', () => startWhatsApp(config, messageHandler, state))
        return
    }
    if (!config?.enabled) {
        console.log('[Nova] WhatsApp nicht konfiguriert')
        return
    }

    try {
        const { WhatsAppAdapter } = await import('../channels/whatsapp.js')

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adapter = new WhatsAppAdapter(config as any)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adapter.onMessage(async (msg: any) => {
            await messageHandler('WhatsApp', msg.from, msg.content, async (reply) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (adapter as any).send({
                    channel: 'whatsapp',
                    to: msg.from,
                    content: reply,
                })
            })
        })

        await adapter.connect()
        state.channels.whatsapp = adapter
        onLeadershipLost('whatsapp', async () => {
            await adapter.disconnect?.()
            if (state.channels.whatsapp === adapter) state.channels.whatsapp = null
            watchForServiceLeadership('whatsapp', () => startWhatsApp(config, messageHandler, state))
        })
        console.log(`[Nova] ✓ WhatsApp verbunden`)
    } catch (err) {
        console.log(`[Nova] ⚠ WhatsApp nicht verfügbar: ${err}`)
    }
}

// ============================================
// Discord Channel
// ============================================

export async function startDiscord(
    config: ChannelStarterConfig['channels']['discord'],
    messageHandler: MessageHandler,
    state: ChannelsState,
): Promise<void> {
    if (process.env.NOVA_ROLE === 'edge' && process.env.NOVA_MESH_FAILOVER_MAIN === 'false') return
    const { shouldStartExclusiveService, watchForServiceLeadership, onLeadershipLost } = await import('../mesh/leader-election.js')
    if (!(await shouldStartExclusiveService('discord'))) {
        watchForServiceLeadership('discord', () => startDiscord(config, messageHandler, state))
        return
    }
    if (!config?.enabled || !config.token) {
        console.log('[Nova] Discord nicht konfiguriert')
        return
    }

    try {
        const { DiscordAdapter } = await import('../channels/discord.js')

        const adapter = new DiscordAdapter({
            token: config.token,
        })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adapter.onMessage(async (msg: any) => {
            await messageHandler('Discord', msg.from, msg.content, async (reply) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (adapter as any).send({
                    channel: 'discord',
                    to: msg.groupId || msg.from,
                    content: reply,
                })
            })
        })

        await adapter.connect()
        state.channels.discord = adapter
        onLeadershipLost('discord', async () => {
            await adapter.disconnect?.()
            if (state.channels.discord === adapter) state.channels.discord = null
            watchForServiceLeadership('discord', () => startDiscord(config, messageHandler, state))
        })
        console.log(`[Nova] ✓ Discord verbunden`)
    } catch (err) {
        console.log(`[Nova] ⚠ Discord nicht verfügbar: ${err}`)
    }
}

// ============================================
// Dashboard
// ============================================

export async function startDashboard(
    config: ChannelStarterConfig['dashboard'],
    messageHandler: MessageHandler,
    _state: ChannelsState,
): Promise<void> {
    if (config?.enabled === false) return
    const { shouldStartExclusiveService, watchForServiceLeadership, onLeadershipLost, MAIN_SERVICE } = await import('../mesh/leader-election.js')
    // The Desktop/Dashboard control plane follows the canonical Main just like
    // Telegram. An independent dashboard lease must never turn a worker into
    // an operator endpoint with stale mesh state.
    if (!(await shouldStartExclusiveService(MAIN_SERVICE))) {
        watchForServiceLeadership(MAIN_SERVICE, () => startDashboard(config, messageHandler, _state))
        return
    }
    if (!(await shouldStartExclusiveService('dashboard'))) {
        watchForServiceLeadership('dashboard', () => startDashboard(config, messageHandler, _state))
        return
    }

    // Always try to start new Nova Dashboard
    try {
        const { startDashboard: startNovaDashboard, setNovaMessageHandler } = await import('../dashboard/server.js')
        const url = await startNovaDashboard(config?.port || 3011, config?.host || '127.0.0.1')

        // Wire up chat handler — routes through unified handleMessage
        setNovaMessageHandler(async (message: string, channel: string) => {
            // Collect the response via a callback
            let response = ''
            const replyFn = async (msg: string) => { response = msg }

            // Route through the unified handler — gets ALL features automatically:
            // Admin code, slash commands, GraphRAG, Journal, LanceDB, Observer, etc.
            const desktopContext = channel === 'desktop'
                ? (await import('../desktop/desktop-agent-context.js')).getDesktopAgentContext()
                : undefined
            await messageHandler(channel || 'dashboard', desktopContext?.authorizationUserId || 'dashboard', message, replyFn)

            return response || 'Keine Antwort generiert.'
        })

        console.log(`[Nova] ✓ Dashboard: ${url}`)
        console.log(`[Nova]   → L0 Status, Agent Activity, Vector DB Thoughts, Chat ✓`)
        onLeadershipLost('dashboard', async () => {
            const { stopDashboard } = await import('../dashboard/server.js')
            await stopDashboard()
            watchForServiceLeadership('dashboard', () => startDashboard(config, messageHandler, _state))
        })
    } catch (err) {
        console.log(`[Nova] ⚠ Dashboard nicht verfügbar: ${err}`)

        // A bind failure is not permission to start a different/legacy ingress.
        // The configured endpoint remains unavailable until its cause is fixed.
    }
}
