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
import { getGoalManager, SELF_GOAL_OWNER, type NovaGoal } from '../core/goal-manager.js'
import { markMigrated } from '../planner/migration-files.js'

const DATA_DIR = join(process.cwd(), '.nova-data')
/** P9: only read once for the migration into the one goal store (goals.json). */
const LEGACY_SELF_GOALS_FILE = join(DATA_DIR, 'self-goals.json')
const INSIGHTS_FILE = join(DATA_DIR, 'insights.json')
const CONSOLIDATION_FILE = join(DATA_DIR, 'memory-consolidation.json')

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// ============================================
// Types
// ============================================

/** View of a self-goal; stored as a NovaGoal (origin 'selbst') in the goal manager. */
export interface SelfGoal {
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

const SELF_GOAL_PRIORITY = 30

function toSelfGoal(goal: NovaGoal): SelfGoal {
    const status: SelfGoal['status'] = goal.status === 'completed' ? 'done'
        : goal.status === 'cancelled' || goal.status === 'failed' ? 'skipped' : 'pending'
    const finished = status !== 'pending'
    return {
        id: goal.id, goal: goal.title, reason: goal.reason || '', status,
        createdAt: Date.parse(goal.createdAt) || 0,
        ...(finished ? { completedAt: Date.parse(goal.updatedAt) || undefined } : {}),
        ...(goal.result ? { result: goal.result } : {}),
    }
}

function selfGoals(): SelfGoal[] {
    return getGoalManager().list(SELF_GOAL_OWNER).filter(goal => goal.origin === 'selbst' || !goal.origin).map(toSelfGoal)
}

/** P9: self-goals.json → goals.json (once, idempotent by id); the old file becomes `.migriert`. */
export function migrateLegacySelfGoals(file = LEGACY_SELF_GOALS_FILE, now = Date.now()): number {
    if (!existsSync(file)) return 0
    let legacy: SelfGoal[] = []
    try { legacy = JSON.parse(readFileSync(file, 'utf-8')) } catch { legacy = [] }
    const manager = getGoalManager()
    let moved = 0
    for (const item of Array.isArray(legacy) ? legacy : []) {
        if (!item || typeof item.goal !== 'string' || !item.goal.trim()) continue
        const stale = item.status === 'pending' && Number(item.createdAt) < now - 3 * 24 * 60 * 60 * 1000
        const status = item.status === 'done' ? 'completed' : item.status === 'skipped' || stale ? 'cancelled' : 'active'
        const id = `selbst-${String(item.id || moved).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`
        manager.create({
            id, userId: SELF_GOAL_OWNER, title: item.goal.slice(0, 300), dependencies: [], priority: SELF_GOAL_PRIORITY,
            origin: 'selbst', reason: String(item.reason || '').slice(0, 300), status,
        })
        const result = item.result || (stale ? 'beim Übernehmen archiviert: älter als 3 Tage' : '')
        if (result && !manager.list(SELF_GOAL_OWNER).find(goal => goal.id === id)?.result) manager.update(id, { result })
        moved++
    }
    markMigrated(file)
    return moved
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
    private llm: any = null
    private intervalId: ReturnType<typeof setInterval> | null = null

    constructor() {
        const moved = migrateLegacySelfGoals()
        if (moved) console.log(`[Autonomy] ${moved} Selbst-Ziel(e) aus self-goals.json in den Ziel-Speicher übernommen`)
        this.sanitizeUnsafeGoals()
        this.archiveStaleGoals()
        console.log(`[Autonomy] Self-Goals: ${selfGoals().filter(g => g.status === 'pending').length} pending`)
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
        for (const goal of selfGoals().filter(g => g.status === 'pending')) {
            if (goal.createdAt < cutoff) {
                this.skipGoal(goal.id, `archived at restart — too old (created ${new Date(goal.createdAt).toISOString()})`, true)
                archived++
            }
        }
        if (archived > 0) console.log(`[Autonomy] 🗑️  Archived ${archived} stale pending goal(s) older than 3 days`)
    }

    setLLM(llm: any): void {
        this.llm = llm
    }

    private sanitizeUnsafeGoals(): void {
        for (const goal of selfGoals().filter(g => g.status !== 'skipped')) {
            const decision = isSafeSelfGoal(goal.goal, goal.reason)
            if (!decision.safe) {
                this.skipGoal(goal.id, decision.reason || 'Unsafe self-goal', true)
                console.log(`[Autonomy] Unsafe pending self-goal archived: "${goal.goal}"`)
            }
        }
    }

    /**
     * Generate new goals based on Nova's current state
     */
    async generateGoals(): Promise<SelfGoal[]> {
        if (!hasGlobalAutonomyAuthority()) return []
        if (!this.llm) return []

        try {
            const goals = selfGoals()
            const pendingCount = goals.filter(g => g.status === 'pending').length
            if (pendingCount >= 5) {
                console.log('[Autonomy] Already 5+ pending goals, skipping generation')
                return []
            }

            const completedGoals = goals
                .filter(g => g.status === 'done')
                .slice(-5)
                .map(g => g.goal)

            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: `Du bist Xaventras Autonomie-Modul. Du erzeugst SINNVOLLE Selbst-Ziele, die Xaventra selbstständig verfolgen kann.
Regeln:
- Nur sichere Read-only/System-Analyse-Ziele, die mit lokalen Tools erreichbar sind (Logs lesen, Status prüfen, Code analysieren, Befunde sammeln)
- Keine Ziele, die User-Interaktion brauchen
- Keine Käufe, Verkäufe, Zahlungen, Shop-/Business-Abwicklung, Wallets, Bank oder echte externe Aktionen
- Keine Deploys, Restarts, SSH-Änderungen, Secrets, Logins oder produktiven Systemänderungen ohne ausdrücklichen User-Befehl
- Praktisch und nützlich (System-Checks, Wissensaufbau, Optimierungen)
- Max 3 neue Ziele pro Runde
- Format: JSON Array mit {goal, reason}
- KEINE Ziele, die schon erledigt wurden`
                },
                {
                    role: 'user',
                    content: `Bereits erledigte Ziele: ${completedGoals.join(', ') || 'keine'}
Aktuell offene Ziele: ${pendingCount}
Was sind 1-3 sinnvolle nächste Ziele?
Antworte NUR mit einem JSON-Array.`
                },
            ])

