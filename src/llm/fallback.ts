/**
 * Nova - Model Fallback System
 * 
 * Automatically switches to backup providers when primary fails.
 */

import type { BaseLLM } from './base.js'

// ============================================
// Types
// ============================================

export interface FallbackConfig {
    maxRetries: number
    retryDelayMs: number
    backoffMultiplier: number
}

export interface ProviderStatus {
    name: string
    available: boolean
    lastError?: string
    lastCheck: number
    consecutiveFailures: number
}

// ============================================
// Model Fallback Manager
// ============================================

export class ModelFallback {
    private providers: Map<string, BaseLLM> = new Map()
    private providerOrder: string[] = []
    private status: Map<string, ProviderStatus> = new Map()
    private config: FallbackConfig

    constructor(config: Partial<FallbackConfig> = {}) {
        this.config = {
            maxRetries: 3,
            retryDelayMs: 1000,
            backoffMultiplier: 2,
            ...config,
        }
    }

    // ============================================
    // Provider Management
    // ============================================

    addProvider(name: string, llm: BaseLLM, priority = 0): void {
        this.providers.set(name, llm)
        this.status.set(name, {
            name,
            available: true,
            lastCheck: Date.now(),
            consecutiveFailures: 0,
        })

        // Insert by priority (lower = higher priority)
        const insertIndex = this.providerOrder.findIndex((_, i) => i >= priority)
        if (insertIndex === -1) {
            this.providerOrder.push(name)
        } else {
            this.providerOrder.splice(insertIndex, 0, name)
        }

        console.log(`[Fallback] Added provider: ${name} (priority: ${priority})`)
    }

    removeProvider(name: string): void {
        this.providers.delete(name)
        this.status.delete(name)
        this.providerOrder = this.providerOrder.filter(n => n !== name)
    }

    getProvider(name: string): BaseLLM | undefined {
        return this.providers.get(name)
    }

    // ============================================
    // Fallback Execution
    // ============================================

    async execute<T>(
        operation: (llm: BaseLLM, providerName: string) => Promise<T>
    ): Promise<{ result: T; provider: string }> {
        const errors: string[] = []

        for (const providerName of this.providerOrder) {
            const llm = this.providers.get(providerName)
            const status = this.status.get(providerName)

            if (!llm || !status) continue

            // Skip if too many consecutive failures (cooldown)
            if (status.consecutiveFailures >= 3) {
                const cooldownMs = 60000 * status.consecutiveFailures
                if (Date.now() - status.lastCheck < cooldownMs) {
                    console.log(`[Fallback] Skipping ${providerName} (cooldown)`)
                    continue
                }
            }

            // Try this provider with retries
            for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
                try {
                    console.log(`[Fallback] Trying ${providerName} (attempt ${attempt})`)
                    const result = await operation(llm, providerName)

                    // Success - reset failure count
                    status.available = true
                    status.consecutiveFailures = 0
                    status.lastCheck = Date.now()

                    return { result, provider: providerName }

                } catch (err) {
                    const error = err instanceof Error ? err.message : String(err)
                    errors.push(`${providerName}: ${error}`)
                    console.log(`[Fallback] ${providerName} failed: ${error}`)

                    status.lastError = error
                    status.lastCheck = Date.now()

                    // Wait before retry
                    if (attempt < this.config.maxRetries) {
                        const delay = this.config.retryDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1)
                        await new Promise(r => setTimeout(r, delay))
                    }
                }
            }

            // All retries failed for this provider
            status.consecutiveFailures++
            status.available = false
        }

        throw new Error(`All providers failed:\n${errors.join('\n')}`)
    }

    // ============================================
    // Status
    // ============================================

    getStatus(): ProviderStatus[] {
        return Array.from(this.status.values())
    }

    getAvailableProviders(): string[] {
        return this.providerOrder.filter(name => {
            const status = this.status.get(name)
            return status?.available !== false
        })
    }

    async checkHealth(): Promise<Record<string, boolean>> {
        const results: Record<string, boolean> = {}

        for (const [name, llm] of this.providers) {
            try {
                results[name] = await llm.isAvailable()
            } catch {
                results[name] = false
            }
        }

        return results
    }
}

// ============================================
// Factory
// ============================================

export function createModelFallback(config?: Partial<FallbackConfig>): ModelFallback {
    return new ModelFallback(config)
}

export default { ModelFallback, createModelFallback }
