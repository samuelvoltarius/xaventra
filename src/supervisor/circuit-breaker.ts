/**
 * L(-1) Circuit Breaker - Critical Safety Layer
 * 
 * Prevents Nova from "kaputt-reparieren" by detecting:
 * 1. Error Cascades (3+ errors in 60 seconds)
 * 2. Repair Loops (same fix attempted 2+ times)
 * 3. Regression Detection (fix made things worse)
 * 
 * When triggered: HARD STOP + Rollback + Alert
 */

import { EventEmitter } from 'node:events'
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Types
// ============================================

export interface ErrorEvent {
    timestamp: number
    type: string
    message: string
    file?: string
    severity: 'warning' | 'error' | 'fatal'
    source: 'build' | 'test' | 'runtime' | 'fix-attempt'
}

export interface FixAttempt {
    id: string
    pattern: string
    file: string
    timestamp: number
    success: boolean
    errorBefore?: string
    errorAfter?: string
}

export interface CircuitState {
    status: 'closed' | 'open' | 'half-open'  // closed = normal, open = blocked
    openedAt?: number
    reason?: string
    errorCount: number
    lastErrors: ErrorEvent[]
    fixAttempts: FixAttempt[]
    rollbackPoint?: string  // Git commit SHA
}

export interface CircuitConfig {
    // Thresholds
    maxErrorsPerMinute: number       // 3+ errors = cascade
    maxSameFixAttempts: number       // 2+ same fix = loop
    cooldownMs: number               // How long to stay open

    // Actions
    autoRollback: boolean
    notifyTelegram: boolean
    telegramChatId?: string

    // Storage
    stateFile: string
}

// ============================================
// Circuit Breaker
// ============================================

export class CircuitBreaker extends EventEmitter {
    private config: CircuitConfig
    private state: CircuitState
    private checkInterval: NodeJS.Timeout | null = null

    constructor(config: Partial<CircuitConfig> = {}) {
        super()

        this.config = {
            maxErrorsPerMinute: config.maxErrorsPerMinute ?? 3,
            maxSameFixAttempts: config.maxSameFixAttempts ?? 2,
            cooldownMs: config.cooldownMs ?? 300000,  // 5 minutes
            autoRollback: config.autoRollback ?? true,
            notifyTelegram: config.notifyTelegram ?? true,
            telegramChatId: config.telegramChatId,
            stateFile: config.stateFile || '.nova-circuit-breaker.json',
        }

        this.state = this.loadState()
        console.log(`[Circuit Breaker] 🔒 Initialized (status: ${this.state.status})`)
    }

    // ============================================
    // Core Methods
    // ============================================

    /**
     * Record an error event
     */
    recordError(event: ErrorEvent): void {
        this.state.lastErrors.push(event)
        this.state.errorCount++

        // Keep only last 100 errors
        if (this.state.lastErrors.length > 100) {
            this.state.lastErrors = this.state.lastErrors.slice(-100)
        }

        console.log(`[Circuit Breaker] ⚠️ Error recorded: ${event.type} - ${event.message.slice(0, 50)}`)

        // Check for cascade
        this.checkForCascade()
        this.saveState()
    }

    /**
     * Record a fix attempt
     */
    recordFixAttempt(attempt: FixAttempt): void {
        this.state.fixAttempts.push(attempt)

        // Keep only last 50 attempts
        if (this.state.fixAttempts.length > 50) {
            this.state.fixAttempts = this.state.fixAttempts.slice(-50)
        }

        console.log(`[Circuit Breaker] 🔧 Fix attempt: ${attempt.pattern} (success: ${attempt.success})`)

        // Check for repair loop
        this.checkForRepairLoop(attempt)
        this.saveState()
    }

    /**
     * Check if operation is allowed
     */
    isAllowed(): boolean {
        if (this.state.status === 'open') {
            // Check if cooldown expired
            const elapsed = Date.now() - (this.state.openedAt || 0)
            if (elapsed > this.config.cooldownMs) {
                this.halfOpen()
            } else {
                console.log(`[Circuit Breaker] 🚫 BLOCKED - Cooldown: ${Math.round((this.config.cooldownMs - elapsed) / 1000)}s remaining`)
                return false
            }
        }
        return true
    }

