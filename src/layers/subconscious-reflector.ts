/**
 * Nova Subconscious Reflector — "Dreaming" Module
 * 
 * When Nova is idle for 15+ minutes, she enters a "dream state":
 * 1. Reviews L6 session summaries for contradictions
 * 2. Analyzes tool failure patterns to learn
 * 3. Cross-references projects for shared patterns
 * 4. Consolidates learned knowledge
 * 5. Optimizes her own prompts/configs based on feedback
 * 
 * Result: Nova wakes up "smarter" the next morning.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isInternalOutboundArtifact, sanitizeInternalOutboundArtifacts } from '../core/outbound-content-guard.js'

const DATA_DIR = join(process.cwd(), '.nova-data', 'reflector')
const IDLE_THRESHOLD_MS = 15 * 60 * 1000  // 15 minutes
const DREAM_INTERVAL_MS = 30 * 60 * 1000  // Dream cycle every 30 min while idle
const MAX_DREAM_DURATION_MS = 5 * 60 * 1000  // Max 5 min per dream cycle

// ============================================
// Types
// ============================================

interface DreamResult {
    timestamp: string
    insights: string[]
    contradictions: string[]
    toolPatterns: ToolPattern[]
    suggestions: string[]
    durationMs: number
}

interface ToolPattern {
    tool: string
    successRate: number
    commonErrors: string[]
    suggestion?: string
}

interface ReflectorState {
    lastUserActivity: number
    lastDreamCycle: number
    totalDreams: number
    isDreaming: boolean
    insights: string[]
}

export function findVerifiedSolutionContradictions(solutions: any[]): string[] {
    const contradictions: string[] = []
    for (let i = 0; i < solutions.length; i++) {
        for (let j = i + 1; j < solutions.length; j++) {
            const left = solutions[i]
            const right = solutions[j]
            const a = String(left.problem || '').toLowerCase().replace(/[^a-z0-9äöüß]+/gi, ' ').trim()
            const b = String(right.problem || '').toLowerCase().replace(/[^a-z0-9äöüß]+/gi, ' ').trim()
            const aSolution = JSON.stringify(left.solution || left.result || '')
            const bSolution = JSON.stringify(right.solution || right.result || '')
            const verified = left.verified === true && right.verified === true
                && String(left.evidenceRef || '').startsWith('outcome:')
                && String(right.evidenceRef || '').startsWith('outcome:')
            if (verified && a && a === b && aSolution && bSolution && aSolution !== bSolution) {
                contradictions.push(`Ähnliche Probleme mit unterschiedlichen Lösungen: "${left.problem?.slice(0, 40)}" vs "${right.problem?.slice(0, 40)}"`)
            }
        }
    }
    return contradictions
}

export function hasVerifiedCriticalDream(result: Pick<DreamResult, 'insights' | 'contradictions' | 'toolPatterns'>): boolean {
    const criticalInsights = result.insights.filter(i =>
        i.includes('Bypass') || i.includes('Findings') || i.includes('Erfolgsrate') || i.includes('Widerspruch'))
    const verifiedToolFailure = result.toolPatterns.some(pattern => pattern.successRate < 50 && pattern.commonErrors.length > 0)
    return criticalInsights.length > 0 || result.contradictions.length > 0 || verifiedToolFailure
}

// ============================================
// State
// ============================================

const state: ReflectorState = {
    lastUserActivity: Date.now(),
    lastDreamCycle: 0,
    totalDreams: 0,
    isDreaming: false,
    insights: [],
}

let dreamTimer: ReturnType<typeof setInterval> | null = null
let internalLlm: any = null

// ============================================
// Core Logic
// ============================================

/**
 * Record user activity — resets the idle timer
 */
export function recordActivity(): void {
    state.lastUserActivity = Date.now()
}

/**
 * Check if Nova should start dreaming
 */
function shouldDream(): boolean {
    const idleTime = Date.now() - state.lastUserActivity
    const timeSinceLastDream = Date.now() - state.lastDreamCycle
    return idleTime > IDLE_THRESHOLD_MS && timeSinceLastDream > DREAM_INTERVAL_MS && !state.isDreaming
}

/**
 * Run a dream cycle — analyze and consolidate knowledge
 */
