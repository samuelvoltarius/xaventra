/**
 * Tool Loop Detection v2
 *
 * Smarter than v1: progressive warnings, timeout tracking,
 * and graceful degradation instead of hard stops.
 *
 * Key changes:
 * - First hit = warning (soft), second hit = stop (hard)
 * - Timeout-based stall detection (not just repeat counting)
 * - Returns user-friendly messages, never causes silence
 * - Tracks which tools are slow vs looping
 */

// ============================================
// Types
// ============================================

export interface LoopDetectionConfig {
    /** Max times same tool+args can repeat before WARNING. Default: 2 */
    maxRepeatCalls: number
    /** Max total tool calls per message turn. Default: 25 */
    maxCallsPerTurn: number
    /** Window size for repeat detection. Default: 10 */
    windowSize: number
    /** Max time in ms for a single tool call. Default: 30000 */
    toolTimeoutMs: number
    /** Hard limit: absolute max calls no matter what. Default: 40 */
    absoluteMaxCalls: number
}

export const DEFAULT_LOOP_CONFIG: LoopDetectionConfig = {
    maxRepeatCalls: 2,
    maxCallsPerTurn: 25,
    windowSize: 10,
    toolTimeoutMs: 30000,
    absoluteMaxCalls: 40,
}

// Tool-specific repeat limits: some tools legitimately repeat
const TOOL_REPEAT_LIMITS: Record<string, number> = {
    readfile: 4,
    read_file: 4,
    listdir: 4,
    list_dir: 4,
    list_directory: 4,
    run_command: 3,
    fetchurl: 2,
    fetch_url: 2,
    search: 2,
    codebase_search: 2,
    get_weather: 2,
}

// Tools that are expected to be slow (don't timeout-warn on these)
const SLOW_TOOLS = new Set([
    'self_evolve', 'auto_fix', 'auto_provision',
    'run_command', 'ollama_chat', 'mesh_exec',
])

interface ToolCallRecord {
    tool: string
    argsHash: string
    timestamp: number
    durationMs?: number
}

type LoopSeverity = 'warning' | 'stop'

interface LoopResult {
    message: string
    severity: LoopSeverity
    tool: string
    reason: string
}

// ============================================
// Loop Detector v2
// ============================================

export class LoopDetector {
    private config: LoopDetectionConfig
    private history: ToolCallRecord[] = []
    private turnCallCount = 0
    private warnings = new Set<string>()  // Track which warnings were already shown
    private turnStartTime = Date.now()
    private stallCount = 0  // How many times we hit a loop condition
    private failedChains: Array<{ sequence: string; timestamp: number; reason: string }> = []

    constructor(config: Partial<LoopDetectionConfig> = {}) {
        this.config = { ...DEFAULT_LOOP_CONFIG, ...config }
    }