    /**
     * Save rollback point before risky operation
     */
    saveRollbackPoint(): string | null {
        try {
            const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
            this.state.rollbackPoint = sha
            this.saveState()
            console.log(`[Circuit Breaker] 📍 Rollback point saved: ${sha.slice(0, 8)}`)
            return sha
        } catch (err) {
            console.error(`[Circuit Breaker] Failed to save rollback point: ${err}`)
            return null
        }
    }

    // ============================================
    // Detection Logic
    // ============================================

    private checkForCascade(): void {
        const oneMinuteAgo = Date.now() - 60000
        const recentErrors = this.state.lastErrors.filter(e => e.timestamp > oneMinuteAgo)

        if (recentErrors.length >= this.config.maxErrorsPerMinute) {
            this.trip(`ERROR CASCADE: ${recentErrors.length} Fehler in 60 Sekunden!`)
        }
    }

    private checkForRepairLoop(attempt: FixAttempt): void {
        // Count attempts for same pattern in last 5 minutes
        const fiveMinutesAgo = Date.now() - 300000
        const samePatternAttempts = this.state.fixAttempts.filter(a =>
            a.pattern === attempt.pattern &&
            a.timestamp > fiveMinutesAgo
        )

        if (samePatternAttempts.length >= this.config.maxSameFixAttempts) {
            this.trip(`REPAIR LOOP: "${attempt.pattern}" ${samePatternAttempts.length}x versucht ohne Erfolg!`)
        }

        // Check for regression (fix made things worse)
        if (!attempt.success && attempt.errorAfter && attempt.errorBefore) {
            if (attempt.errorAfter !== attempt.errorBefore) {
                // New error appeared after fix
                this.trip(`REGRESSION: Fix für "${attempt.pattern}" hat neuen Fehler verursacht!`)
            }
        }
    }

    // ============================================
    // Circuit State Management
    // ============================================

    private trip(reason: string): void {
        if (this.state.status === 'open') return  // Already tripped

        console.log(`\n🚨🚨🚨 CIRCUIT BREAKER TRIPPED 🚨🚨🚨`)
        console.log(`Grund: ${reason}`)
        console.log(`Nova ist jetzt GESTOPPT.\n`)

        this.state.status = 'open'
        this.state.openedAt = Date.now()
        this.state.reason = reason

        this.emit('trip', { reason, state: this.state })

        // Auto-rollback if enabled
        if (this.config.autoRollback && this.state.rollbackPoint) {
            this.rollback()
        }

        // Notify via Telegram
        if (this.config.notifyTelegram) {
            this.notifyTelegram(reason)
        }

        this.saveState()
    }

    private halfOpen(): void {
        console.log(`[Circuit Breaker] 🔶 Half-open - Testing if safe to continue...`)
        this.state.status = 'half-open'
        this.state.errorCount = 0
        this.saveState()
    }

    reset(): void {
        console.log(`[Circuit Breaker] ✅ Reset - Normal operation resumed`)
        this.state.status = 'closed'
        this.state.openedAt = undefined
        this.state.reason = undefined
        this.state.errorCount = 0
        this.emit('reset')
        this.saveState()
    }

    // ============================================
    // Recovery Actions
    // ============================================

    private rollback(): void {
        if (!this.state.rollbackPoint) {
            console.log(`[Circuit Breaker] ⚠️ No rollback point available`)
            return
        }

        try {
            console.log(`[Circuit Breaker] ⏪ Rolling back to ${this.state.rollbackPoint.slice(0, 8)}...`)

            // Stash any changes first
            execSync('git stash --include-untracked', { encoding: 'utf-8', stdio: 'pipe' })

            // Hard reset to rollback point
            execSync(`git reset --hard ${this.state.rollbackPoint}`, { encoding: 'utf-8', stdio: 'pipe' })

            console.log(`[Circuit Breaker] ✅ Rollback complete!`)
            this.emit('rollback', { sha: this.state.rollbackPoint })

        } catch (err) {
            console.error(`[Circuit Breaker] ❌ Rollback failed: ${err}`)
        }
    }

