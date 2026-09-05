/**
 * Nova Autonomy Engine (P2)
 * 
 * Three capabilities that make Nova genuinely autonomous:
 * 1. Self-Goal-Setting — Nova generates her own tasks during idle time
 * 2. Proactive Insights — "I noticed X" messages to the user
 * 3. Weekly Memory Consolidation — summarize and compress memories
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hasGlobalAutonomyAuthority } from '../core/autonomy-authority.js'

const DATA_DIR = join(process.cwd(), '.nova-data')
const GOALS_FILE = join(DATA_DIR, 'self-goals.json')
const INSIGHTS_FILE = join(DATA_DIR, 'insights.json')
const CONSOLIDATION_FILE = join(DATA_DIR, 'memory-consolidation.json')

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// ============================================
// Types
// ============================================

interface SelfGoal {
    id: string
    goal: string
    reason: string
    status: 'pending' | 'in-progress' | 'done' | 'skipped'
    createdAt: number
    completedAt?: number
    result?: string
}

const BLOCKED_SELF_GOAL_PATTERNS = [
    /kauf|verkauf|verkaufen|kaufen|shop|checkout|zahlung|paypal|stripe|rechnung|versand/i,
    /bestell|order|trading|trade|wallet|crypto|bank|konto|Ã¼berweis|uberweis/i,
    /login|passwort|credential|token|api.?key|secret/i,
    /deploy|restart|systemctl|ssh|produktion|production/i,
]

export function isSafeSelfGoal(goal: string, reason = ''): { safe: boolean; reason?: string } {
    const text = `${goal}\n${reason}`
    const blocked = BLOCKED_SELF_GOAL_PATTERNS.find(pattern => pattern.test(text))
    if (blocked) {
        return {
            safe: false,
            reason: 'Self-Goals duerfen keine externen, finanziellen, Login-, Deploy- oder Produktionsaktionen ohne explizite User-Freigabe starten.',
        }
    }
    return { safe: true }
}

interface Insight {
    id: string
    type: 'observation' | 'suggestion' | 'warning' | 'learning'
    content: string
    delivered: boolean
    createdAt: number
    deliveredAt?: number
}

interface ConsolidationResult {
    period: string
    totalMemories: number
    consolidatedTo: number
    summary: string
    timestamp: number
}

// ============================================
// Storage Helpers
// ============================================

function loadGoals(): SelfGoal[] {
    try {
        if (existsSync(GOALS_FILE)) return JSON.parse(readFileSync(GOALS_FILE, 'utf-8'))
    } catch { /* fresh */ }
    return []
}

function saveGoals(goals: SelfGoal[]): void {
    ensureDir()
    writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2))
}

function loadInsights(): Insight[] {
    try {
        if (existsSync(INSIGHTS_FILE)) return JSON.parse(readFileSync(INSIGHTS_FILE, 'utf-8'))
    } catch { /* fresh */ }
    return []
}

function saveInsights(insights: Insight[]): void {
    ensureDir()
    writeFileSync(INSIGHTS_FILE, JSON.stringify(insights, null, 2))
}

function loadConsolidations(): ConsolidationResult[] {
    try {
        if (existsSync(CONSOLIDATION_FILE)) return JSON.parse(readFileSync(CONSOLIDATION_FILE, 'utf-8'))
    } catch { /* fresh */ }
    return []
}

function saveConsolidations(results: ConsolidationResult[]): void {
    ensureDir()
    writeFileSync(CONSOLIDATION_FILE, JSON.stringify(results, null, 2))
}

// ============================================
// 1. SELF-GOAL-SETTING
// ============================================

class SelfGoalEngine {
    private goals: SelfGoal[] = []
    private llm: any = null
    private intervalId: ReturnType<typeof setInterval> | null = null

