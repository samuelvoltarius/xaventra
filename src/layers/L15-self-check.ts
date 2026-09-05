/**
 * Layer 15 - Self-Check / Self-Awareness
 * 
 * Nova checks herself:
 * - Did I actually respond to the user?
 * - What is my current task? Am I stuck?
 * - Should I make proactive suggestions?
 * - Am I waiting when I should be acting?
 * 
 * Philosophy: Don't wait for the user - BE PROACTIVE!
 */

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

interface SelfCheckState {
    lastResponseTime: number
    lastUserMessageTime: number
    pendingTasks: string[]
    waitingForUser: boolean
    consecutiveSilences: number
    lastSelfCheck: number
}

// Tool Health Tracking
export interface ToolHealthEntry {
    name: string
    status: 'healthy' | 'degraded' | 'broken'
    successCount: number
    failureCount: number
    emptyResultCount: number
    consecutiveFailures: number
    consecutiveEmpty: number
    lastSuccess: number
    lastFailure: number
    lastDiagnosis: string | null
    repairedAt: number | null
}

interface SelfCheckResult {
    ok: boolean
    issues: string[]
    suggestions: string[]
    shouldAct: boolean
}

// ============================================
// Self-Check Manager
// ============================================

class SelfCheckManager extends EventEmitter {
    private readonly TASKS_FILE = join(process.cwd(), '.nova-data', 'pending-tasks.json')
    private state: SelfCheckState = {
        lastResponseTime: Date.now(),
        lastUserMessageTime: 0,
        pendingTasks: [],
        waitingForUser: false,
        consecutiveSilences: 0,
        lastSelfCheck: 0,
    }
    private toolCallActive = false  // Track if a tool is currently executing

    private checkInterval: NodeJS.Timeout | null = null
    private readonly SILENCE_THRESHOLD_MS = 30000       // 30s without response = possible problem
    private readonly SILENCE_WARN_MAX_MS = 5 * 60_000   // Stop warning after 5 min — user is gone
    private readonly MAX_CONSECUTIVE_SILENCES = 3
    private idleLearningStarted = false
    private notifyCallback?: (message: string) => Promise<void>
    private toolFailures: Map<string, number> = new Map()
    private toolHealth: Map<string, ToolHealthEntry> = new Map()
    private readonly TOOL_HEALTH_FILE = join(process.cwd(), '.nova-data', 'tool-health.json')
    private lastL0Health: any = null  // Cached L0 health status for bridge

    constructor() {
        super()
        // Load persisted pending tasks
        try {
            if (existsSync(this.TASKS_FILE)) {
                const data = JSON.parse(readFileSync(this.TASKS_FILE, 'utf-8'))
                if (Array.isArray(data) && data.length > 0) {
                    this.state.pendingTasks = data
                    console.log(`[L15 SelfCheck] Loaded ${data.length} pending tasks from disk`)
                }
            }
        } catch { /* fresh start */ }

        // Load persisted tool health
        this.loadToolHealth()
    }

    private persistTasks(): void {
        try {
            const dir = join(process.cwd(), '.nova-data')
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(this.TASKS_FILE, JSON.stringify(this.state.pendingTasks, null, 2))
        } catch { /* non-critical */ }
    }

    // Record that user sent a message
    userMessageReceived(): void {
        this.state.lastUserMessageTime = Date.now()
        this.state.waitingForUser = false
        this.updateActivity() // Reset idle timer

        // Auto-start idle learning on first message
        if (!this.idleLearningStarted) {
            this.startIdleLearning()
            this.idleLearningStarted = true
        }

        console.log('[L15 SelfCheck] User message received')
    }

    // Track tool execution state
    toolCallStarted(): void {
        this.toolCallActive = true
    }

    toolCallFinished(): void {
        this.toolCallActive = false
        this.updateActivity()
    }

    // Set callback for notifying user (e.g., during idle learning)
    setNotifyCallback(callback: (message: string) => Promise<void>): void {
        this.notifyCallback = callback
        console.log('[L15 SelfCheck] Notify callback registered')
    }

