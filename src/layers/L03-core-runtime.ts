/**
 * Nova Layer 03 - Core Runtime
 * 
 * State Machine & Message Bus for robust system control.
 * Prevents system hangs and ensures 100% reliability.
 * 
 * Features:
 * - State Machine: idle → working → waiting → idle
 * - Message Bus: Pub/Sub for inter-layer communication
 * - Request Queue: Manages concurrent requests
 * - Watchdog: Detects and recovers from hangs
 */

import { EventEmitter } from 'node:events'
import { getStateMachine, type StateMachine } from '../core/state-machine.js'

// ============================================
// Types
// ============================================

export type NovaState = 'idle' | 'working' | 'waiting' | 'error' | 'maintenance'

export interface StateTransition {
    from: NovaState
    to: NovaState
    timestamp: number
    reason?: string
}

export interface BusMessage {
    id: string
    topic: string
    payload: unknown
    source: string
    timestamp: number
    replyTo?: string
}

export interface QueuedRequest {
    id: string
    userId: string
    channel: string
    content: string
    priority: number
    createdAt: number
    startedAt?: number
    timeout: number
}

// ============================================
// State Machine
// ============================================

export class NovaStateMachine extends EventEmitter {
    private currentState: NovaState = 'idle'
    private history: StateTransition[] = []
    private stateStartTime: number = Date.now()

    getState(): NovaState {
        return this.currentState
    }

    getStateDuration(): number {
        return Date.now() - this.stateStartTime
    }

    transition(to: NovaState, reason?: string): boolean {
        const validTransitions: Record<NovaState, NovaState[]> = {
            idle: ['working', 'maintenance', 'error'],
            working: ['idle', 'waiting', 'error'],
            waiting: ['working', 'idle', 'error'],
            error: ['idle', 'maintenance'],
            maintenance: ['idle'],
        }

        if (!validTransitions[this.currentState].includes(to)) {
            console.warn(`[L03 State] Invalid: ${this.currentState} → ${to}`)
            return false
        }

        const transition: StateTransition = {
            from: this.currentState,
            to,
            timestamp: Date.now(),
            reason,
        }

        this.history.push(transition)
        if (this.history.length > 100) this.history.shift()

        console.log(`[L03 State] ${this.currentState} → ${to}${reason ? ` (${reason})` : ''}`)
        this.currentState = to
        this.stateStartTime = Date.now()

        this.emit('transition', transition)
        return true
    }

    isIdle(): boolean {
        return this.currentState === 'idle'
    }

    isWorking(): boolean {
        return this.currentState === 'working'
    }

    getHistory(limit = 10): StateTransition[] {
        return this.history.slice(-limit)
    }
}

// ============================================
// Message Bus (Pub/Sub)
// ============================================

export class MessageBus extends EventEmitter {
    private subscribers: Map<string, Set<(msg: BusMessage) => void>> = new Map()
    private messageLog: BusMessage[] = []

    subscribe(topic: string, handler: (msg: BusMessage) => void): () => void {
        if (!this.subscribers.has(topic)) {
            this.subscribers.set(topic, new Set())
        }
        this.subscribers.get(topic)!.add(handler)

        // Return unsubscribe function
        return () => {
            this.subscribers.get(topic)?.delete(handler)
        }
    }

    publish(topic: string, payload: unknown, source: string): string {
        const msg: BusMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            topic,
            payload,
            source,
            timestamp: Date.now(),
        }

        this.messageLog.push(msg)
        if (this.messageLog.length > 1000) this.messageLog.shift()

        const handlers = this.subscribers.get(topic)
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(msg)
                } catch (err) {
                    console.error(`[L03 Bus] Handler error for ${topic}:`, err)
                }
            }
        }

        // Wildcard subscribers
        const wildcardHandlers = this.subscribers.get('*')
        if (wildcardHandlers) {
            for (const handler of wildcardHandlers) {
                try {
                    handler(msg)
                } catch (err) {
                    console.error(`[L03 Bus] Wildcard handler error:`, err)
                }
            }
        }

        this.emit('message', msg)
        return msg.id
    }

    getRecentMessages(limit = 50): BusMessage[] {
        return this.messageLog.slice(-limit)
    }
}

// ============================================
// Request Queue
// ============================================

export class RequestQueue {
    private queue: QueuedRequest[] = []
    private processing: QueuedRequest | null = null
    private processHandler?: (req: QueuedRequest) => Promise<void>

    setProcessor(handler: (req: QueuedRequest) => Promise<void>): void {
        this.processHandler = handler
    }