    constructor() {
        this.goals = loadGoals()
        this.sanitizeUnsafeGoals()
        this.archiveStaleGoals()
        console.log(`[Autonomy] Self-Goals: ${this.goals.filter(g => g.status === 'pending').length} pending`)
    }

    /**
     * Archive pending goals that are older than GOAL_MAX_AGE_MS.
     * Prevents stale goals from accumulating across restarts and being
     * executed with outdated context (e.g. the "Kauf/Verkauf" goal ghost).
     */
    private archiveStaleGoals(): void {
        const GOAL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
        const cutoff = Date.now() - GOAL_MAX_AGE_MS
        let archived = 0
        for (const goal of this.goals.filter(g => g.status === 'pending')) {
            if (goal.createdAt < cutoff) {
                goal.status = 'skipped'
                goal.completedAt = Date.now()
                goal.result = `archived at restart — too old (created ${new Date(goal.createdAt).toISOString()})`
                archived++
            }
        }
        if (archived > 0) {
            saveGoals(this.goals)
            console.log(`[Autonomy] 🗑️  Archived ${archived} stale pending goal(s) older than 3 days`)
        }
    }

    setLLM(llm: any): void {
        this.llm = llm
    }

    private sanitizeUnsafeGoals(): void {
        let changed = false
        for (const goal of this.goals.filter(g => g.status !== 'skipped')) {
            const decision = isSafeSelfGoal(goal.goal, goal.reason)
            if (!decision.safe) {
                goal.status = 'skipped'
                goal.completedAt = Date.now()
                goal.result = decision.reason
                changed = true
                console.log(`[Autonomy] Unsafe pending self-goal archived: "${goal.goal}"`)
            }
        }
        if (changed) saveGoals(this.goals)
    }