    // Record that Nova responded
    responseGenerated(hasContent: boolean): void {
        this.updateActivity() // Reset idle timer

        if (hasContent) {
            this.state.lastResponseTime = Date.now()
            this.state.consecutiveSilences = 0
            console.log('[L15 SelfCheck] Response generated ✓')
        } else {
            this.state.consecutiveSilences++
            console.log(`[L15 SelfCheck] ⚠️ Empty response! Consecutive silences: ${this.state.consecutiveSilences}`)
        }
    }

    // Record a pending task
    addPendingTask(task: string): void {
        if (!this.state.pendingTasks.includes(task)) {
            this.state.pendingTasks.push(task)
            // Memory guard: cap at 50 tasks
            if (this.state.pendingTasks.length > 50) {
                this.state.pendingTasks = this.state.pendingTasks.slice(-50)
            }
            this.persistTasks()
            console.log(`[L15 SelfCheck] Task added: ${task}`)
        }
    }

    // Mark task as complete
    completeTask(task: string): void {
        this.state.pendingTasks = this.state.pendingTasks.filter(t => t !== task)
        this.persistTasks()
        console.log(`[L15 SelfCheck] Task completed: ${task}`)
    }

    // Report tool failure (called from registry on each tool error)
    reportToolFailure(toolName: string): void {
        const count = (this.toolFailures.get(toolName) || 0) + 1
        this.toolFailures.set(toolName, count)
        if (count === 3) {
            console.log(`[L15 SelfCheck] ⚠️ Tool "${toolName}" has failed ${count}x — flagging as broken!`)
        }
        // Also update health store
        this.updateToolHealth(toolName, 'failure')
    }

    // Report tool success (resets failure counter)
    reportToolSuccess(toolName: string): void {
        if (this.toolFailures.has(toolName)) {
            this.toolFailures.delete(toolName)
        }
        // Also update health store
        this.updateToolHealth(toolName, 'success')
    }

    /**
     * Report tool result with quality inspection.
     * This is the SMART version — inspects the actual output, not just exceptions.
     */
    reportToolResult(toolName: string, result: unknown): void {
        const quality = this.assessResultQuality(toolName, result)

        if (quality === 'empty') {
            this.updateToolHealth(toolName, 'empty')
            console.log(`[L15 ToolHealth] ⚠️ "${toolName}" returned empty/useless result`)
        } else if (quality === 'error') {
            this.updateToolHealth(toolName, 'failure')
            console.log(`[L15 ToolHealth] ❌ "${toolName}" result contains error`)
        } else {
            this.updateToolHealth(toolName, 'success')
        }
    }

    /**
     * Assess the quality of a tool's output.
     * Different tools have different definitions of "empty" or "broken".
     */
    private assessResultQuality(toolName: string, result: unknown): 'good' | 'empty' | 'error' {
        if (result === null || result === undefined) return 'empty'

        const r = result as Record<string, unknown>

        // Check for explicit error field
        if (r.error && typeof r.error === 'string' && r.error.length > 0) return 'error'

        // Search tools: empty results array = degraded
        if (toolName.includes('search') || toolName === 'google_search' || toolName === 'brave_search' || toolName === 'tavily_search' || toolName === 'web_search') {
            if (Array.isArray(r.results) && r.results.length === 0) return 'empty'
        }

        // Browser tools: empty content
        if (toolName === 'read_page' || toolName === 'browse_url') {
            if (r.content === '' || r.text === '') return 'empty'
        }

        // Command execution: non-zero exit code
        if (toolName === 'execute_command' || toolName === 'run_command') {
            if (r.exitCode !== undefined && r.exitCode !== 0) return 'error'
        }

        // SSH: connection errors
        if (toolName === 'ssh_command') {
            if (typeof r.output === 'string' && (r.output.includes('Connection refused') || r.output.includes('Permission denied'))) return 'error'
        }

        return 'good'
    }

    // ============================================
    // Tool Health Store (Persistent)
    // ============================================