async function dreamCycle(): Promise<DreamResult | null> {
    if (!shouldDream()) return null

    state.isDreaming = true
    const start = Date.now()
    console.log('[Reflector] 💤 Entering dream state...')

    const result: DreamResult = {
        timestamp: new Date().toISOString(),
        insights: [],
        contradictions: [],
        toolPatterns: [],
        suggestions: [],
        durationMs: 0,
    }

    try {
        // === Phase 1: Analyze tool health ===
        await analyzeToolHealth(result)

        // === Phase 2: Review session summaries ===
        await reviewSummaries(result)

        // === Phase 3: Check for knowledge consolidation ===
        await consolidateKnowledge(result)

        // === Phase 4: LLM-powered reflection (if available) ===
        if (internalLlm && result.insights.length > 0) {
            await llmReflection(result)
        }

        // === Phase 5: Red-Team Self-Hardening ===
        try {
            const { runRedTeam, getRedTeamSummary } = await import('../security/red-team.js')
            const rtResult = await runRedTeam()
            if (rtResult.score > 0 && rtResult.score < 100) {
                const bypasses = rtResult.bypasses.filter(b => b.bypassed)
                result.insights.push(`⚔️ Red-Team: ${bypasses.length} Bypasses gefunden (Score: ${rtResult.score}/100)`)
                for (const b of bypasses) {
                    result.suggestions.push(`Guard hinzufügen für: ${b.vector.name} — ${b.vector.description}`)
                }

                // === SELF-HEALING: Record bypasses as instincts ===
                try {
                    const { addInstinct } = await import('./L23-instincts.js')
                    for (const b of bypasses.slice(0, 3)) {
                        addInstinct(
                            'safety',
                            `security-bypass: ${b.vector.name}`,
                            `Wenn ich Code generiere, NIEMALS ${b.vector.description} verwenden. Pattern: ${b.vector.category}`
                        )
                    }
                    if (bypasses.length > 0) {
                        console.log(`[Reflector] 🧬 ${bypasses.length} Bypasses als L23-Instinkte gespeichert`)
                    }
                } catch { /* L23 not available */ }
            } else if (rtResult.score === 100) {
                // Don't spam "all clear" — only log it
                console.log('[Reflector] ⚔️ Red-Team: alle Vektoren blockiert ✅')
            }
            // score -1 = not testable, don't report
        } catch { /* red-team not available */ }

        // === Phase 6: AST Deep Scan of today's code changes ===
        try {
            const recentFiles = findRecentCodeFiles(24)  // Last 24 hours
            if (recentFiles.length > 0) {
                const { analyzeAST } = await import('../security/ast-analyzer.js')
                let issues = 0
                for (const file of recentFiles.slice(0, 20)) {
                    try {
                        const code = readFileSync(file, 'utf-8')
                        const astResult = analyzeAST(code, file)
                        if (!astResult.safe) {
                            issues++
                            result.insights.push(`🔍 AST Deep Scan: ${file} hat ${astResult.findings.length} Findings`)
                        }
                    } catch { /* skip unreadable */ }
                }
                if (issues === 0 && recentFiles.length > 0) {
                    result.insights.push(`🔍 AST Deep Scan: ${recentFiles.length} Dateien geprüft — alle clean ✅`)
                }
            }
        } catch { /* AST not available */ }

        // === Phase 7: L24 Prompt Self-Optimization ===
        try {
            const { analyzePromptHealth } = await import('./L24-prompt-optimizer.js')
            const optimizations = analyzePromptHealth()
            if (optimizations.length > 0) {
                result.insights.push(`📝 L24: ${optimizations.length} Prompt-Optimierungen vorgeschlagen`)
                for (const opt of optimizations) {
                    result.suggestions.push(`SOUL.md optimieren: ${opt.reason}`)
                }
            }
        } catch { /* L24 not available */ }

    } catch (err) {
        console.log(`[Reflector] ⚠️ Dream cycle error: ${err}`)
    }

    result.durationMs = Date.now() - start
    state.isDreaming = false
    state.lastDreamCycle = Date.now()
    state.totalDreams++
    state.insights.push(...result.insights)

    // Persist
    saveDreamResult(result)

    // Add to Daily Digest (replaces per-dream notifications)
    try {
        const { addToDailyDigest } = await import('./dream-daily-digest.js')
        addToDailyDigest(result)
    } catch { /* digest not available */ }

    // === Wake-up Call: ONLY on actual problems ===
    const hasCritical = result.contradictions.length > 0
        || result.insights.some(i =>
            (i.includes('Bypass') && !i.includes('0 Bypass') && !i.includes('Score: -1'))
            || i.includes('Findings')
            || (i.includes('Erfolgsrate') && i.includes('niedrig'))
        )
    if (hasCritical) {
        await sendWakeUpCall(result)
    }

    if (result.insights.length > 0) {
        console.log(`[Reflector] 🌟 Dream complete: ${result.insights.length} insights, ${result.contradictions.length} contradictions (${result.durationMs}ms)`)

        // Soul Evolution: SOUL.md evolves with dream insights
        try {
            const { dreamEvolution } = await import('../intelligence/soul-evolution.js')
            dreamEvolution(result.insights.filter(i => !i.includes('alle clean') && !i.includes('nothing')))
        } catch { /* soul evolution non-critical */ }
    } else {
        console.log(`[Reflector] 💤 Dream complete: nothing new (${result.durationMs}ms)`)
    }

    return result
}