    /**
     * Generate new goals based on Nova's current state
     */
    async generateGoals(): Promise<SelfGoal[]> {
        if (!hasGlobalAutonomyAuthority()) return []
        if (!this.llm) return []

        try {
            // Gather context about what Nova knows
            const pendingCount = this.goals.filter(g => g.status === 'pending').length
            if (pendingCount >= 5) {
                console.log('[Autonomy] Already 5+ pending goals, skipping generation')
                return []
            }

            const completedGoals = this.goals
                .filter(g => g.status === 'done')
                .slice(-5)
                .map(g => g.goal)

            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: `Du bist Novas Autonomie-Modul. Du generierst SINNVOLLE Selbst-Ziele, die Nova autonom verfolgen kann.
Regeln:
- Nur sichere Read-only/System-Analyse-Ziele die Nova mit lokalen Tools erreichen kann (Logs lesen, Status prÃ¼fen, Code analysieren, Findings sammeln)
- Keine Ziele die User-Interaktion brauchen
- Keine KÃ¤ufe, VerkÃ¤ufe, Zahlungen, Shop-/Business-Abwicklung, Wallets, Bank oder echte externe Aktionen
- Keine Deploys, Restarts, SSH-Ã„nderungen, Secrets, Logins oder produktiven SystemÃ¤nderungen ohne expliziten User-Befehl
- Praktisch und nützlich (System-Checks, Wissensaufbau, Optimierungen)
- Max 3 neue Ziele pro Runde
- Format: JSON Array mit {goal, reason}
- KEINE Ziele die schon erledigt wurden`
                },
                {
                    role: 'user',
                    content: `Bereits erledigte Ziele: ${completedGoals.join(', ') || 'keine'}
Aktuell offene Ziele: ${pendingCount}
Was sind 1-3 sinnvolle nächste Ziele für Nova?
Antworte NUR mit einem JSON-Array.`
                },
            ])

            const text = response.content?.trim() || ''
            // Extract JSON from response
            const jsonMatch = text.match(/\[[\s\S]*\]/)
            if (!jsonMatch) return []

            const parsed = JSON.parse(jsonMatch[0])
            const newGoals: SelfGoal[] = parsed
                .slice(0, 3)
                .filter((g: any) => {
                    const decision = isSafeSelfGoal(String(g.goal || ''), String(g.reason || ''))
                    if (!decision.safe) console.log(`[Autonomy] Self-goal rejected: "${String(g.goal || '').slice(0, 80)}" (${decision.reason})`)
                    return decision.safe
                })
                .map((g: any) => ({
                    id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    goal: g.goal,
                    reason: g.reason || '',
                    status: 'pending' as const,
                    createdAt: Date.now(),
                }))

            this.goals.push(...newGoals)
            saveGoals(this.goals)

            for (const g of newGoals) {
                console.log(`[Autonomy] 🎯 New self-goal: "${g.goal}" (${g.reason})`)
            }

            return newGoals
        } catch (err) {
            console.log(`[Autonomy] Goal generation failed: ${err}`)

            // Queue error for idle learning so Nova researches the fix
            try {
                const { addTopicFromError } = await import('./proactive-learning.js')
                addTopicFromError(`Autonomy goal generation: ${String(err).slice(0, 80)}`, 'Autonomy Engine')
            } catch { /* non-critical */ }

            return []
        }
    }

    /**
     * Get next pending goal to work on
     */
    getNextGoal(): SelfGoal | null {
        for (const goal of this.goals.filter(g => g.status === 'pending')) {
            const decision = isSafeSelfGoal(goal.goal, goal.reason)
            if (decision.safe) return goal
            this.skipGoal(goal.id, decision.reason || 'Unsafe self-goal')
        }
        return null
    }

    /**
     * Mark goal as done
     */
    completeGoal(goalId: string, result: string): void {
        const goal = this.goals.find(g => g.id === goalId)
        if (goal) {
            goal.status = 'done'
            goal.completedAt = Date.now()
            goal.result = result
            saveGoals(this.goals)
            console.log(`[Autonomy] ✅ Goal completed: "${goal.goal}"`)
        }
    }

    skipGoal(goalId: string, reason: string): void {
        const goal = this.goals.find(g => g.id === goalId)
        if (goal) {
            goal.status = 'skipped'
            goal.completedAt = Date.now()
            goal.result = reason
            saveGoals(this.goals)
            console.log(`[Autonomy] Self-goal skipped: "${goal.goal}" - ${reason}`)
        }
    }

    /**
     * Start periodic goal generation (every 2 hours)
     */
    start(): void {
        if (this.intervalId) return

        // Generate initial goals after 5 minutes
        setTimeout(() => {
            this.generateGoals().catch(() => { })
        }, 5 * 60 * 1000)

        // Then every 2 hours
        this.intervalId = setInterval(() => {
            this.generateGoals().catch(() => { })
        }, 2 * 60 * 60 * 1000)

        console.log('[Autonomy] 🎯 Self-Goal engine started')
    }

    getStats() {
        return {
            total: this.goals.length,
            pending: this.goals.filter(g => g.status === 'pending').length,
            done: this.goals.filter(g => g.status === 'done').length,
            goals: this.goals.slice(-10),
        }
    }
}

// ============================================
// 2. PROACTIVE INSIGHTS
// ============================================

class InsightEngine {
    private insights: Insight[] = []
    private llm: any = null
    private sendFn: ((userId: string, channel: string, content: string) => Promise<void>) | null = null

    constructor() {
        this.insights = loadInsights()
    }

    setLLM(llm: any): void {
        this.llm = llm
    }

    setSendFunction(fn: (userId: string, channel: string, content: string) => Promise<void>): void {
        this.sendFn = fn
    }

