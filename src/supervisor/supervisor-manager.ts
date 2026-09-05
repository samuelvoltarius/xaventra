/**
 * Supervisor Manager - Main Orchestrator
 * 
 * Coordinates all supervisor components:
 * - Log Collector (watches logs)
 * - Pattern Matcher (detects errors)
 * - Fix Generator (proposes fixes)
 * - Auto-Tester (validates fixes)
 */

import { EventEmitter } from 'node:events'
import { LogCollector, getLogCollector } from './log-collector.js'
import { PatternMatcher, getPatternMatcher, PatternMatch } from './pattern-matcher.js'
import { FixGenerator, getFixGenerator, FixProposal } from './fix-generator.js'
import { AutoTester, getAutoTester, TestResult } from './auto-tester.js'
import { LogEntry } from '../logging/structured-logger.js'
import { CircuitBreaker, getCircuitBreaker } from './circuit-breaker.js'

// ============================================
// Types
// ============================================

export interface SupervisorConfig {
    enabled: boolean
    autoFix: boolean  // Automatically apply successful fixes
    minConfidence: number  // Min confidence to attempt fix (0-1)
    notifyOnFix: boolean  // Notify user when fix is applied
    provider: 'openai' | 'ollama'
    workDir: string
}

export interface SupervisorStats {
    isRunning: boolean
    startTime: Date | null
    totalErrors: number
    totalMatches: number
    totalFixesProposed: number
    totalFixesApplied: number
    totalFixesFailed: number
    recentActivity: ActivityLog[]
}

export interface ActivityLog {
    timestamp: Date
    type: 'error' | 'match' | 'fix_proposed' | 'fix_success' | 'fix_failed'
    message: string
    metadata?: Record<string, unknown>
}

// ============================================
// Supervisor Manager
// ============================================

export class SupervisorManager extends EventEmitter {
    private config: SupervisorConfig
    private collector: LogCollector
    private matcher: PatternMatcher
    private generator: FixGenerator
    private tester: AutoTester
    private circuitBreaker: CircuitBreaker

    private stats: SupervisorStats
    private isProcessing: boolean = false
    private fixQueue: PatternMatch[] = []

    constructor(config: Partial<SupervisorConfig> = {}) {
        super()

        this.config = {
            enabled: config.enabled ?? true,
            autoFix: config.autoFix ?? false,  // Default: manual approval
            minConfidence: config.minConfidence ?? 0.7,
            notifyOnFix: config.notifyOnFix ?? true,
            provider: config.provider || 'openai',
            workDir: config.workDir || process.cwd(),
        }

        // Initialize components
        this.collector = getLogCollector()
        this.matcher = getPatternMatcher()
        this.generator = getFixGenerator({ provider: this.config.provider })
        this.tester = getAutoTester({
            workDir: this.config.workDir,
            autoCommit: this.config.autoFix,
        })
        this.circuitBreaker = getCircuitBreaker({
            notifyTelegram: true,
            autoRollback: true,
        })

        // Listen for circuit breaker events
        this.circuitBreaker.on('trip', ({ reason }) => {
            this.stop()
            this.logActivity('error', `🚨 CIRCUIT BREAKER: ${reason}`)
            console.log(`\n🚨 SUPERVISOR STOPPED BY CIRCUIT BREAKER 🚨\n`)
        })

        // Initialize stats
        this.stats = {
            isRunning: false,
            startTime: null,
            totalErrors: 0,
            totalMatches: 0,
            totalFixesProposed: 0,
            totalFixesApplied: 0,
            totalFixesFailed: 0,
            recentActivity: [],
        }

        console.log(`[Supervisor] Manager initialized (autoFix: ${this.config.autoFix})`)
    }

    /**
     * Start the supervisor
     */
    start(): void {
        if (this.stats.isRunning) return

        console.log(`[Supervisor] ▶️ Starting supervisor...`)

        // Start log collector
        this.collector.start()

        // Listen for errors
        this.collector.on('error', (entry: LogEntry) => {
            this.handleError(entry)
        })

        this.collector.on('entry', (entry: LogEntry) => {
            // Track all errors (not just matched ones)
            if (entry.level === 'error' || entry.level === 'fatal') {
                this.stats.totalErrors++
            }
        })

        // Listen for pattern matches
        this.matcher.on('match', (match: PatternMatch) => {
            this.handleMatch(match)
        })

        this.stats.isRunning = true
        this.stats.startTime = new Date()

        this.logActivity('match', '🚀 Supervisor gestartet')
        console.log(`[Supervisor] ✅ Running and watching for errors`)
    }

