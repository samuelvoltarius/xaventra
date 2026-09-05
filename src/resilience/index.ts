/**
 * Nova - Resilience Layer Index
 * 
 * Unified export for all Layer 0 modules
 */

// Error Tracking & Auto-Fix
export {
    ResilienceManager,
    createResilienceManager,
    withResilience,
    type TrackedError,
    type HealthStatus,
    type ComponentHealth,
    type ErrorSeverity,
    type ErrorCategory,
} from './manager.js'

// Output Quality Gate
export {
    OutputValidator,
    createOutputValidator,
    withQualityGate,
    type QualityIssue,
    type QualityIssueType,
    type ValidationResult,
} from './quality-gate.js'

// Honesty Validator
export {
    HonestyValidator,
    createHonestyValidator,
    HONESTY_SYSTEM_PROMPT,
    THINGS_TO_ADMIT,
    admissions,
    type HonestyCheck,
} from './honesty.js'

// Offline Fallback
export {
    FallbackManager,
    createFallbackManager,
    type OperationMode,
    type FallbackState,
} from './fallback.js'

// ============================================
// Combined Layer 0 Controller
// ============================================

import { ResilienceManager } from './manager.js'
import { OutputValidator } from './quality-gate.js'
import { HonestyValidator, HONESTY_SYSTEM_PROMPT } from './honesty.js'
import { FallbackManager } from './fallback.js'

export interface Layer0Config {
    strictQuality: boolean
    fallbackTimeout: number
    healthCheckInterval: number
}

/**
 * Layer 0 Controller - The "God Layer"
 * 
 * Monitors everything and takes over when Nova fails:
 * - Error detection and auto-fix
 * - Quality validation of outputs
 * - Honesty checking
 * - Fallback mode when LLM fails
 */
export class Layer0Controller {
    readonly resilience: ResilienceManager
    readonly quality: OutputValidator
    readonly honesty: HonestyValidator
    readonly fallback: FallbackManager

    private responseTimeout: number
    private pendingResponse: NodeJS.Timeout | null = null

    constructor(config: Partial<Layer0Config> = {}) {
        this.resilience = new ResilienceManager()
        this.quality = new OutputValidator({ strictMode: config.strictQuality ?? true })
        this.honesty = new HonestyValidator()
        this.fallback = new FallbackManager()
        this.responseTimeout = config.fallbackTimeout ?? 30000
    }

    // ============================================
    // Lifecycle
    // ============================================

    start(): void {
        console.log('[Layer 0] Starting God Layer...')
        this.resilience.start()
        console.log('[Layer 0] Monitoring active')
    }

    stop(): void {
        this.resilience.stop()
        if (this.pendingResponse) {
            clearTimeout(this.pendingResponse)
        }
        console.log('[Layer 0] Stopped')
    }

    // ============================================
    // Message Processing with Timeout
    // ============================================

    /**
     * Process a message with Layer 0 monitoring
     * If LLM takes too long or fails, Layer 0 takes over
     */
    async processWithFallback(
        message: string,
        llmProcess: () => Promise<string>,
    ): Promise<{ response: string; source: 'llm' | 'fallback' | 'layer0' }> {
        // First check if we're in fallback mode
        if (!this.fallback.isOnline()) {
            return {
                response: this.getFallbackResponse(message),
                source: 'fallback',
            }
        }

        // Try LLM with timeout
        try {
            const response = await this.withTimeout(llmProcess(), this.responseTimeout)

            // Validate response quality
            const qualityCheck = this.quality.validate(response)
            const honestyCheck = this.honesty.validate(response)

            if (!qualityCheck.valid) {
                console.warn('[Layer 0] Response failed quality check')
                // Still return it but log warning
            }

            if (!honestyCheck.isHonest) {
                console.warn('[Layer 0] Response has honesty issues:', honestyCheck.warnings)
            }

            return { response, source: 'llm' }

        } catch (err) {
            console.error('[Layer 0] LLM processing failed:', err)

            // Track the error
            await this.resilience.trackError(
                'llm',
                err instanceof Error ? err : new Error(String(err)),
                'high'
            )

            // Layer 0 takes over
            return {
                response: this.getLayer0Response(message, err),
                source: 'layer0',
            }
        }
    }

    // ============================================
    // Timeout Implementation
    // ============================================

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Response timeout after ${timeoutMs}ms`))
            }, timeoutMs)

            promise
                .then((result) => {
                    clearTimeout(timer)
                    resolve(result)
                })
                .catch((err) => {
                    clearTimeout(timer)
                    reject(err)
                })
        })
    }

    // ============================================
    // Fallback Responses
    // ============================================

    private getFallbackResponse(message: string): string {
        const status = this.fallback.getStatusMessage()

        return `⚠️ **Ich bin gerade im Offline-Modus**

${status}

Deine Nachricht: "${message.slice(0, 100)}..."

Ich kann sie leider nicht verarbeiten. Versuche:
- \`/reconnect\` um die Verbindung wiederherzustellen
- \`/status\` für mehr Details`
    }

    private getLayer0Response(message: string, error: unknown): string {
        const errorMsg = error instanceof Error ? error.message : String(error)

        return `🔴 **Layer 0 hat übernommen**

Das LLM konnte nicht antworten:
\`${errorMsg}\`

Ich (Layer 0) übernehme temporär. Was kann ich tun?

**Verfügbare Befehle:**
- \`/status\` - Status prüfen
- \`/reconnect\` - Verbindung wiederherstellen
- \`/model <name>\` - Anderes Modell versuchen
- \`/help\` - Alle Befehle

Deine ursprüngliche Nachricht wurde gespeichert und wird verarbeitet sobald das LLM wieder verfügbar ist.`
    }

    // ============================================
    // Health & Status
    // ============================================

    getHealth(): {
        layer0: 'active'
        resilience: ReturnType<ResilienceManager['getHealthStatus']>
        mode: ReturnType<FallbackManager['getMode']>
    } {
        return {
            layer0: 'active',
            resilience: this.resilience.getHealthStatus(),
            mode: this.fallback.getMode(),
        }
    }

    getSystemPromptAddition(): string {
        return HONESTY_SYSTEM_PROMPT
    }
}

// ============================================
// Factory
// ============================================

export function createLayer0(config?: Partial<Layer0Config>): Layer0Controller {
    return new Layer0Controller(config)
}

export default {
    Layer0Controller,
    createLayer0,
}
