/**
 * Nova - Message Bus
 * 
 * Layer 03: Inter-layer communication system
 * Event-driven architecture for decoupled components
 */

// ============================================
// Types
// ============================================

export type NovaEventType =
    // User Events
    | 'user:message'
    | 'user:connected'
    | 'user:disconnected'
    // LLM Events
    | 'llm:thinking'
    | 'llm:response'
    | 'llm:error'
    | 'llm:stream'
    // Tool Events
    | 'tool:execute'
    | 'tool:result'
    | 'tool:error'
    // Memory Events
    | 'memory:store'
    | 'memory:retrieve'
    | 'memory:search'
    // Agent Events
    | 'agent:spawn'
    | 'agent:complete'
    | 'agent:error'
    // System Events
    | 'system:startup'
    | 'system:shutdown'
    | 'system:error'
    | 'system:health'

export interface NovaEvent<T = unknown> {
    type: NovaEventType
    payload: T
    timestamp: number
    source?: string
    correlationId?: string
}

export type EventHandler<T = unknown> = (event: NovaEvent<T>) => void | Promise<void>

// ============================================
// Message Bus Class
// ============================================

export class MessageBus {
    private handlers: Map<NovaEventType, Set<EventHandler>> = new Map()
    private wildcardHandlers: Set<EventHandler> = new Set()
    private eventHistory: NovaEvent[] = []
    private maxHistorySize = 100

    // ============================================
    // Subscribe
    // ============================================

    on<T = unknown>(type: NovaEventType, handler: EventHandler<T>): () => void {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, new Set())
        }
        this.handlers.get(type)!.add(handler as EventHandler)

        // Return unsubscribe function
        return () => {
            this.handlers.get(type)?.delete(handler as EventHandler)
        }
    }

    onAny(handler: EventHandler): () => void {
        this.wildcardHandlers.add(handler)
        return () => {
            this.wildcardHandlers.delete(handler)
        }
    }

    once<T = unknown>(type: NovaEventType, handler: EventHandler<T>): () => void {
        const wrappedHandler: EventHandler<T> = (event) => {
            unsubscribe()
            return handler(event)
        }
        const unsubscribe = this.on(type, wrappedHandler)
        return unsubscribe
    }

    off(type: NovaEventType, handler?: EventHandler): void {
        if (handler) {
            this.handlers.get(type)?.delete(handler)
        } else {
            this.handlers.delete(type)
        }
    }

    // ============================================
    // Emit
    // ============================================

    async emit<T = unknown>(type: NovaEventType, payload: T, options?: { source?: string; correlationId?: string }): Promise<void> {
        const event: NovaEvent<T> = {
            type,
            payload,
            timestamp: Date.now(),
            source: options?.source,
            correlationId: options?.correlationId,
        }

        // Store in history
        this.eventHistory.push(event as NovaEvent)
        if (this.eventHistory.length > this.maxHistorySize) {
            this.eventHistory.shift()
        }

        // Get handlers
        const typeHandlers = this.handlers.get(type) || new Set()
        const allHandlers = [...typeHandlers, ...this.wildcardHandlers]

        // Execute all handlers
        const promises = allHandlers.map(handler => {
            try {
                return Promise.resolve(handler(event as NovaEvent))
            } catch (err) {
                console.error(`[MessageBus] Handler error for ${type}: ${err}`)
                return Promise.resolve()
            }
        })

        await Promise.all(promises)
    }

    emitSync<T = unknown>(type: NovaEventType, payload: T, options?: { source?: string; correlationId?: string }): void {
        this.emit(type, payload, options).catch(err => {
            console.error(`[MessageBus] Async emit error: ${err}`)
        })
    }

    // ============================================
    // History & Debug
    // ============================================

    getHistory(limit: number = 20): NovaEvent[] {
        return this.eventHistory.slice(-limit)
    }

    getHistoryByType(type: NovaEventType, limit: number = 20): NovaEvent[] {
        return this.eventHistory.filter(e => e.type === type).slice(-limit)
    }

    clearHistory(): void {
        this.eventHistory = []
    }

    // ============================================
    // Stats
    // ============================================

    getStats(): { handlerCount: Record<string, number>; historySize: number } {
        const handlerCount: Record<string, number> = {}
        for (const [type, handlers] of this.handlers) {
            handlerCount[type] = handlers.size
        }
        return {
            handlerCount,
            historySize: this.eventHistory.length,
        }
    }

    // ============================================
    // Cleanup
    // ============================================

    removeAllListeners(): void {
        this.handlers.clear()
        this.wildcardHandlers.clear()
    }
}

// ============================================
// Typed Event Helpers
// ============================================

// User message payload
export interface UserMessagePayload {
    userId: string
    channel: 'telegram' | 'whatsapp' | 'discord' | 'cli'
    channelId: string
    content: string
    isGroup: boolean
}

// LLM response payload
export interface LLMResponsePayload {
    content: string
    model: string
    tokensIn: number
    tokensOut: number
    durationMs: number
}

// Tool execution payload
export interface ToolExecutePayload {
    toolName: string
    args: Record<string, unknown>
    userId?: string
}

export interface ToolResultPayload {
    toolName: string
    result: unknown
    success: boolean
    durationMs: number
}

// ============================================
// Singleton Instance
// ============================================

let globalMessageBus: MessageBus | null = null

export function getMessageBus(): MessageBus {
    if (!globalMessageBus) {
        globalMessageBus = new MessageBus()
    }
    return globalMessageBus
}

export function resetMessageBus(): void {
    globalMessageBus?.removeAllListeners()
    globalMessageBus = null
}