    /**
     * Stop the supervisor
     */
    stop(): void {
        this.collector.stop()
        this.stats.isRunning = false
        this.logActivity('match', '⏹️ Supervisor gestoppt')
        console.log(`[Supervisor] Stopped`)
    }

    /**
     * Handle an error log entry
     */
    private handleError(entry: LogEntry): void {
        const context = this.collector.getRecentEntries(10)
        const match = this.matcher.match(entry, context)

        if (match) {
            this.stats.totalMatches++
            this.logActivity('match', `🎯 Pattern erkannt: ${match.pattern.name}`, {
                pattern: match.pattern.id,
                layer: entry.layer,
            })
        }
    }

    /**
     * Handle a pattern match
     */
    private async handleMatch(match: PatternMatch): Promise<void> {
        // Only process auto-fixable patterns
        if (!match.pattern.autoFixable) {
            console.log(`[Supervisor] Pattern "${match.pattern.name}" is not auto-fixable`)
            return
        }

        // Add to queue if not already processing
        if (!this.isProcessing) {
            await this.processMatch(match)
        } else {
            this.fixQueue.push(match)
        }
    }

    /**
     * Process a match and attempt to generate/apply fix
     */
    private async processMatch(match: PatternMatch): Promise<void> {
        // ⚡ CIRCUIT BREAKER CHECK
        if (!this.circuitBreaker.isAllowed()) {
            console.log(`[Supervisor] ⛔ Circuit breaker is OPEN - skipping fix`)
            return
        }

        this.isProcessing = true

        // Save rollback point before attempting fix
        this.circuitBreaker.saveRollbackPoint()

        try {
            // 1. Generate fix proposal
            console.log(`[Supervisor] Generating fix for: ${match.pattern.name}`)
            const proposal = await this.generator.generateFix(match)

            if (!proposal) {
                console.log(`[Supervisor] No fix proposal generated`)
                return
            }

            this.stats.totalFixesProposed++
            this.logActivity('fix_proposed', `💡 Fix vorgeschlagen: ${proposal.description}`, {
                confidence: proposal.confidence,
                changes: proposal.changes.length,
            })

            // 2. Check confidence threshold
            if (proposal.confidence < this.config.minConfidence) {
                console.log(`[Supervisor] Confidence too low (${proposal.confidence} < ${this.config.minConfidence})`)
                this.emit('low_confidence_fix', proposal)
                return
            }

            // 3. Test the fix
            if (this.config.autoFix) {
                console.log(`[Supervisor] Auto-testing fix...`)
                const result = await this.tester.testFix(proposal)

                if (result.success) {
                    this.stats.totalFixesApplied++
                    this.generator.updateProposalStatus(proposal.id, 'applied', result)
                    this.logActivity('fix_success', `✅ Fix angewendet: ${proposal.description}`)
                    this.emit('fix_applied', { proposal, result })

                    // ⚡ Record successful fix in circuit breaker
                    this.circuitBreaker.recordFixAttempt({
                        id: proposal.id,
                        pattern: match.pattern.id,
                        file: proposal.changes[0]?.filePath || 'unknown',
                        timestamp: Date.now(),
                        success: true,
                    })
                } else {
                    this.stats.totalFixesFailed++
                    this.generator.updateProposalStatus(proposal.id, 'failed', result)
                    this.logActivity('fix_failed', `❌ Fix fehlgeschlagen: ${result.errors.join(', ')}`)
                    this.emit('fix_failed', { proposal, result })

                    // ⚡ Record failed fix - may trigger circuit breaker!
                    this.circuitBreaker.recordFixAttempt({
                        id: proposal.id,
                        pattern: match.pattern.id,
                        file: proposal.changes[0]?.filePath || 'unknown',
                        timestamp: Date.now(),
                        success: false,
                        errorAfter: result.errors.join(', '),
                    })

                    // ⚡ Record error for cascade detection
                    this.circuitBreaker.recordError({
                        timestamp: Date.now(),
                        type: 'fix-failed',
                        message: `Fix for ${match.pattern.name} failed`,
                        severity: 'error',
                        source: 'fix-attempt',
                    })
                }
            } else {
                // Manual mode - emit for user approval
                this.emit('fix_pending', proposal)
                console.log(`[Supervisor] Fix pending user approval`)
            }

        } catch (err) {
            console.error(`[Supervisor] Error processing match:`, err)
        } finally {
            this.isProcessing = false

            // Process next in queue
            if (this.fixQueue.length > 0) {
                const next = this.fixQueue.shift()!
                await this.processMatch(next)
            }
        }
    }