            const text = response.content?.trim() || ''
            // Extract JSON from response
            const jsonMatch = text.match(/\[[\s\S]*\]/)
            if (!jsonMatch) return []

            const parsed = JSON.parse(jsonMatch[0])
            const manager = getGoalManager()
            const newGoals: SelfGoal[] = parsed
                .slice(0, 3)
                .filter((g: any) => {
                    const decision = isSafeSelfGoal(String(g.goal || ''), String(g.reason || ''))
                    if (!decision.safe) console.log(`[Autonomy] Self-goal rejected: "${String(g.goal || '').slice(0, 80)}" (${decision.reason})`)
                    return decision.safe && String(g.goal || '').trim().length > 0
                })
                .map((g: any) => toSelfGoal(manager.create({
                    userId: SELF_GOAL_OWNER, title: String(g.goal).slice(0, 300), dependencies: [], priority: SELF_GOAL_PRIORITY,
                    origin: 'selbst', reason: String(g.reason || '').slice(0, 300),
                })))

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
        for (const goal of selfGoals().filter(g => g.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)) {
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
        const updated = getGoalManager().update(goalId, { status: 'completed', result })
        if (updated) console.log(`[Autonomy] ✅ Goal completed: "${updated.title}"`)
    }

    skipGoal(goalId: string, reason: string, quiet = false): void {
        const updated = getGoalManager().update(goalId, { status: 'cancelled', result: reason })
        if (updated && !quiet) console.log(`[Autonomy] Self-goal skipped: "${updated.title}" - ${reason}`)
    }

    /**
     * Start periodic goal generation (every 2 hours)
     */
    start(): void {
        if (this.intervalId) return

        // Generate initial goals after 5 minutes
        setTimeout(() => {
            this.generateGoals().catch(() => { })
        }, 5 * 60 * 1000).unref?.()

        // Then every 2 hours
        this.intervalId = setInterval(() => {
            this.generateGoals().catch(() => { })
        }, 2 * 60 * 60 * 1000)
        this.intervalId.unref?.()

        console.log('[Autonomy] 🎯 Self-Goal engine started')
    }

    getStats() {
        const goals = selfGoals()
        return {
            total: goals.length,
            pending: goals.filter(g => g.status === 'pending').length,
            done: goals.filter(g => g.status === 'done').length,
            goals: goals.slice(-10),
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
     * Build prompt block for undelivered insights.
     * Insights are global (self-reflection on other users' chats, service and
     * node failures) — owner prompts only. Anyone else gets nothing and the
     * insights stay undelivered for the owner.
     */
    buildInsightPromptBlock(viewer?: { permission?: string }): string | null {
        if (viewer?.permission !== 'owner') return null
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

            // Load the owner's active decisions (the one rule system)
            let rules: string[] = []
            try {
                const { listDecisions } = await import('../core/decisions.js')
                rules = listDecisions().filter(item => item.status === 'aktiv' && item.bindend).slice(-10).map(item => item.text)
            } catch { /* decisions not available */ }

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
     * Get consolidation context for system prompt.
     * The weekly summary is built from every user's journal — owner prompts only.
     */
    getConsolidationContext(viewer?: { permission?: string }): string | null {
        if (viewer?.permission !== 'owner') return null
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
