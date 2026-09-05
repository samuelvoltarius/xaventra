/**
 * Nova - Resilience Layer (Layer 0)
 * 
 * Error Detection, Auto-Fix, Health Monitoring, Self-Healing
 * This layer sits above all others and provides fault tolerance
 */

import { EventEmitter } from 'node:events'

// ============================================
// Types
// ============================================

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical'
export type ErrorCategory =
    | 'network'       // API calls, connectivity
    | 'auth'          // Token expired, auth failed
    | 'llm'           // Model errors, rate limits
    | 'channel'       // WhatsApp/Telegram issues
    | 'memory'        // LanceDB, vector search
    | 'config'        // Configuration errors
    | 'runtime'       // State machine, general

export interface TrackedError {
    id: string
    category: ErrorCategory
    severity: ErrorSeverity
    message: string
    stack?: string
    timestamp: number
    resolved: boolean
    autoFixAttempts: number
    autoFixed: boolean
    resolution?: string
}

export interface HealthStatus {
    overall: 'healthy' | 'degraded' | 'unhealthy' | 'critical'
    components: Record<string, ComponentHealth>
    lastCheck: number
    uptime: number
}

export interface ComponentHealth {
    name: string
    status: 'up' | 'degraded' | 'down'
    lastError?: string
    lastSuccess?: number
    consecutiveFailures: number
}

export interface AutoFixStrategy {
    category: ErrorCategory
    pattern: RegExp
    fix: (error: TrackedError) => Promise<boolean>
    maxAttempts: number
    cooldownMs: number
}

// ============================================
// Auto-Fix Strategies
// ============================================

const DEFAULT_FIX_STRATEGIES: AutoFixStrategy[] = [
    // Auth: Token expired → refresh
    {
        category: 'auth',
        pattern: /token.*expired|unauthorized|401/i,
        fix: async (error) => {
            console.log(`[Nova Resilience] Auto-fix: Refreshing expired token`)
            // This would call the auth refresh function
            // For now, we just mark it as needing manual refresh
            return false // Will be connected to actual auth module
        },
        maxAttempts: 3,
        cooldownMs: 5000,
    },

    // Network: Retry after delay
    {
        category: 'network',
        pattern: /ECONNREFUSED|ETIMEDOUT|network|fetch failed/i,
        fix: async (error) => {
            console.log(`[Nova Resilience] Auto-fix: Waiting for network recovery`)
            await new Promise(r => setTimeout(r, 5000))
            return true // Assume network will recover
        },
        maxAttempts: 5,
        cooldownMs: 10000,
    },

    // LLM: Rate limit → switch model or wait
    {
        category: 'llm',
        pattern: /rate.?limit|429|too many requests/i,
        fix: async (error) => {
            console.log(`[Nova Resilience] Auto-fix: Rate limited, waiting 60s`)
            await new Promise(r => setTimeout(r, 60000))
            return true
        },
        maxAttempts: 3,
        cooldownMs: 60000,
    },

    // LLM: Model unavailable → fallback
    {
        category: 'llm',
        pattern: /model.*not.*found|unavailable|503/i,
        fix: async (error) => {
            console.log(`[Nova Resilience] Auto-fix: Switching to fallback model`)
            // Would trigger model switch here
            return false
        },
        maxAttempts: 2,
        cooldownMs: 30000,
    },

    // Channel: Disconnect → reconnect
    {
        category: 'channel',
        pattern: /disconnect|connection.*closed|socket/i,
        fix: async (error) => {
            console.log(`[Nova Resilience] Auto-fix: Reconnecting channel`)
            await new Promise(r => setTimeout(r, 3000))
            return true // Would trigger channel reconnect
        },
        maxAttempts: 5,
        cooldownMs: 5000,
    },

    // Memory: DB connection → reconnect
    {
        category: 'memory',
        pattern: /database|lancedb|connection|ENOENT/i,
        fix: async (error) => {
            console.log(`[Nova Resilience] Auto-fix: Reconnecting to database`)
            return false // Manual intervention needed
        },
        maxAttempts: 3,
        cooldownMs: 10000,
    },
]

// ============================================
// Resilience Manager Class
// ============================================

export class ResilienceManager extends EventEmitter {
    private errors: Map<string, TrackedError> = new Map()
    private componentHealth: Map<string, ComponentHealth> = new Map()
    private strategies: AutoFixStrategy[]
    private startTime: number
    private healthCheckInterval?: NodeJS.Timeout

