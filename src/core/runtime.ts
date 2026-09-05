/**
 * Brutus Core - Runtime Engine
 * Clean state machine for message processing with self-learning
 */

import type {
    IncomingMessage,
    OutgoingMessage,
    CommandHandler,
    BrutusConfig,
    Feedback,
} from './types.js'

export type RuntimeState =
    | 'idle'
    | 'receiving'
    | 'processing'
    | 'learning'
    | 'responding'
    | 'error'

export interface RuntimeContext {
    state: RuntimeState
    config: BrutusConfig
    currentMessage?: IncomingMessage
    pendingResponse?: string
    error?: Error
}

export interface ChannelAdapter {
    type: string
    connect: () => Promise<void>
    disconnect: () => Promise<void>
    send: (msg: OutgoingMessage) => Promise<void>
    onMessage: (handler: (msg: IncomingMessage) => void) => void
}

export interface LLMAdapter {
    provider: string
    complete: (messages: Array<{ role: string; content: string }>) => Promise<string>
}

export interface LearningEngine {
    recordFeedback: (feedback: Feedback) => Promise<void>
    findPattern: (input: string) => Promise<string | null>
    shouldLearn: (pattern: string, count: number) => boolean
}

/**
 * Core Runtime - The heart of Brutus
 */
export class BrutusRuntime {
    private state: RuntimeState = 'idle'
    private config: BrutusConfig
    private channels: Map<string, ChannelAdapter> = new Map()
    private commands: Map<string, CommandHandler> = new Map()
    private llm?: LLMAdapter
    private learning?: LearningEngine

    constructor(config: BrutusConfig) {
        this.config = config
        console.log(`[Brutus] ${config.emoji} Initializing ${config.name}...`)
    }

    getState(): RuntimeState {
        return this.state
    }

    // ============================================
    // Channel Management
    // ============================================

    registerChannel(adapter: ChannelAdapter): void {
        this.channels.set(adapter.type, adapter)
        adapter.onMessage((msg) => this.handleMessage(msg))
        console.log(`[Brutus] Channel registered: ${adapter.type}`)
    }

    // ============================================
    // Command Management
    // ============================================

    registerCommand(handler: CommandHandler): void {
        this.commands.set(handler.name, handler)
        handler.aliases?.forEach(alias => this.commands.set(alias, handler))
        console.log(`[Brutus] Command registered: /${handler.name}`)
    }

    // ============================================
    // LLM & Learning
    // ============================================

    setLLM(adapter: LLMAdapter): void {
        this.llm = adapter
        console.log(`[Brutus] LLM set: ${adapter.provider}`)
    }

    setLearning(engine: LearningEngine): void {
        this.learning = engine
        console.log(`[Brutus] Learning engine enabled`)
    }

    // ============================================
    // Message Processing (State Machine)
    // ============================================

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        this.state = 'receiving'
        console.log(`[Brutus] Message from ${msg.from}: ${msg.content.slice(0, 50)}...`)

        try {
            // 1. Check for commands
            if (msg.content.startsWith('/')) {
                const response = await this.handleCommand(msg)
                if (response) {
                    await this.respond(msg, response)
                    return
                }
            }

            // 2. Check learned patterns (Self-Learning)
            if (this.learning && this.config.selfLearning) {
                const learned = await this.learning.findPattern(msg.content)
                if (learned) {
                    console.log(`[Brutus] Using learned pattern`)
                    await this.respond(msg, learned)
                    return
                }
            }

            // 3. Use LLM
            this.state = 'processing'
            if (!this.llm) {
                throw new Error('No LLM configured')
            }

            const response = await this.llm.complete([
                { role: 'system', content: this.buildSystemPrompt() },
                { role: 'user', content: msg.content },
            ])

            await this.respond(msg, response)

        } catch (error) {
            this.state = 'error'
            console.error(`[Brutus] Error:`, error)
            await this.respond(msg, `❌ Fehler: ${error instanceof Error ? error.message : 'Unknown'}`)
        }

        this.state = 'idle'
    }

    private async handleCommand(msg: IncomingMessage): Promise<string | null> {
        const match = msg.content.match(/^\/(\w+)(?:\s+(.*))?$/)
        if (!match) return null

        const [, name, args] = match
        const handler = this.commands.get(name.toLowerCase())

        if (!handler) return null

        return handler.execute({ name, args, raw: msg.content }, msg)
    }

    private async respond(msg: IncomingMessage, content: string): Promise<void> {
        this.state = 'responding'
        const channel = this.channels.get(msg.channel)

        if (!channel) {
            console.error(`[Brutus] No channel adapter for: ${msg.channel}`)
            return
        }

        await channel.send({
            channel: msg.channel,
            to: msg.isGroup ? msg.groupId! : msg.from,
            content,
            replyTo: msg.id,
        })
    }

    private buildSystemPrompt(): string {
        return `Du bist ${this.config.name} ${this.config.emoji}, ein hilfsbereiter Roboter.
Du antwortest auf Deutsch, präzise und freundlich.
Du lernst aus Feedback und verbesserst dich ständig.`
    }

    // ============================================
    // Lifecycle
    // ============================================

    async start(): Promise<void> {
        console.log(`[Brutus] Starting ${this.config.name}...`)

        for (const [type, channel] of this.channels) {
            await channel.connect()
            console.log(`[Brutus] Connected to ${type}`)
        }

        console.log(`[Brutus] ${this.config.emoji} ${this.config.name} is ready!`)
    }

    async stop(): Promise<void> {
        console.log(`[Brutus] Stopping...`)

        for (const [type, channel] of this.channels) {
            await channel.disconnect()
            console.log(`[Brutus] Disconnected from ${type}`)
        }
    }
}
