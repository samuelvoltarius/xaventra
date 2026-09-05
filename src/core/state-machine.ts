/**
 * Nova - Core State Machine
 * 
 * Layer 03: Manages Nova's operational state
 * Prevents system hangs through explicit state transitions
 */

// ============================================
// Types
// ============================================

export type NovaState =
    | 'idle'       // Waiting for input
    | 'thinking'   // Processing with LLM
    | 'executing'  // Running tools
    | 'waiting'    // Waiting for external response
    | 'error'      // Error state, needs recovery

export interface StateTransition {
    from: NovaState
    to: NovaState
    timestamp: number
    reason?: string
}

export type StateChangeHandler = (from: NovaState, to: NovaState, reason?: string) => void

// ============================================
// State Machine Class
// ============================================

export class StateMachine {
    private currentState: NovaState = 'idle'
    private history: StateTransition[] = []
    private handlers: StateChangeHandler[] = []
    private stateTimestamps: Record<NovaState, number> = {
        idle: Date.now(),
        thinking: 0,
        executing: 0,
        waiting: 0,
        error: 0,
    }

    // Timeout configurations (ms)
    private readonly timeouts: Record<NovaState, number> = {
        idle: 0,           // No timeout for idle
        thinking: 120000,  // 2 minutes max for LLM
        executing: 300000, // 5 minutes max for tools
        waiting: 600000,   // 10 minutes max waiting
        error: 30000,      // 30 seconds before auto-recovery
    }

    private timeoutHandle: NodeJS.Timeout | null = null

    // ============================================
    // State Access
    // ============================================

    getState(): NovaState {
        return this.currentState
    }

    getStateInfo(): { state: NovaState; since: number; duration: number } {
        const since = this.stateTimestamps[this.currentState]
        return {
            state: this.currentState,
            since,
            duration: Date.now() - since,
        }
    }

    getHistory(limit: number = 10): StateTransition[] {
        return this.history.slice(-limit)
    }

    // ============================================
    // State Transitions
    // ============================================

    transition(to: NovaState, reason?: string): boolean {
        const from = this.currentState

        // Validate transition
        if (!this.isValidTransition(from, to)) {
            console.warn(`[StateMachine] Invalid transition: ${from} -> ${to}`)
            return false
        }

        // Clear existing timeout
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle)
            this.timeoutHandle = null
        }

        // Record transition
        const transition: StateTransition = {
            from,
            to,
            timestamp: Date.now(),
            reason,
        }
        this.history.push(transition)

        // Update state
        this.currentState = to
        this.stateTimestamps[to] = Date.now()

        console.log(`[StateMachine] ${from} -> ${to}${reason ? ` (${reason})` : ''}`)

        // Notify handlers
        for (const handler of this.handlers) {
            try {
                handler(from, to, reason)
            } catch (err) {
                console.error(`[StateMachine] Handler error: ${err}`)
            }
        }

        // Set timeout for new state
        this.setupTimeout(to)

        return true
    }

    private isValidTransition(from: NovaState, to: NovaState): boolean {
        // Define valid transitions
        const validTransitions: Record<NovaState, NovaState[]> = {
            idle: ['thinking', 'error'],
            thinking: ['executing', 'idle', 'error'],
            executing: ['thinking', 'waiting', 'idle', 'error'],
            waiting: ['thinking', 'executing', 'idle', 'error'],
            error: ['idle'],  // Can only recover to idle
        }

        return validTransitions[from]?.includes(to) ?? false
    }

    private setupTimeout(state: NovaState): void {
        const timeout = this.timeouts[state]
        if (timeout <= 0) return

        this.timeoutHandle = setTimeout(() => {
            console.warn(`[StateMachine] State "${state}" timed out after ${timeout}ms`)

            if (state === 'error') {
                // Auto-recover from error
                this.transition('idle', 'auto-recovery from timeout')
            } else {
                // Transition to error on timeout
                this.transition('error', `timeout in ${state}`)
            }
        }, timeout)
    }

    // ============================================
    // Event Handling
    // ============================================

    onStateChange(handler: StateChangeHandler): () => void {
        this.handlers.push(handler)
        return () => {
            const index = this.handlers.indexOf(handler)
            if (index >= 0) this.handlers.splice(index, 1)
        }
    }

    // ============================================
    // Convenience Methods
    // ============================================

    startThinking(reason?: string): boolean {
        return this.transition('thinking', reason)
    }

    startExecuting(reason?: string): boolean {
        return this.transition('executing', reason)
    }

    startWaiting(reason?: string): boolean {
        return this.transition('waiting', reason)
    }

    finish(reason?: string): boolean {
        return this.transition('idle', reason)
    }

    fail(reason?: string): boolean {
        return this.transition('error', reason)
    }

    recover(reason?: string): boolean {
        return this.transition('idle', reason || 'manual recovery')
    }

    // ============================================
    // Status
    // ============================================

    isIdle(): boolean { return this.currentState === 'idle' }
    isThinking(): boolean { return this.currentState === 'thinking' }
    isExecuting(): boolean { return this.currentState === 'executing' }
    isWaiting(): boolean { return this.currentState === 'waiting' }
    isError(): boolean { return this.currentState === 'error' }
    isBusy(): boolean { return !this.isIdle() && !this.isError() }
}

// ============================================
// Singleton Instance
// ============================================

let globalStateMachine: StateMachine | null = null

export function getStateMachine(): StateMachine {
    if (!globalStateMachine) {
        globalStateMachine = new StateMachine()
    }
    return globalStateMachine
}

export function resetStateMachine(): void {
    globalStateMachine = null
}