    /**
     * Record an insight (called from various layers)
     */
    recordInsight(type: Insight['type'], content: string): void {
        // Deduplicate — don't record the same insight twice in 24h
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000
        const isDuplicate = this.insights.some(i =>
            i.content === content && i.createdAt > dayAgo
        )
        if (isDuplicate) return

        const insight: Insight = {
            id: `insight_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type,
            content,
            delivered: false,
            createdAt: Date.now(),
        }
        this.insights.push(insight)

        // Keep only last 100 insights
        if (this.insights.length > 100) {
            this.insights = this.insights.slice(-100)
        }
        saveInsights(this.insights)

        console.log(`[Autonomy] 💡 Insight recorded: [${type}] ${content.slice(0, 80)}`)
    }

    /**
     * Get undelivered insights for injection into next message
     */
    getUndeliveredInsights(maxCount: number = 3): Insight[] {
        return this.insights
            .filter(i => !i.delivered)
            .slice(0, maxCount)
    }

    /**
     * Mark insights as delivered
     */
    markDelivered(insightIds: string[]): void {
        for (const id of insightIds) {
            const insight = this.insights.find(i => i.id === id)
            if (insight) {
                insight.delivered = true
                insight.deliveredAt = Date.now()
            }
        }
        saveInsights(this.insights)
    }

    /**
     * Build prompt block for undelivered insights
     */
    buildInsightPromptBlock(): string | null {
        const undelivered = this.getUndeliveredInsights(3)
        if (undelivered.length === 0) return null

        const insightBlock = undelivered
            .map(i => {
                const icon = i.type === 'warning' ? '⚠️' : i.type === 'observation' ? '👁️' : i.type === 'suggestion' ? '💡' : '📚'
                return `- ${icon} ${i.content}`
            })
            .join('\n')

        // Mark as delivered
        this.markDelivered(undelivered.map(i => i.id))

        return `\n\n## PROAKTIVE BEOBACHTUNGEN
Du hast Folgendes bemerkt. Erwähne es KURZ am Ende deiner Antwort, WENN es relevant ist:
${insightBlock}
(Nur erwähnen wenn es zum Gespräch passt — nicht erzwingen!)`
    }

    getStats() {
        return {
            total: this.insights.length,
            undelivered: this.insights.filter(i => !i.delivered).length,
            delivered: this.insights.filter(i => i.delivered).length,
        }
    }
}

// ============================================
// 3. WEEKLY MEMORY CONSOLIDATION
// ============================================

class MemoryConsolidator {
    private consolidations: ConsolidationResult[] = []
    private llm: any = null
    private intervalId: ReturnType<typeof setInterval> | null = null

    constructor() {
        this.consolidations = loadConsolidations()
    }

    setLLM(llm: any): void {
        this.llm = llm
    }

    /**
     * Consolidate recent memories into a summary
     */
    async consolidate(): Promise<ConsolidationResult | null> {
        if (!hasGlobalAutonomyAuthority()) return null
        if (!this.llm) {
            console.log('[Autonomy] No LLM for consolidation')
            return null
        }

        try {
            // Check if we already consolidated recently (within 7 days)
            const lastConsolidation = this.consolidations[this.consolidations.length - 1]
            if (lastConsolidation && Date.now() - lastConsolidation.timestamp < 7 * 24 * 60 * 60 * 1000) {
                console.log('[Autonomy] Memory consolidation skipped — last one was less than 7 days ago')
                return null
            }

            // Load journal entries from last 7 days
            let journalEntries: string[] = []
            try {
                const journal = await import('../memory/journal.js')
                const entries = journal.default.getRecentEntries?.(7) || []
                journalEntries = entries.map((e: any) =>
                    `${new Date(e.timestamp || e.date).toLocaleDateString('de-DE')}: ${e.summary || e.events?.map((ev: any) => ev.content || ev).join(', ') || ''}`
                )
            } catch { /* journal not available */ }

            // Load recent self-rules
            let rules: string[] = []
            try {
                const { getSelfImprovementEngine } = await import('../layers/L20-self-improvement.js')
                const engine = getSelfImprovementEngine()
                rules = engine.getRules().slice(-10).map((r: any) => r.rule)
            } catch { /* rules not available */ }

            if (journalEntries.length === 0 && rules.length === 0) {
                console.log('[Autonomy] Nothing to consolidate')
                return null
            }

            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: `Du bist Novas Memory-Consolidation-Modul. Fasse die Erfahrungen der letzten Woche in 3-5 Sätzen zusammen. Fokus auf: Was wurde gelernt? Was lief gut? Was war problematisch? Welche Muster erkennst du?`
                },
                {
                    role: 'user',
                    content: `Journal der letzten 7 Tage:\n${journalEntries.slice(0, 20).join('\n') || 'Keine Einträge'}

Gelernte Regeln:\n${rules.join('\n') || 'Keine Regeln'}

Erstelle eine konzise Wochenzusammenfassung.`
                },
            ])

            const summary = response.content?.trim()
            if (!summary) return null

            const result: ConsolidationResult = {
                period: `${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('de-DE')} - ${new Date().toLocaleDateString('de-DE')}`,
                totalMemories: journalEntries.length + rules.length,
                consolidatedTo: 1,
                summary,
                timestamp: Date.now(),
            }

            this.consolidations.push(result)
            // Keep only last 12 consolidations (3 months)
            if (this.consolidations.length > 12) {
                this.consolidations = this.consolidations.slice(-12)
            }
            saveConsolidations(this.consolidations)

            console.log(`[Autonomy] 📦 Memory consolidated: "${summary.slice(0, 100)}..."`)
            return result
        } catch (err) {
            console.log(`[Autonomy] Memory consolidation failed: ${err}`)
            return null
        }
    }

    /**
     * Get consolidation context for system prompt
     */
    getConsolidationContext(): string | null {
        if (this.consolidations.length === 0) return null

        const recent = this.consolidations.slice(-3)
        const block = recent
            .map(c => `- **${c.period}**: ${c.summary}`)
            .join('\n')

        return `\n\n## LANGZEIT-GEDÄCHTNIS (Wochen-Zusammenfassungen)\n${block}`
    }

    /**
     * Start weekly consolidation (check every 24h)
     */
    start(): void {
        if (this.intervalId) return

        // First check after 10 minutes
        setTimeout(() => {
            this.consolidate().catch(() => { })
        }, 10 * 60 * 1000)

        // Then every 24 hours
        this.intervalId = setInterval(() => {
            this.consolidate().catch(() => { })
        }, 24 * 60 * 60 * 1000)

        console.log('[Autonomy] 📦 Memory consolidation started (weekly)')
    }

    getStats() {
        return {
            totalConsolidations: this.consolidations.length,
            last: this.consolidations[this.consolidations.length - 1] || null,
        }
    }
}

// ============================================
// Singletons
// ============================================

let goalEngine: SelfGoalEngine | null = null
let insightEngine: InsightEngine | null = null
let consolidator: MemoryConsolidator | null = null

export function getSelfGoalEngine(): SelfGoalEngine {
    if (!goalEngine) goalEngine = new SelfGoalEngine()
    return goalEngine
}

export function getInsightEngine(): InsightEngine {
    if (!insightEngine) insightEngine = new InsightEngine()
    return insightEngine
}

export function getMemoryConsolidator(): MemoryConsolidator {
    if (!consolidator) consolidator = new MemoryConsolidator()
    return consolidator
}

export function setInternalLLM(llm: any): void {
    getSelfGoalEngine().setLLM(llm)
    getInsightEngine().setLLM(llm)
    getMemoryConsolidator().setLLM(llm)
    console.log('[Autonomy] ✓ Internal LLM connected to all autonomy modules')
}

export function startAll(): void {
    getSelfGoalEngine().start()
    getMemoryConsolidator().start()
    console.log('[Autonomy] ✓ All autonomy engines started')
}

export default {
    getSelfGoalEngine,
    getInsightEngine,
    getMemoryConsolidator,
    setInternalLLM,
    startAll,
    isSafeSelfGoal,
}