    enqueue(request: Omit<QueuedRequest, 'id' | 'createdAt'>): string {
        const req: QueuedRequest = {
            ...request,
            id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            createdAt: Date.now(),
        }

        // Insert by priority (higher first)
        const insertIndex = this.queue.findIndex(r => r.priority < req.priority)
        if (insertIndex === -1) {
            this.queue.push(req)
        } else {
            this.queue.splice(insertIndex, 0, req)
        }

        console.log(`[L03 Queue] Enqueued: ${req.id} (priority: ${req.priority}, queue: ${this.queue.length})`)
        this.processNext()

        return req.id
    }

    private async processNext(): Promise<void> {
        if (this.processing || this.queue.length === 0 || !this.processHandler) {
            return
        }

        this.processing = this.queue.shift()!
        this.processing.startedAt = Date.now()

        console.log(`[L03 Queue] Processing: ${this.processing.id}`)

        try {
            await Promise.race([
                this.processHandler(this.processing),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout')), this.processing!.timeout)
                ),
            ])
        } catch (err) {
            console.error(`[L03 Queue] Error processing ${this.processing.id}:`, err)
        } finally {
            this.processing = null
            this.processNext()
        }
    }

    getQueueLength(): number {
        return this.queue.length
    }

    isProcessing(): boolean {
        return this.processing !== null
    }

    getCurrentRequest(): QueuedRequest | null {
        return this.processing
    }

    clear(): void {
        this.queue = []
    }
}

// ============================================
// Watchdog (Hang Detection)
// ============================================

export class Watchdog {
    private lastActivity: number = Date.now()
    private interval?: NodeJS.Timeout
    private hangThreshold: number
    private onHangDetected?: () => void
    private stateGetter?: () => NovaState

    constructor(hangThresholdMs = 300000) {
        this.hangThreshold = hangThresholdMs
    }

    setHangHandler(handler: () => void): void {
        this.onHangDetected = handler
    }

    setStateGetter(getter: () => NovaState): void {
        this.stateGetter = getter
    }

    ping(): void {
        this.lastActivity = Date.now()
    }

    start(checkIntervalMs = 30000): void {
        this.interval = setInterval(() => {
            const currentState = this.stateGetter?.()
            // Only detect hangs when actively working or waiting — idle is normal
            if (currentState === 'idle' || currentState === 'maintenance') {
                this.ping() // Reset timer during idle
                return
            }

            const elapsed = Date.now() - this.lastActivity
            if (elapsed > this.hangThreshold) {
                console.log(`[L03 Watchdog] ⚠️ Potential hang detected (${elapsed}ms in state '${currentState}')`)
                this.onHangDetected?.()
            }
        }, checkIntervalMs)
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval)
            this.interval = undefined
        }
    }

    getLastActivity(): number {
        return this.lastActivity
    }
}

// ============================================
// Core Runtime (Combines All)
// ============================================

export class CoreRuntime {
    readonly state: StateMachine
    readonly bus: MessageBus
    readonly queue: RequestQueue
    readonly watchdog: Watchdog

    constructor() {
        this.state = getStateMachine()
        this.bus = new MessageBus()
        this.queue = new RequestQueue()
        this.watchdog = new Watchdog(300000) // 5 min threshold

        // Give watchdog access to current state
        this.watchdog.setStateGetter(() => {
            const state = this.state.getState()
            if (state === 'thinking' || state === 'executing') return 'working'
            return state as NovaState
        })

        // Wire up state changes to bus
        this.state.onStateChange((from, to, reason) => {
            this.bus.publish('state.transition', { from, to, reason, timestamp: Date.now() }, 'core-runtime')
            this.watchdog.ping()
        })

        // Watchdog hang recovery — only triggers when stuck in working/waiting
        this.watchdog.setHangHandler(() => {
            this.bus.publish('system.hang', { timestamp: Date.now() }, 'watchdog')
            if (this.state.isBusy()) {
                this.state.fail('Hang detected by watchdog')
                this.state.recover('Recovered from hang')
            }
        })
    }

    start(): void {
        this.watchdog.start()
        console.log('[L03 CoreRuntime] ✓ Started')
    }

    stop(): void {
        this.watchdog.stop()
        this.queue.clear()
        console.log('[L03 CoreRuntime] Stopped')
    }

    getStatus() {
        return {
            state: this.state.getState(),
            stateDuration: this.state.getStateInfo().duration,
            queueLength: this.queue.getQueueLength(),
            isProcessing: this.queue.isProcessing(),
            lastActivity: this.watchdog.getLastActivity(),
        }
    }
}

// ============================================
// Singleton & Export
// ============================================

let coreRuntime: CoreRuntime | null = null

export function getCoreRuntime(): CoreRuntime {
    if (!coreRuntime) {
        coreRuntime = new CoreRuntime()
    }
    return coreRuntime
}

export default {
    CoreRuntime,
    NovaStateMachine,
    MessageBus,
    RequestQueue,
    Watchdog,
    getCoreRuntime,
}