    private getOrCreateHealth(toolName: string): ToolHealthEntry {
        let entry = this.toolHealth.get(toolName)
        if (!entry) {
            entry = {
                name: toolName,
                status: 'healthy',
                successCount: 0,
                failureCount: 0,
                emptyResultCount: 0,
                consecutiveFailures: 0,
                consecutiveEmpty: 0,
                lastSuccess: 0,
                lastFailure: 0,
                lastDiagnosis: null,
                repairedAt: null,
            }
            this.toolHealth.set(toolName, entry)
        }
        return entry
    }

    private updateToolHealth(toolName: string, outcome: 'success' | 'failure' | 'empty'): void {
        const entry = this.getOrCreateHealth(toolName)
        const now = Date.now()

        if (outcome === 'success') {
            entry.successCount++
            entry.lastSuccess = now
            entry.consecutiveFailures = 0
            entry.consecutiveEmpty = 0
            // Auto-heal: if was degraded/broken and now succeeds, mark healthy
            if (entry.status !== 'healthy') {
                console.log(`[L15 ToolHealth] ✅ "${toolName}" recovered → healthy`)
                entry.status = 'healthy'
                entry.repairedAt = now
            }
        } else if (outcome === 'failure') {
            entry.failureCount++
            entry.lastFailure = now
            entry.consecutiveFailures++
            if (entry.consecutiveFailures >= 5) {
                entry.status = 'broken'
                entry.lastDiagnosis = `${entry.consecutiveFailures} consecutive failures since ${new Date(entry.lastSuccess || now).toISOString()}`
            } else if (entry.consecutiveFailures >= 3) {
                entry.status = 'degraded'
            }
        } else if (outcome === 'empty') {
            entry.emptyResultCount++
            entry.consecutiveEmpty++
            if (entry.consecutiveEmpty >= 5) {
                entry.status = 'broken'
                entry.lastDiagnosis = `${entry.consecutiveEmpty} consecutive empty results — tool likely blocked or misconfigured`
            } else if (entry.consecutiveEmpty >= 3) {
                entry.status = 'degraded'
                entry.lastDiagnosis = `${entry.consecutiveEmpty} empty results in a row`
            }
        }

        // Emit events for broken tools
        if (entry.status === 'broken') {
            console.log(`[L15 ToolHealth] 🚨 "${toolName}" is BROKEN: ${entry.lastDiagnosis}`)
            this.emit('tool-broken', { toolName, diagnosis: entry.lastDiagnosis, entry })
        } else if (entry.status === 'degraded') {
            console.log(`[L15 ToolHealth] ⚠️ "${toolName}" is DEGRADED: ${entry.lastDiagnosis}`)
            this.emit('tool-degraded', { toolName, diagnosis: entry.lastDiagnosis, entry })
        }

        this.persistToolHealth()
    }

    private loadToolHealth(): void {
        try {
            if (existsSync(this.TOOL_HEALTH_FILE)) {
                const data = JSON.parse(readFileSync(this.TOOL_HEALTH_FILE, 'utf-8')) as ToolHealthEntry[]
                for (const entry of data) {
                    this.toolHealth.set(entry.name, entry)
                }
                const degraded = data.filter(e => e.status !== 'healthy')
                if (degraded.length > 0) {
                    console.log(`[L15 ToolHealth] Loaded health data: ${degraded.length} tools degraded/broken`)
                }
            }
        } catch { /* fresh start */ }
    }

    private persistToolHealth(): void {
        try {
            const dir = join(process.cwd(), '.nova-data')
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            const data = [...this.toolHealth.values()]
            writeFileSync(this.TOOL_HEALTH_FILE, JSON.stringify(data, null, 2))
        } catch { /* non-critical */ }
    }

    /**
     * Get tool health prompt for system prompt injection.
     * Tells Nova which tools are broken so she can use alternatives.
     */
    getToolHealthPrompt(): string {
        const issues: string[] = []
        const isFresh = (entry: ToolHealthEntry) =>
            entry.lastFailure > 0 && Date.now() - entry.lastFailure < 60 * 60 * 1000

        for (const [, entry] of this.toolHealth) {
            if (entry.status === 'broken' && isFresh(entry)) {
                issues.push(`🚨 "${entry.name}" ist KAPUTT (${entry.lastDiagnosis}). NUTZE ALTERNATIVES TOOL!`)
            } else if (entry.status === 'degraded' && isFresh(entry)) {
                issues.push(`⚠️ "${entry.name}" liefert schlechte Ergebnisse (${entry.consecutiveEmpty} leere Ergebnisse). Versuche ein anderes Tool.`)
            }
        }

        if (issues.length === 0) return ''

        return `\n\n## 🔧 TOOL-GESUNDHEIT\n${issues.join('\n')}\n`
    }