    /**
     * Manually approve and apply a pending fix
     */
    async approveFix(proposalId: string): Promise<TestResult> {
        const proposal = this.generator.getProposal(proposalId)
        if (!proposal) {
            throw new Error(`Proposal not found: ${proposalId}`)
        }

        console.log(`[Supervisor] Manual approval: ${proposal.description}`)
        const result = await this.tester.testFix(proposal)

        if (result.success) {
            this.stats.totalFixesApplied++
            this.generator.updateProposalStatus(proposalId, 'applied', result)
            this.logActivity('fix_success', `✅ Fix manuell angewendet: ${proposal.description}`)
        } else {
            this.stats.totalFixesFailed++
            this.generator.updateProposalStatus(proposalId, 'failed', result)
            this.logActivity('fix_failed', `❌ Fix fehlgeschlagen`)
        }

        return result
    }

    /**
     * Reject a pending fix
     */
    rejectFix(proposalId: string): void {
        this.generator.updateProposalStatus(proposalId, 'rejected')
        this.logActivity('fix_failed', `🚫 Fix abgelehnt: ${proposalId}`)
    }

    /**
     * Log activity for status reporting
     */
    private logActivity(type: ActivityLog['type'], message: string, metadata?: Record<string, unknown>): void {
        const activity: ActivityLog = {
            timestamp: new Date(),
            type,
            message,
            metadata,
        }

        this.stats.recentActivity.push(activity)

        // Keep only last 50 activities
        if (this.stats.recentActivity.length > 50) {
            this.stats.recentActivity = this.stats.recentActivity.slice(-50)
        }
    }

    // ============================================
    // Query API
    // ============================================

    /**
     * Get supervisor status
     */
    getStatus(): SupervisorStats {
        return {
            ...this.stats,
            recentActivity: [...this.stats.recentActivity],
        }
    }

    /**
     * Get pending fix proposals
     */
    getPendingFixes(): FixProposal[] {
        return this.generator.getPendingProposals()
    }

    /**
     * Get pattern statistics
     */
    getPatternStats() {
        return this.matcher.getStats()
    }

    /**
     * Format status for Telegram/WhatsApp
     */
    formatStatus(): string {
        const uptime = this.stats.startTime
            ? Math.floor((Date.now() - this.stats.startTime.getTime()) / 60000)
            : 0

        const pending = this.getPendingFixes()
        const recentActivity = this.stats.recentActivity
            .slice(-5)
            .map(a => `• ${a.message}`)
            .join('\n')

        return `🤖 *Supervisor Status*

*Status:* ${this.stats.isRunning ? '✅ Läuft' : '⏹️ Gestoppt'}
*Uptime:* ${uptime} min
*Provider:* ${this.config.provider}
*Auto-Fix:* ${this.config.autoFix ? 'AN' : 'AUS'}

*Statistiken:*
• Errors erkannt: ${this.stats.totalErrors}
• Patterns matched: ${this.stats.totalMatches}
• Fixes vorgeschlagen: ${this.stats.totalFixesProposed}
• Fixes angewendet: ${this.stats.totalFixesApplied}
• Fixes fehlgeschlagen: ${this.stats.totalFixesFailed}

*Pending Fixes:* ${pending.length}
${pending.slice(0, 3).map(p => `• ${p.description.slice(0, 40)}...`).join('\n') || 'Keine'}

*Letzte Aktivität:*
${recentActivity || 'Keine Aktivität'}`
    }
}

// ============================================
// Singleton
// ============================================

let supervisor: SupervisorManager | null = null

export function getSupervisor(config?: Partial<SupervisorConfig>): SupervisorManager {
    if (!supervisor) {
        supervisor = new SupervisorManager(config)
    }
    return supervisor
}

export default { SupervisorManager, getSupervisor }
