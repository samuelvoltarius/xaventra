/**
 * Nova - Context Window Guard
 * 
 * Prevents context overflow by tracking and limiting tokens.
 */

// ============================================
// Types
// ============================================

export interface ContextConfig {
    maxTokens: number         // Max context window size
    reservedTokens: number    // Reserve for response
    warningThreshold: number  // Warn at this % (0-1)
}

export interface TokenCount {
    messages: number
    system: number
    tools: number
    total: number
}

// ============================================
// Simple Token Estimator
// ============================================

function estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English
    // More accurate would use tiktoken or similar
    return Math.ceil(text.length / 4)
}

// ============================================
// Context Window Guard
// ============================================

export class ContextGuard {
    private config: ContextConfig
    private currentTokens: TokenCount = { messages: 0, system: 0, tools: 0, total: 0 }

    constructor(config: Partial<ContextConfig> = {}) {
        this.config = {
            maxTokens: 128000,      // Default: 128k (GPT-4)
            reservedTokens: 4096,   // Reserve for response
            warningThreshold: 0.8,
            ...config,
        }
    }

    // ============================================
    // Token Counting
    // ============================================

    countMessage(content: string): number {
        return estimateTokens(content)
    }

    countMessages(messages: Array<{ content: string }>): number {
        return messages.reduce((sum, m) => sum + this.countMessage(m.content), 0)
    }

    // ============================================
    // Capacity Checking
    // ============================================

    getAvailableTokens(): number {
        return this.config.maxTokens - this.config.reservedTokens - this.currentTokens.total
    }

    getUsagePercent(): number {
        return this.currentTokens.total / this.config.maxTokens
    }

    isNearLimit(): boolean {
        return this.getUsagePercent() >= this.config.warningThreshold
    }

    wouldOverflow(additionalTokens: number): boolean {
        return (this.currentTokens.total + additionalTokens) >
            (this.config.maxTokens - this.config.reservedTokens)
    }

    // ============================================
    // Tracking
    // ============================================

    track(type: 'messages' | 'system' | 'tools', tokens: number): void {
        this.currentTokens[type] += tokens
        this.currentTokens.total =
            this.currentTokens.messages +
            this.currentTokens.system +
            this.currentTokens.tools

        if (this.isNearLimit()) {
            console.warn(`[ContextGuard] ⚠️ Near limit: ${Math.round(this.getUsagePercent() * 100)}%`)
        }
    }

    reset(): void {
        this.currentTokens = { messages: 0, system: 0, tools: 0, total: 0 }
    }

    // ============================================
    // Message Truncation
    // ============================================

    truncateMessages<T extends { content: string }>(
        messages: T[],
        keepLast = 10
    ): { messages: T[]; removed: number } {
        if (!this.isNearLimit()) {
            return { messages, removed: 0 }
        }

        const available = this.getAvailableTokens()
        const result: T[] = []
        let currentSize = 0
        let removed = 0

        // Always keep the most recent messages
        const reversed = [...messages].reverse()

        for (const msg of reversed) {
            const tokens = this.countMessage(msg.content)

            if (currentSize + tokens <= available || result.length < keepLast) {
                result.unshift(msg)
                currentSize += tokens
            } else {
                removed++
            }
        }

        if (removed > 0) {
            console.log(`[ContextGuard] Truncated ${removed} messages to fit context`)
        }

        return { messages: result, removed }
    }

    /**
     * Summarize old messages to save tokens.
     * Returns a summary message to replace truncated ones.
     */
    createSummaryPlaceholder(removedCount: number): string {
        return `[${removedCount} frühere Nachrichten wurden zusammengefasst um Platz zu sparen]`
    }

    // ============================================
    // Status
    // ============================================

    getStatus(): {
        maxTokens: number
        usedTokens: number
        availableTokens: number
        usagePercent: number
        breakdown: TokenCount
        nearLimit: boolean
    } {
        return {
            maxTokens: this.config.maxTokens,
            usedTokens: this.currentTokens.total,
            availableTokens: this.getAvailableTokens(),
            usagePercent: Math.round(this.getUsagePercent() * 100),
            breakdown: { ...this.currentTokens },
            nearLimit: this.isNearLimit(),
        }
    }

    // ============================================
    // Model Presets
    // ============================================

    static forModel(model: string): ContextGuard {
        const contexts: Record<string, number> = {
            // Current models (2026)
            'gpt-4o-mini': 128000,
            'gpt-4o': 128000,
            'gpt-4-turbo': 128000,
            'claude-sonnet-4-6': 200000,
            'claude-opus-4-6': 200000,
            'gpt-oss': 128000,
            'o3': 200000,
            'claude-3': 200000,
            'llama3': 128000,
        }

        // Find matching model
        const lowerModel = model.toLowerCase()
        for (const [key, maxTokens] of Object.entries(contexts)) {
            if (lowerModel.includes(key)) {
                return new ContextGuard({ maxTokens })
            }
        }

        // Default
        return new ContextGuard({ maxTokens: 128000 })
    }
}

// ============================================
// Factory
// ============================================

export function createContextGuard(config?: Partial<ContextConfig>): ContextGuard {
    return new ContextGuard(config)
}

export default { ContextGuard, createContextGuard }
