/**
 * Nova State Store — centralized state management
 *
 * Replaces scattered (globalThis as any).__novaState mutations
 * with a typed, centralized store.
 */

export interface NovaStateStore {
    // Core
    running: boolean
    runtimeReady: boolean
    startTime: number
    version: string
    // LLMs
    llm: any
    internalLlm: any
    // Channels
    lastActiveChatId: string | null
    adminChatId: string | null
    // Session tracking
    lastActiveUserId: string | null
    // Config
    config: Record<string, any> | null
    hardwareRole: Record<string, any> | null
    // Subsystems (set by daemon during init)
    memory: any
    learning: any
    learningCoordinator: any
    tools: any
    resilience: any
    orchestrator: any
    intelligence: any
    journal: any
    lanceMemory: any
    knowledgeGraph: any
    correctionLearner: any
    metaLearning: any
    // Per-message context (cleared between messages)
    __userContext: string | null
    __groupContext: string | null
    __userPermission: string | null
    __userId: string | null
    // Misc
    [key: string]: any
}

const _state: NovaStateStore = {
    running: false,
    runtimeReady: false,
    startTime: Date.now(),
    version: '0.0.0',
    llm: null,
    internalLlm: null,
    lastActiveChatId: null,
    adminChatId: null,
    lastActiveUserId: null,
    config: null,
    hardwareRole: null,
    memory: null,
    learning: null,
    learningCoordinator: null,
    tools: null,
    resilience: null,
    orchestrator: null,
    intelligence: null,
    journal: null,
    lanceMemory: null,
    knowledgeGraph: null,
    correctionLearner: null,
    metaLearning: null,
    __userContext: null,
    __groupContext: null,
    __userPermission: null,
    __userId: null,
}

/**
 * Get the global Nova state store.
 * Use this instead of (globalThis as any).__novaState
 */
export function getNovaState(): NovaStateStore {
    return _state
}

/**
 * Update specific fields in the state store.
 */
export function updateNovaState(updates: Partial<NovaStateStore>): void {
    Object.assign(_state, updates)
}

/**
 * Initialize the global state (also sets globalThis.__novaState for legacy compat).
 * Call this once during daemon startup.
 */
export function initNovaState(initial: Partial<NovaStateStore>): NovaStateStore {
    Object.assign(_state, initial)
    // Maintain backward compat with code that still uses globalThis
    ;(globalThis as any).__novaState = _state
    return _state
}

/**
 * Get a specific field from the state store.
 */
export function getNovaStateField<K extends keyof NovaStateStore>(key: K): NovaStateStore[K] {
    return _state[key]
}