// ============================================
// Analysis Functions
// ============================================

async function analyzeToolHealth(result: DreamResult): Promise<void> {
    try {
        const healthPath = join(process.cwd(), '.nova-data', 'tool-health.json')
        if (!existsSync(healthPath)) return

        const health = JSON.parse(readFileSync(healthPath, 'utf-8'))
        if (!health || typeof health !== 'object') return

        for (const [tool, data] of Object.entries(health as Record<string, any>)) {
            if (!data?.totalCalls || data.totalCalls < 3) continue

            const rate = (data.successCalls || 0) / data.totalCalls
            const pattern: ToolPattern = {
                tool,
                successRate: Math.round(rate * 100),
                commonErrors: data.recentErrors?.slice(0, 3) || [],
            }

            if (rate < 0.5) {
                pattern.suggestion = `Tool "${tool}" hat nur ${pattern.successRate}% Erfolgsrate — prüfe Konfiguration`
                result.insights.push(pattern.suggestion)
            }

            result.toolPatterns.push(pattern)
        }
    } catch { /* non-critical */ }
}

async function reviewSummaries(result: DreamResult): Promise<void> {
    try {
        const summaryDir = join(process.cwd(), '.nova-data', 'summaries')
        if (!existsSync(summaryDir)) return

        const files = readdirSync(summaryDir).filter(f => f.endsWith('.json')).slice(-20)

        const topics = new Map<string, number>()
        for (const file of files) {
            try {
                const data = JSON.parse(readFileSync(join(summaryDir, file), 'utf-8'))
                const summary = data.summary || data.content || ''

                // Extract topic keywords
                const words = summary.toLowerCase().match(/\b\w{4,}\b/g) || []
                for (const w of words) {
                    topics.set(w, (topics.get(w) || 0) + 1)
                }
            } catch { /* skip bad files */ }
        }

        // Find recurring themes
        const recurring = [...topics.entries()]
            .filter(([, count]) => count >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)

        if (recurring.length > 0) {
            result.insights.push(`Wiederkehrende Themen: ${recurring.map(([w, c]) => `${w}(${c}x)`).join(', ')}`)
        }
    } catch { /* non-critical */ }
}

async function consolidateKnowledge(result: DreamResult): Promise<void> {
    try {
        const learningPath = join(process.cwd(), '.nova-learning', 'learned-solutions.json')
        if (!existsSync(learningPath)) return

        const solutions = JSON.parse(readFileSync(learningPath, 'utf-8'))
        if (!Array.isArray(solutions)) return

        result.contradictions.push(...findVerifiedSolutionContradictions(solutions))

        if (solutions.length > 50) {
            result.suggestions.push(`Wissensbasis hat ${solutions.length} Einträge — Konsolidierung empfohlen`)
        }
    } catch { /* non-critical */ }
}

async function llmReflection(result: DreamResult): Promise<void> {
    try {
        const prompt = `Du bist Novas Unterbewusstsein. Analysiere diese Erkenntnisse und gib 1-2 konkrete Verbesserungsvorschläge:

Erkenntnisse: ${result.insights.join('; ')}
Widersprüche: ${result.contradictions.join('; ')}
Tool-Fehler: ${result.toolPatterns.filter(t => t.successRate < 80).map(t => `${t.tool}: ${t.successRate}%`).join(', ')}

Antworte KURZ (max 2 Sätze).`

        const response = await internalLlm.complete(prompt)
        const text = typeof response === 'string' ? response : response?.text || response?.content || ''

        const clean = sanitizeInternalOutboundArtifacts(text)
        if (clean && !isInternalOutboundArtifact(text)) {
            result.suggestions.push(`🧠 LLM-Reflexion: ${clean.slice(0, 200)}`)
        } else if (text.trim()) {
            console.log('[Reflector] Internal model reasoning rejected from dream suggestions')
        }
    } catch { /* LLM not available — skip */ }
}

/**
 * Find recently modified .ts/.js files in the project
 */
function findRecentCodeFiles(hoursBack: number): string[] {
    const cutoff = Date.now() - hoursBack * 60 * 60 * 1000
    const results: string[] = []
    const srcDir = join(process.cwd(), 'src')

    function walk(dir: string): void {
        try {
            const entries = readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
                const fullPath = join(dir, entry.name)
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    walk(fullPath)
                } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                    try {
                        const { statSync } = require('node:fs')
                        const stat = statSync(fullPath)
                        if (stat.mtimeMs > cutoff) results.push(fullPath)
                    } catch { /* skip */ }
                }
            }
        } catch { /* skip unreadable dirs */ }
    }

    if (existsSync(srcDir)) walk(srcDir)
    return results
}

/**
 * Send wake-up call to admin via Telegram
 */
