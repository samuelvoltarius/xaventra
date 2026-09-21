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
    /** Active top-level requests. A process-wide state may return to idle only
     * after every admitted request has reached its terminal boundary. */
    private readonly activeOperations = new Map<string, { reason?: string; startedAt: number }>()
    private readonly operationFailures: string[] = []

    // ============================================
    // State Access
    // ============================================

    getState(): NovaState {
        return this.currentState
    }

    getStateInfo(): { state: NovaState; since: number; duration: number; activeOperations: number } {
        const since = this.stateTimestamps[this.currentState]
        return {
            state: this.currentState,
            since,
            duration: Date.now() - since,
            activeOperations: this.activeOperations.size,
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

        // No observer, watchdog or legacy caller may declare the process idle
        // while a separately admitted request is still running.
        if (to === 'idle' && this.activeOperations.size > 0) {
            console.warn(`[StateMachine] Refusing idle with ${this.activeOperations.size} active operation(s)`)
            return false
        }

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
    // Top-level operation authority
    // ============================================

    beginOperation(operationId: string, reason?: string): boolean {
        const id = operationId.trim()
        if (!id || this.activeOperations.has(id) || this.isError()) return false
        this.activeOperations.set(id, { reason, startedAt: Date.now() })
        if (this.isIdle() && !this.startThinking(reason || `operation:${id}`)) {
            this.activeOperations.delete(id)
            return false
        }
        return true
    }

    completeOperation(operationId: string, error?: string): boolean {
        const id = operationId.trim()
        if (!this.activeOperations.delete(id)) return false
        if (error) this.operationFailures.push(error.slice(0, 200))

        // An earlier request must not return the shared runtime to idle while a
        // later request still owns an operation lease.
        if (this.activeOperations.size > 0) return true

        const failure = this.operationFailures.shift()
        this.operationFailures.length = 0
        if (failure) {
            if (!this.isError()) this.fail(failure)
            if (this.isError()) this.recover('all active operations completed after error')
            return true
        }
        if (!this.isIdle()) this.finish('all active operations completed')
        return true
    }

    hasOperation(operationId: string): boolean {
        return this.activeOperations.has(operationId)
    }

    getActiveOperationCount(): number {
        return this.activeOperations.size
    }

    /** Test/process reinitialization without replacing the singleton object.
     * CoreRuntime and observers therefore keep the same authority reference. */
    reset(): void {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle)
        this.timeoutHandle = null
        this.currentState = 'idle'
        this.history = []
        this.activeOperations.clear()
        this.operationFailures.length = 0
        const now = Date.now()
        this.stateTimestamps = { idle: now, thinking: 0, executing: 0, waiting: 0, error: 0 }
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
    globalStateMachine?.reset()
}