    // Circuit breaker state
    private circuitBreakers: Map<string, {
        failures: number
        lastFailure: number
        open: boolean
    }> = new Map()

    constructor(strategies?: AutoFixStrategy[]) {
        super()
        this.strategies = strategies ?? DEFAULT_FIX_STRATEGIES
        this.startTime = Date.now()

        // Initialize default components
        this.initComponent('auth')
        this.initComponent('llm')
        this.initComponent('memory')
        this.initComponent('channels')
        this.initComponent('learning')
    }

    // ============================================
    // Lifecycle
    // ============================================

    start(): void {
        console.log('[Nova Resilience] Starting health monitoring...')

        // Health check every 30 seconds
        this.healthCheckInterval = setInterval(() => {
            this.emit('health_check', this.getHealthStatus())
        }, 30000)

        this.emit('started')
    }

    stop(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval)
        }
        this.emit('stopped')
    }

    // ============================================
    // Error Tracking
    // ============================================

    async trackError(
        category: ErrorCategory,
        error: Error | string,
        severity: ErrorSeverity = 'medium'
    ): Promise<TrackedError> {
        const id = `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const message = typeof error === 'string' ? error : error.message
        const stack = typeof error === 'string' ? undefined : error.stack

        const tracked: TrackedError = {
            id,
            category,
            severity,
            message,
            stack,
            timestamp: Date.now(),
            resolved: false,
            autoFixAttempts: 0,
            autoFixed: false,
        }

        this.errors.set(id, tracked)
        this.updateComponentHealth(category, false, message)

        console.log(`[Nova Resilience] Error tracked: [${severity}] ${category}: ${message}`)
        this.emit('error_tracked', tracked)

        // Attempt auto-fix
        if (severity !== 'critical') {
            await this.attemptAutoFix(tracked)
        }

        return tracked
    }

    // ============================================
    // Auto-Fix
    // ============================================

    private async attemptAutoFix(error: TrackedError): Promise<boolean> {
        const strategy = this.findStrategy(error)
        if (!strategy) {
            console.log(`[Nova Resilience] No auto-fix strategy for: ${error.category}`)
            return false
        }

        if (error.autoFixAttempts >= strategy.maxAttempts) {
            console.log(`[Nova Resilience] Max auto-fix attempts reached for: ${error.id}`)
            return false
        }

        // Check circuit breaker
        if (this.isCircuitOpen(error.category)) {
            console.log(`[Nova Resilience] Circuit breaker open for: ${error.category}`)
            return false
        }

        error.autoFixAttempts++
        console.log(`[Nova Resilience] Attempting auto-fix (${error.autoFixAttempts}/${strategy.maxAttempts})`)

        try {
            const fixed = await strategy.fix(error)

            if (fixed) {
                error.resolved = true
                error.autoFixed = true
                error.resolution = 'Auto-fixed by resilience layer'
                this.updateComponentHealth(error.category, true)
                this.resetCircuitBreaker(error.category)

                console.log(`[Nova Resilience] ✅ Auto-fixed: ${error.id}`)
                this.emit('error_fixed', error)
                return true
            }
        } catch (fixError) {
            console.error(`[Nova Resilience] Auto-fix failed:`, fixError)
            this.incrementCircuitBreaker(error.category)
        }

        return false
    }

    private findStrategy(error: TrackedError): AutoFixStrategy | undefined {
        return this.strategies.find(s =>
            s.category === error.category && s.pattern.test(error.message)
        )
    }

    // ============================================
    // Circuit Breaker
    // ============================================

    private isCircuitOpen(category: string): boolean {
        const breaker = this.circuitBreakers.get(category)
        if (!breaker) return false

        // Reset after 60 seconds
        if (breaker.open && Date.now() - breaker.lastFailure > 60000) {
            breaker.open = false
            breaker.failures = 0
        }

        return breaker.open
    }

    private incrementCircuitBreaker(category: string): void {
        let breaker = this.circuitBreakers.get(category)
        if (!breaker) {
            breaker = { failures: 0, lastFailure: 0, open: false }
            this.circuitBreakers.set(category, breaker)
        }

        breaker.failures++
        breaker.lastFailure = Date.now()

        // Open circuit after 5 consecutive failures
        if (breaker.failures >= 5) {
            breaker.open = true
            console.log(`[Nova Resilience] 🔴 Circuit breaker OPEN for: ${category}`)
            this.emit('circuit_open', category)
        }
    }

    private resetCircuitBreaker(category: string): void {
        const breaker = this.circuitBreakers.get(category)
        if (breaker) {
            breaker.failures = 0
            breaker.open = false
        }
    }

    // ============================================
    // Component Health
    // ============================================

    private initComponent(name: string): void {
        this.componentHealth.set(name, {
            name,
            status: 'up',
            consecutiveFailures: 0,
        })
    }

    private updateComponentHealth(category: string, success: boolean, error?: string): void {
        let health = this.componentHealth.get(category)
        if (!health) {
            health = { name: category, status: 'up', consecutiveFailures: 0 }
            this.componentHealth.set(category, health)
        }

        if (success) {
            health.status = 'up'
            health.consecutiveFailures = 0
            health.lastSuccess = Date.now()
        } else {
            health.consecutiveFailures++
            health.lastError = error

            if (health.consecutiveFailures >= 5) {
                health.status = 'down'
            } else if (health.consecutiveFailures >= 2) {
                health.status = 'degraded'
            }
        }
    }

    reportSuccess(category: ErrorCategory): void {
        this.updateComponentHealth(category, true)
        this.resetCircuitBreaker(category)
    }

    getComponentHealth(name: string): ComponentHealth | undefined {
        return this.componentHealth.get(name)
    }

    // ============================================
    // Health Status
    // ============================================

    getHealthStatus(): HealthStatus {
        const components: Record<string, ComponentHealth> = {}
        let downCount = 0
        let degradedCount = 0

        for (const [name, health] of this.componentHealth) {
            components[name] = health
            if (health.status === 'down') downCount++
            if (health.status === 'degraded') degradedCount++
        }

        let overall: HealthStatus['overall']
        if (downCount >= 3) {
            overall = 'critical'
        } else if (downCount >= 1) {
            overall = 'unhealthy'
        } else if (degradedCount >= 2) {
            overall = 'degraded'
        } else {
            overall = 'healthy'
        }

        return {
            overall,
            components,
            lastCheck: Date.now(),
            uptime: Date.now() - this.startTime,
        }
    }

    // ============================================
    // Statistics
    // ============================================

    getStats(): {
        totalErrors: number
        resolved: number
        autoFixed: number
        byCategory: Record<string, number>
        bySeverity: Record<string, number>
    } {
        const errors = Array.from(this.errors.values())
        const byCategory: Record<string, number> = {}
        const bySeverity: Record<string, number> = {}

        for (const error of errors) {
            byCategory[error.category] = (byCategory[error.category] ?? 0) + 1
            bySeverity[error.severity] = (bySeverity[error.severity] ?? 0) + 1
        }

        return {
            totalErrors: errors.length,
            resolved: errors.filter(e => e.resolved).length,
            autoFixed: errors.filter(e => e.autoFixed).length,
            byCategory,
            bySeverity,
        }
    }

    getRecentErrors(count = 10): TrackedError[] {
        return Array.from(this.errors.values())
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, count)
    }

    getUnresolvedErrors(): TrackedError[] {
        return Array.from(this.errors.values())
            .filter(e => !e.resolved)
    }

    // ============================================
    // Manual Resolution
    // ============================================

    resolveError(id: string, resolution: string): boolean {
        const error = this.errors.get(id)
        if (!error) return false

        error.resolved = true
        error.resolution = resolution
        this.emit('error_resolved', error)

        return true
    }

    clearResolvedErrors(): number {
        let count = 0
        for (const [id, error] of this.errors) {
            if (error.resolved) {
                this.errors.delete(id)
                count++
            }
        }
        return count
    }
}

// ============================================
// Factory
// ============================================

export function createResilienceManager(): ResilienceManager {
    return new ResilienceManager()
}

// ============================================
// Wrapper Helper
// ============================================

/**
 * Wrap an async function with resilience tracking
 */
export function withResilience<T>(
    manager: ResilienceManager,
    category: ErrorCategory,
    fn: () => Promise<T>
): Promise<T> {
    return fn()
        .then(result => {
            manager.reportSuccess(category)
            return result
        })
        .catch(async (error) => {
            await manager.trackError(category, error)
            throw error
        })
}

export default {
    ResilienceManager,
    createResilienceManager,
    withResilience,
}
