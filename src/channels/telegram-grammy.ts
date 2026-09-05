/**
 * Nova - Grammy Telegram Adapter
 * 
 * Modern Telegram integration using grammy.
 * Features: Middleware, throttling, parallel processing.
 */

// ============================================
// Types
// ============================================

export interface Message {
    id: string
    channel: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    raw?: unknown
}

// ============================================
// Types
// ============================================

export interface GrammyConfig {
    token: string
    allowedUsers?: string[]  // User IDs that can interact
    adminUsers?: string[]    // Admin user IDs
    throttleMs?: number      // Rate limiting
}

export interface TelegramMessage {
    chatId: number
    userId: number
    username?: string
    text: string
    isGroup: boolean
    replyToMessageId?: number
}

// ============================================
// Grammy Telegram Adapter
// ============================================

export class GrammyTelegramAdapter {
    private config: GrammyConfig
    private bot: import('grammy').Bot | null = null
    private messageHandler: ((msg: Message) => Promise<string | void>) | null = null

    constructor(config: GrammyConfig) {
        this.config = {
            ...config,
            throttleMs: config.throttleMs ?? 50,
        }
    }

    /**
     * Initialize the bot
     */
    async init(): Promise<void> {
        try {
            const { Bot } = await import('grammy')
            this.bot = new Bot(this.config.token)

            // Setup middleware
            await this.setupMiddleware()

            // Setup message handler
            this.setupHandlers()

            console.log('[Grammy] Telegram bot initialized')
        } catch (err) {
            console.error('[Grammy] Failed to initialize:', err)
            throw err
        }
    }

    /**
     * Setup middleware (throttling, logging)
     */
    private async setupMiddleware(): Promise<void> {
        if (!this.bot) return

        try {
            // Throttling middleware
            const { apiThrottler } = await import('@grammyjs/transformer-throttler')
            this.bot.api.config.use(apiThrottler())
            console.log('[Grammy] Throttling middleware enabled')
        } catch {
            console.log('[Grammy] Throttling middleware not available')
        }

        // Logging middleware
        this.bot.use(async (ctx, next) => {
            const start = Date.now()
            await next()
            const ms = Date.now() - start
            console.log(`[Grammy] Response time: ${ms}ms`)
        })

        // User filter middleware
        if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
            this.bot.use(async (ctx, next) => {
                const userId = ctx.from?.id?.toString()
                if (userId && this.config.allowedUsers?.includes(userId)) {
                    await next()
                } else {
                    console.log(`[Grammy] Blocked user: ${userId}`)
                }
            })
        }
    }

    /**
     * Setup message handlers
     */
    private setupHandlers(): void {
        if (!this.bot) return

        // Text messages
        this.bot.on('message:text', async (ctx) => {
            const text = ctx.message.text
            const userId = ctx.from.id
            const username = ctx.from.username

            console.log(`[Grammy] Message from ${username ?? userId}: ${text.slice(0, 50)}...`)

            if (this.messageHandler) {
                const novaMessage: Message = {
                    id: ctx.message.message_id.toString(),
                    channel: 'telegram',
                    senderId: userId.toString(),
                    senderName: username ?? `User ${userId}`,
                    content: text,
                    timestamp: Date.now(),
                    raw: ctx.message,
                }

                try {
                    const response = await this.messageHandler(novaMessage)
                    if (response) {
                        await ctx.reply(response, {
                            parse_mode: 'Markdown',
                        })
                    }
                } catch (err) {
                    console.error('[Grammy] Handler error:', err)
                    await ctx.reply('❌ Ein Fehler ist aufgetreten.')
                }
            }
        })

        // Commands
        this.bot.command('start', async (ctx) => {
            await ctx.reply('👋 Willkommen bei Nova! Wie kann ich dir helfen?')
        })

        this.bot.command('help', async (ctx) => {
            await ctx.reply(
                '🤖 *Nova Commands*\n\n' +
                '/start - Bot starten\n' +
                '/help - Diese Hilfe\n' +
                '/status - Bot Status\n' +
                '/model - Aktuelles Modell\n\n' +
                'Schreib einfach eine Nachricht um mit Nova zu chatten!',
                { parse_mode: 'Markdown' }
            )
        })

        this.bot.command('status', async (ctx) => {
            await ctx.reply('✅ Nova ist online und bereit!')
        })

        // Photos/Images
        this.bot.on('message:photo', async (ctx) => {
            await ctx.reply('📷 Bildverarbeitung kommt bald!')
        })

        // Voice messages
        this.bot.on('message:voice', async (ctx) => {
            await ctx.reply('🎤 Sprachnachrichten kommen bald!')
        })

        // Documents
        this.bot.on('message:document', async (ctx) => {
            await ctx.reply('📄 Dokumentverarbeitung kommt bald!')
        })
    }

    /**
     * Set message handler
     */
    onMessage(handler: (msg: Message) => Promise<string | void>): void {
        this.messageHandler = handler
    }

    /**
     * Start polling
     */
    async start(): Promise<void> {
        if (!this.bot) {
            await this.init()
        }

        console.log('[Grammy] Starting Telegram bot...')

        try {
            // Use runner for parallel processing if available
            const { run } = await import('@grammyjs/runner')
            const runner = run(this.bot!)
            console.log('[Grammy] Bot running with parallel processing')

            // Handle stop
            process.once('SIGINT', () => runner.stop())
            process.once('SIGTERM', () => runner.stop())
        } catch {
            // Fallback to simple polling
            await this.bot!.start({
                onStart: () => console.log('[Grammy] Bot started (polling)'),
            })
        }
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        if (this.bot) {
            await this.bot.stop()
            console.log('[Grammy] Bot stopped')
        }
    }

    /**
     * Send a message
     */
    async send(chatId: number | string, text: string): Promise<void> {
        if (!this.bot) {
            throw new Error('Bot not initialized')
        }

        await this.bot.api.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
        })
    }

    /**
     * Send a message with keyboard
     */
    async sendWithKeyboard(
        chatId: number | string,
        text: string,
        buttons: string[][]
    ): Promise<void> {
        if (!this.bot) {
            throw new Error('Bot not initialized')
        }

        const { Keyboard } = await import('grammy')
        const keyboard = new Keyboard()

        for (const row of buttons) {
            for (const btn of row) {
                keyboard.text(btn)
            }
            keyboard.row()
        }

        await this.bot.api.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        })
    }

    /**
     * Check if a user is admin
     */
    isAdmin(userId: string): boolean {
        return this.config.adminUsers?.includes(userId) ?? false
    }
}

// ============================================
// Factory
// ============================================

export function createGrammyAdapter(config: GrammyConfig): GrammyTelegramAdapter {
    return new GrammyTelegramAdapter(config)
}

export default { GrammyTelegramAdapter, createGrammyAdapter }