    /**
     * Record a tool call and check for loops.
     * Returns null if OK, or a LoopResult with severity.
     */
    recordCall(tool: string, args?: Record<string, unknown>): string | null {
        this.turnCallCount++
        const argsHash = args ? this.hashArgs(args) : 'no-args'
        const callKey = `${tool}:${argsHash}`

        this.history.push({
            tool,
            argsHash,
            timestamp: Date.now(),
        })

        // Keep history bounded
        if (this.history.length > this.config.windowSize * 2) {
            this.history = this.history.slice(-this.config.windowSize)
        }

        // ==============================
        // Check 0: Repeating a recently-failed chain
        // ==============================
        if (this.history.length >= 3) {
            const recentTools = this.history.slice(-3).map(r => r.tool)
            recentTools.push(tool)
            const chainStr = recentTools.join('->')
            const recentFailure = this.failedChains.find(fc =>
                fc.sequence.includes(chainStr) && (Date.now() - fc.timestamp) < 120_000
            )
            if (recentFailure) {
                return `🛑 Gleiche fehlgeschlagene Tool-Kette wie vorher (${chainStr}). Breche ab: ${recentFailure.reason}`
            }
        }

        // ==============================
        // Check 1: Absolute hard limit
        // ==============================
        if (this.turnCallCount > this.config.absoluteMaxCalls) {
            return this.formatStop(tool,
                `Absolutes Limit erreicht (${this.turnCallCount} Aufrufe). Ich beantworte deine Frage jetzt direkt.`)
        }

        // ==============================
        // Check 2: Same tool+args repeated
        // ==============================
        const recent = this.history.slice(-this.config.windowSize)
        const repeatCount = recent.filter(r => r.tool === tool && r.argsHash === argsHash).length
        const limit =
            this.config.maxRepeatCalls === DEFAULT_LOOP_CONFIG.maxRepeatCalls
                ? (TOOL_REPEAT_LIMITS[tool.toLowerCase()] ?? this.config.maxRepeatCalls)
                : this.config.maxRepeatCalls

        if (repeatCount >= limit) {
            const warningKey = `repeat:${callKey}`

            if (this.warnings.has(warningKey)) {
                // Second offense → hard stop
                return this.formatStop(tool,
                    `"${tool}" wurde ${repeatCount}× mit gleichen Argumenten versucht. Ich versuche jetzt einen anderen Ansatz.`)
            }

            // First offense → warning (tool gets skipped but turn continues)
            this.warnings.add(warningKey)
            this.stallCount++
            return this.formatWarning(tool,
                `"${tool}" wiederholt sich (${repeatCount}×). Ueberspringe und versuche Alternative.`)
        }

        // ==============================
        // Check 3: Too many calls with low diversity
        // ==============================
        if (this.turnCallCount > this.config.maxCallsPerTurn) {
            const uniqueOps = new Set(this.history.map(r => `${r.tool}:${r.argsHash}`)).size
            const diversityRatio = uniqueOps / this.turnCallCount

            if (this.config.maxCallsPerTurn < DEFAULT_LOOP_CONFIG.maxCallsPerTurn) {
                return this.formatStop(tool,
                    `Loop: Limit erreicht (${this.turnCallCount} Tool-Aufrufe). Ich antworte dir jetzt direkt.`)
            }

            // High diversity = legitimate multi-step work
            if (diversityRatio >= 0.5) {
                // Allow up to absolute max
                return null
            }

            // Low diversity = looping
            if (diversityRatio < 0.3) {
                return this.formatStop(tool,
                    `${this.turnCallCount} Tool-Aufrufe mit wenig Vielfalt. Ich antworte dir jetzt direkt.`)
            }

            // Medium diversity = warn once
            const warningKey = 'diversity-warn'
            if (!this.warnings.has(warningKey)) {
                this.warnings.add(warningKey)
                // Don't return a warning - just log
                console.log(`[LoopDetect] ${this.turnCallCount} calls, diversity ${(diversityRatio * 100).toFixed(0)}% — monitoring`)
            }
        }

        // ==============================
        // Check 4: Alternating pattern (A→B→A→B→A→B)
        // ==============================
        if (recent.length >= 6) {
            const last6 = recent.slice(-6)
            const isAlternating =
                last6[0].tool === last6[2].tool && last6[2].tool === last6[4].tool &&
                last6[1].tool === last6[3].tool && last6[3].tool === last6[5].tool &&
                last6[0].tool !== last6[1].tool

            // Only the exact same args pattern (not just tool names)
            const argsAlternating =
                last6[0].argsHash === last6[2].argsHash && last6[2].argsHash === last6[4].argsHash &&
                last6[1].argsHash === last6[3].argsHash && last6[3].argsHash === last6[5].argsHash

            if (isAlternating && argsAlternating) {
                return this.formatStop(tool,
                    `"${last6[0].tool}" und "${last6[1].tool}" wechseln sich ab — Endlosschleife. Ich antworte direkt.`)
            }
        }

        // ==============================
        // Check 5: Turn taking too long (> 90s)
        // ==============================
        const turnDuration = Date.now() - this.turnStartTime
        if (turnDuration > 90000 && this.turnCallCount > 10) {
            const warningKey = 'timeout-warn'
            if (!this.warnings.has(warningKey)) {
                this.warnings.add(warningKey)
                console.log(`[LoopDetect] Turn running ${(turnDuration / 1000).toFixed(0)}s with ${this.turnCallCount} calls — monitoring`)
            }
            if (turnDuration > 180000) {
                return this.formatStop(tool,
                    `Turn laeuft seit ${(turnDuration / 1000).toFixed(0)}s — zu lang. Ich fasse zusammen.`)
            }
        }

        return null
    }

    /**
     * Check if a tool call is likely to timeout (for pre-check).
     */
    isToolSlow(tool: string): boolean {
        return SLOW_TOOLS.has(tool.toLowerCase())
    }

    /**
     * Record tool completion time (for learning which tools are slow).
     */
    recordDuration(tool: string, durationMs: number): void {
        const last = [...this.history].reverse().find(r => r.tool === tool)
        if (last) last.durationMs = durationMs
    }

    recordChainFailure(toolNames: string[], reason: string): void {
        const sequence = toolNames.join('->')
        this.failedChains.push({ sequence, timestamp: Date.now(), reason })
        // Keep only last 10 failures
        if (this.failedChains.length > 10) {
            this.failedChains = this.failedChains.slice(-10)
        }
        console.log(`[LoopDetector] Recorded failed chain: ${sequence} — ${reason}`)
    }

    private formatWarning(tool: string, message: string): string {
        return `⚠️ ${message}`
    }

    private formatStop(tool: string, message: string): string {
        return `🛑 ${message}`
    }

    /**
     * Reset for a new message turn.
     */
    resetTurn(): void {
        this.turnCallCount = 0
        this.warnings.clear()
        this.stallCount = 0
        this.turnStartTime = Date.now()
    }

    /**
     * Full reset.
     */
    reset(): void {
        this.history = []
        this.turnCallCount = 0
        this.warnings.clear()
        this.stallCount = 0
        this.turnStartTime = Date.now()
    }

    /**
     * Get stats for debugging.
     */
    getStats(): { turnCalls: number; historySize: number; lastTool?: string; stallCount: number; turnDurationMs: number } {
        return {
            turnCalls: this.turnCallCount,
            historySize: this.history.length,
            lastTool: this.history[this.history.length - 1]?.tool,
            stallCount: this.stallCount,
            turnDurationMs: Date.now() - this.turnStartTime,
        }
    }

    /**
     * Simple hash for argument comparison.
     */
    private hashArgs(args: Record<string, unknown>): string {
        try {
            const sorted = JSON.stringify(args, Object.keys(args).sort())
            let hash = 0
            for (let i = 0; i < sorted.length; i++) {
                const char = sorted.charCodeAt(i)
                hash = ((hash << 5) - hash) + char
                hash |= 0
            }
            return hash.toString(36)
        } catch {
            return 'hash-error'
        }
    }
}

// ============================================
// Singleton
// ============================================

let globalDetector: LoopDetector | null = null

export function getLoopDetector(config?: Partial<LoopDetectionConfig>): LoopDetector {
    if (!globalDetector) {
        globalDetector = new LoopDetector(config)
    }
    return globalDetector
}

export default { LoopDetector, getLoopDetector, DEFAULT_LOOP_CONFIG }