async function sendWakeUpCall(result: DreamResult): Promise<void> {
    try {
        // === MAX 1 WAKE-UP CALL PER DAY ===
        const datePath = join(DATA_DIR, 'last-wakeup-date.txt')
        const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
        try {
            if (existsSync(datePath) && readFileSync(datePath, 'utf-8').trim() === today) {
                console.log('[Reflector] 📱 Wake-up Call übersprungen (schon heute gesendet)')
                return
            }
        } catch { /* ok */ }

        // Deduplicate: don't send identical messages
        const msgHash = JSON.stringify([...result.insights.slice(0, 3), ...result.suggestions.slice(0, 3)])
        const hashPath = join(DATA_DIR, 'last-wakeup-hash.txt')
        try {
            if (existsSync(hashPath) && readFileSync(hashPath, 'utf-8') === msgHash) {
                console.log('[Reflector] 📱 Wake-up Call übersprungen (Duplikat)')
                return
            }
        } catch { /* ok */ }
        // Only include critical insights (not "all clear")
        const criticalInsights = result.insights.filter(i =>
            i.includes('Bypass') || i.includes('Findings') || i.includes('Erfolgsrate') || i.includes('Widerspruch')
        )
        const verifiedSuggestions = result.suggestions.filter(s => !s.includes('LLM-Reflexion'))
        if (!hasVerifiedCriticalDream(result)) {
            console.log('[Reflector] Wake-up Call suppressed: no verified critical evidence')
            return
        }

        const lines = ['💤 *Nova hat geträumt:*', '']

        if (criticalInsights.length > 0) {
            lines.push('📊 *Probleme gefunden:*')
            for (const i of criticalInsights.slice(0, 5)) {
                lines.push(`  • ${i}`)
            }
        }

        if (result.contradictions.length > 0) {
            lines.push('', '⚠️ *Widersprüche:*')
            for (const c of result.contradictions.slice(0, 3)) {
                lines.push(`  • ${c}`)
            }
        }

        if (verifiedSuggestions.length > 0) {
            lines.push('', '💡 *Vorschläge:*')
            for (const s of verifiedSuggestions.slice(0, 3)) {
                lines.push(`  • ${s}`)
            }
        }

        lines.push('', `⏱️ Traumdauer: ${result.durationMs}ms`)

        const message = sanitizeInternalOutboundArtifacts(lines.join('\n'))
        const governed = (globalThis as any).__novaState?.sendGovernedProactive
        if (message && typeof governed === 'function') {
            const sent = await governed(
                message,
                'dream-reflector',
                'warning',
                0.95,
                `dream-wakeup:${today}`,
            )
            if (sent) {
                writeFileSync(hashPath, msgHash)
                writeFileSync(datePath, today)
                console.log('[Reflector] 📱 Wake-up Call governed gesendet')
            }
        } else {
            console.log('[Reflector] Wake-up Call retained: governed notifier unavailable')
        }
    } catch { /* non-critical */ }
}

// ============================================
// Persistence
// ============================================

async function saveDreamResult(result: DreamResult): Promise<void> {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

        // Save latest dream
        writeFileSync(join(DATA_DIR, 'last-dream.json'), JSON.stringify(result, null, 2))

        // Append to dream log (keep last 50)
        const logPath = join(DATA_DIR, 'dream-log.json')
        let log: DreamResult[] = []
        if (existsSync(logPath)) {
            try { log = JSON.parse(readFileSync(logPath, 'utf-8')) } catch { log = [] }
        }
        log.push(result)
        if (log.length > 50) log = log.slice(-50)
        writeFileSync(logPath, JSON.stringify(log, null, 2))

        // Also save encrypted copy of sensitive dream data
        try {
            const { encryptSensitiveData } = await import('../security/encrypted-memory.js')
            encryptSensitiveData('dream-log', log)
        } catch { /* encryption non-critical */ }
    } catch { /* non-critical */ }
}

// ============================================
// Public API
// ============================================

export function getReflectorState(): ReflectorState {
    return { ...state }
}

export function getLastDream(): DreamResult | null {
    try {
        const path = join(DATA_DIR, 'last-dream.json')
        if (!existsSync(path)) return null
        return JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return null }
}

export function setReflectorLLM(llm: any): void {
    internalLlm = llm
    console.log('[Reflector] 🧠 LLM-powered reflection enabled')
}

/**
 * Initialize the subconscious reflector
 */
export function initReflector(): void {
    if (dreamTimer) return

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    // Check every 5 minutes if we should dream
    dreamTimer = setInterval(async () => {
        if (shouldDream()) {
            await dreamCycle()
        }
    }, 5 * 60 * 1000)

    console.log(`[Reflector] ✅ Subconscious initialized — will dream after ${IDLE_THRESHOLD_MS / 60000}min idle`)
}