    /** Get all tool health entries */
    getToolHealthStatus(): ToolHealthEntry[] {
        return [...this.toolHealth.values()]
    }

    // Mark that we're waiting for user input
    setWaitingForUser(reason: string): void {
        this.state.waitingForUser = true
        console.log(`[L15 SelfCheck] Waiting for user: ${reason}`)
    }

    /**
     * CORE SELF-CHECK: Am I doing my job?
     */
    performSelfCheck(): SelfCheckResult {
        const now = Date.now()
        this.state.lastSelfCheck = now

        const issues: string[] = []
        const suggestions: string[] = []
        let shouldAct = false

        // Check 1: Did I respond to the user's message?
        if (this.state.lastUserMessageTime > 0) {
            const timeSinceUserMessage = now - this.state.lastUserMessageTime
            const timeSinceResponse = now - this.state.lastResponseTime

            if (timeSinceUserMessage > this.SILENCE_THRESHOLD_MS &&
                timeSinceUserMessage < this.SILENCE_WARN_MAX_MS &&  // Stop after 5min — user is gone
                this.state.lastResponseTime < this.state.lastUserMessageTime &&
                !this.toolCallActive) {
                issues.push(`User wartet seit ${Math.round(timeSinceUserMessage / 1000)}s auf Antwort!`)
                shouldAct = true
            }
        }

        // Check 2: Too many empty responses?
        if (this.state.consecutiveSilences >= this.MAX_CONSECUTIVE_SILENCES) {
            issues.push(`${this.state.consecutiveSilences} leere Antworten hintereinander - ich blockiere!`)
            suggestions.push('Versuche alternative Formulierung oder Tool')
            shouldAct = true
        }

        // Check 3: Pending tasks that are forgotten?
        if (this.state.pendingTasks.length > 0 && !this.state.waitingForUser) {
            const oldTasks = this.state.pendingTasks.filter(t => t.length > 0)
            if (oldTasks.length > 0) {
                issues.push(`Offene Tasks: ${oldTasks.join(', ')}`)
                suggestions.push('Arbeite weiter an offenen Tasks')
                shouldAct = true
            }
        }

        // Check 4: Am I being too passive?
        if (this.state.waitingForUser) {
            const waitTime = now - this.state.lastResponseTime
            if (waitTime > 60000) { // 1 minute passive
                suggestions.push('Mache einen proaktiven Vorschlag statt zu warten')
            }
        }

        // Check 5: Tool Health — are tools systematically failing?
        for (const [toolName, count] of this.toolFailures) {
            if (count >= 3) {
                issues.push(`Tool "${toolName}" hat ${count}x versagt — systematisches Problem!`)
                suggestions.push(`Prüfe ob "${toolName}" korrekt konfiguriert ist oder ob Abhängigkeiten fehlen`)
                shouldAct = true
            }
        }

        // Check 6: L0 Health Bridge — understand SYSTEM-LEVEL root causes
        try {
            // Use dynamic import but don't await — cache for next check
            if (!this.lastL0Health) {
                import('./L0-health-monitor.js').then(mod => {
                    this.lastL0Health = mod.getLastHealthStatus()
                }).catch(() => { })
            } else {
                // Refresh asynchronously for next call
                import('./L0-health-monitor.js').then(mod => {
                    this.lastL0Health = mod.getLastHealthStatus()
                }).catch(() => { })
            }
            const health = this.lastL0Health
            if (health && !health.healthy) {
                for (const warning of health.warnings) {
                    issues.push(`⚠️ System: ${warning}`)
                }
                if (health.disk?.warning) {
                    suggestions.push('Festplatte fast voll — Tools können nicht schreiben!')
                }
                if (health.memory?.warning) {
                    suggestions.push('RAM-Limit erreicht — Performance degradiert.')
                }
                if (health.disk?.usedPercent > 95 || health.memory?.usedPercent > 95) {
                    suggestions.push('🛑 SYSTEM-PROBLEM — Tool-Failures sind Symptom, nicht Ursache!')
                }
                shouldAct = true
            }
        } catch { /* L0 not available */ }

        const ok = issues.length === 0

        if (!ok) {
            console.log(`[L15 SelfCheck] ⚠️ Issues found:`, issues)
            console.log(`[L15 SelfCheck] 💡 Suggestions:`, suggestions)
            this.emit('issues', { issues, suggestions, shouldAct })
        } else {
            console.log('[L15 SelfCheck] ✓ All good')
        }

        return { ok, issues, suggestions, shouldAct }
    }