    private async notifyTelegram(reason: string): Promise<void> {
        // Try to get Telegram bot token and chat ID from config
        const configPath = resolveConfigPath()

        try {
            if (!existsSync(configPath)) return

            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            const botToken = config.telegram?.token
            const chatId = this.config.telegramChatId || config.telegram?.adminChatId || config.telegram?.chatId

            if (!botToken || !chatId) {
                console.log(`[Circuit Breaker] No Telegram config available`)
                return
            }

            const message = `🚨 *NOVA CIRCUIT BREAKER*

⛔ *Status:* GESTOPPT
📍 *Grund:* ${reason}
⏰ *Zeit:* ${new Date().toLocaleString('de-DE')}

Nova wurde automatisch gestoppt um Schäden zu verhindern.
Manual restart erforderlich: \`npm run nova\``

            const url = `https://api.telegram.org/bot${botToken}/sendMessage`
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: message,
                    parse_mode: 'Markdown',
                }),
            })

            console.log(`[Circuit Breaker] 📱 Telegram notification sent`)

        } catch (err) {
            console.error(`[Circuit Breaker] Failed to send Telegram notification: ${err}`)
        }
    }

    // ============================================
    // State Persistence
    // ============================================

    private loadState(): CircuitState {
        try {
            if (existsSync(this.config.stateFile)) {
                const data = JSON.parse(readFileSync(this.config.stateFile, 'utf-8'))
                return {
                    ...data,
                    lastErrors: data.lastErrors || [],
                    fixAttempts: data.fixAttempts || [],
                }
            }
        } catch { }

        return {
            status: 'closed',
            errorCount: 0,
            lastErrors: [],
            fixAttempts: [],
        }
    }

    private saveState(): void {
        try {
            writeFileSync(this.config.stateFile, JSON.stringify(this.state, null, 2))
        } catch (err) {
            console.error(`[Circuit Breaker] Failed to save state: ${err}`)
        }
    }

    // ============================================
    // Status
    // ============================================

    getStatus(): CircuitState {
        return { ...this.state }
    }

    formatStatus(): string {
        const icons = {
            'closed': '🟢',
            'open': '🔴',
            'half-open': '🟡',
        }

        let msg = `${icons[this.state.status]} **Circuit Breaker: ${this.state.status.toUpperCase()}**\n\n`

        if (this.state.status === 'open') {
            const elapsed = Date.now() - (this.state.openedAt || 0)
            const remaining = Math.max(0, this.config.cooldownMs - elapsed)
            msg += `⛔ **Grund:** ${this.state.reason}\n`
            msg += `⏱️ **Cooldown:** ${Math.round(remaining / 1000)}s\n`

            if (this.state.rollbackPoint) {
                msg += `📍 **Rollback Point:** ${this.state.rollbackPoint.slice(0, 8)}\n`
            }
        }

        msg += `\n📊 **Statistiken:**\n`
        msg += `• Fehler gesamt: ${this.state.errorCount}\n`
        msg += `• Fix-Versuche: ${this.state.fixAttempts.length}\n`

        const oneMinuteAgo = Date.now() - 60000
        const recentErrors = this.state.lastErrors.filter(e => e.timestamp > oneMinuteAgo).length
        msg += `• Fehler/Minute: ${recentErrors}/${this.config.maxErrorsPerMinute} (Limit)\n`

        return msg
    }
}

// ============================================
// Singleton
// ============================================

let circuitBreaker: CircuitBreaker | null = null

export function getCircuitBreaker(config?: Partial<CircuitConfig>): CircuitBreaker {
    if (!circuitBreaker) {
        circuitBreaker = new CircuitBreaker(config)
    }
    return circuitBreaker
}

export default { CircuitBreaker, getCircuitBreaker }