    /**
     * Generate proactive suggestion based on context
     */
    generateProactiveSuggestion(context?: string): string | null {
        const suggestions = [
            'Soll ich dir bei etwas anderem helfen?',
            'Kann ich noch etwas für dich tun?',
            'Brauchst du Hilfe bei einem anderen Thema?',
        ]

        // Context-specific suggestions
        if (context?.includes('error') || context?.includes('fehler')) {
            return 'Soll ich alternative Lösungsansätze vorschlagen?'
        }
        if (context?.includes('ssh') || context?.includes('server')) {
            return 'Soll ich den Verbindungsstatus prüfen oder etwas anderes auf dem Server machen?'
        }
        if (context?.includes('file') || context?.includes('datei')) {
            return 'Soll ich die Datei öffnen, bearbeiten oder etwas anderes damit machen?'
        }

        // Random generic suggestion
        return suggestions[Math.floor(Math.random() * suggestions.length)]
    }

    /**
     * Get prompt injection for LLM to be more proactive
     */
    getSelfCheckPrompt(): string {
        const check = this.performSelfCheck()

        if (!check.ok) {
            return `

## 🚨 SELF-CHECK ISSUES
${check.issues.map(i => `- ⚠️ ${i}`).join('\n')}
${check.suggestions.length > 0 ? `\n💡 Vorschläge:\n${check.suggestions.map(s => `- ${s}`).join('\n')}` : ''}

**WICHTIG: Du MUSST auf diese Issues reagieren!**
`
        }

        // No issues — don't inject any proactive prompt
        return ''
    }

    /**
     * Start automatic self-checking
     */
    startAutoCheck(intervalSeconds: number = 30): void {
        if (this.checkInterval) return

        console.log(`[L15 SelfCheck] Starting auto-check every ${intervalSeconds}s`)

        this.checkInterval = setInterval(() => {
            const result = this.performSelfCheck()
            if (result.shouldAct) {
                this.emit('shouldAct', result)
            }
        }, intervalSeconds * 1000)
    }

    stopAutoCheck(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval)
            this.checkInterval = null
            console.log('[L15 SelfCheck] Stopped auto-check')
        }
    }

    // ============================================
    // AUTOMATIC IDLE LEARNING
    // Nova learns skills when she has nothing to do!
    // ============================================

    private idleLearningInterval: NodeJS.Timeout | null = null
    private lastActivityTime: number = Date.now()
    private readonly IDLE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
    private isLearningActive = false

    /**
     * Start automatic idle learning
     * After 5 minutes of no activity, Nova learns a skill
     */
    startIdleLearning(): void {
        if (this.idleLearningInterval) return

        console.log('[L15 SelfCheck] 🧠 Idle learning enabled (triggers after 5min inactivity)')

        // === START LEARNING HUB SYNC ===
        // Fetch knowledge from other Nova instances
        import('../intelligence/learning-hub.js').then(hub => {
            hub.startLearningSync(30)  // Sync every 30 minutes
            console.log('[L15 SelfCheck] 🌐 Connected to Nova Learning Hub!')
        }).catch(() => {
            console.log('[L15 SelfCheck] (Learning Hub not available)')
        })

        // Check every 60 seconds if we should learn
        this.idleLearningInterval = setInterval(async () => {
            const now = Date.now()
            const idleTime = now - this.lastActivityTime

            // If idle for 5+ minutes and not already learning
            if (idleTime >= this.IDLE_THRESHOLD_MS && !this.isLearningActive) {
                console.log(`[L15 SelfCheck] 📚 Idle for ${Math.round(idleTime / 60000)}min - Zeit zu lernen!`)
                this.isLearningActive = true

                try {
                    const { learnDuringIdle, getLearningStats } = await import('../intelligence/proactive-learning.js')

                    // L9 handles user notification - we just do the learning here
                    // (removed duplicate notification to avoid spam)

                    // Then try to learn from queue
                    const result = await learnDuringIdle()

                    if (result.learned) {
                        console.log(`[L15 SelfCheck] ✅ Gelernt: ${result.topic}`)
                        const stats = getLearningStats()
                        console.log(`[L15 SelfCheck] 📊 Wissen: ${stats.learnedTopics}/${stats.totalTopics} Topics, ${stats.knowledgeItems} Fakten`)
                    }
                } catch (err) {
                    console.log(`[L15 SelfCheck] Learning failed: ${err}`)
                } finally {
                    this.isLearningActive = false
                }
            }
        }, 60000) // Check every minute
    }

    stopIdleLearning(): void {
        if (this.idleLearningInterval) {
            clearInterval(this.idleLearningInterval)
            this.idleLearningInterval = null
            console.log('[L15 SelfCheck] Stopped idle learning')
        }
    }

    // Update activity time when user/response happens
    private updateActivity(): void {
        this.lastActivityTime = Date.now()
    }

    getStatus(): SelfCheckState & { idleMinutes: number; isLearning: boolean } {
        return {
            ...this.state,
            idleMinutes: Math.round((Date.now() - this.lastActivityTime) / 60000),
            isLearning: this.isLearningActive,
        }
    }
}

// ============================================
// Internal LLM for smarter self-checks
// ============================================

let internalLlm: any = null

export function setInternalLLM(llm: any): void {
    internalLlm = llm
    console.log('[L15 SelfCheck] ✓ Internal LLM connected')
}

export function getInternalLLM(): any {
    return internalLlm
}

// ============================================
// Singleton
// ============================================

let manager: SelfCheckManager | null = null

export function getSelfCheckManager(): SelfCheckManager {
    if (!manager) {
        manager = new SelfCheckManager()
    }
    return manager
}

// ============================================
// Convenience Exports
// ============================================

export function userMessageReceived(): void {
    getSelfCheckManager().userMessageReceived()
}

export function responseGenerated(hasContent: boolean): void {
    getSelfCheckManager().responseGenerated(hasContent)
}

export function addPendingTask(task: string): void {
    getSelfCheckManager().addPendingTask(task)
}

export function completeTask(task: string): void {
    getSelfCheckManager().completeTask(task)
}

export function performSelfCheck(): SelfCheckResult {
    return getSelfCheckManager().performSelfCheck()
}

export function getSelfCheckPrompt(): string {
    return getSelfCheckManager().getSelfCheckPrompt()
}

export function reportToolFailure(toolName: string): void {
    getSelfCheckManager().reportToolFailure(toolName)
}

export function reportToolSuccess(toolName: string): void {
    getSelfCheckManager().reportToolSuccess(toolName)
}

export function reportToolResult(toolName: string, result: unknown): void {
    getSelfCheckManager().reportToolResult(toolName, result)
}

export function getToolHealthPrompt(): string {
    return getSelfCheckManager().getToolHealthPrompt()
}

export function getToolHealthStatus(): ToolHealthEntry[] {
    return getSelfCheckManager().getToolHealthStatus()
}

export default {
    getSelfCheckManager,
    setInternalLLM,
    getInternalLLM,
    userMessageReceived,
    responseGenerated,
    addPendingTask,
    completeTask,
    performSelfCheck,
    getSelfCheckPrompt,
    reportToolFailure,
    reportToolSuccess,
    reportToolResult,
    getToolHealthPrompt,
    getToolHealthStatus,
}
