/**
 * Layer 20 - Self-Improvement Loop
 * 
 * Analyzes L7 corrections to find recurring patterns,
 * generates rules that get injected into the system prompt,
 * and automatically patches Nova's behavior.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

interface SelfRule {
    id: string
    pattern: string          // What triggers this rule
    rule: string             // The instruction to inject
    source: 'correction' | 'feedback' | 'manual'
    confidence: number       // 0-1, how confident we are
    appliedCount: number     // How many times this rule influenced responses
    createdAt: number
    lastApplied?: number
    userId?: string            // correction-derived rules are principal-scoped
}

interface ImprovementStats {
    totalRules: number
    totalCorrectionsAnalyzed: number
    lastAnalysis: number | null
    rulesApplied: number
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const RULES_FILE = join(DATA_DIR, 'self-rules.json')

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function loadRules(): SelfRule[] {
    ensureDir()
    try {
        if (existsSync(RULES_FILE)) {
            return JSON.parse(readFileSync(RULES_FILE, 'utf-8'))
        }
    } catch { /* ignore */ }
    return []
}

function saveRules(rules: SelfRule[]): void {
    ensureDir()
    writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2))
}

// ============================================
// Self-Improvement Engine
// ============================================

class SelfImprovementEngine {
    private rules: SelfRule[] = []
    private stats: ImprovementStats = {
        totalRules: 0,
        totalCorrectionsAnalyzed: 0,
        lastAnalysis: null,
        rulesApplied: 0,
    }
    private intervalId: ReturnType<typeof setInterval> | null = null
    private llm: any = null
    private lastEvolutionProposal: number = 0

    setLLM(llm: any): void {
        this.llm = llm
        console.log('[L20 Self-Improvement] ✓ Internal LLM connected — smart rule synthesis enabled')
    }

    constructor() {
        this.rules = loadRules()
        this.stats.totalRules = this.rules.length
        console.log(`[L20 Self-Improvement] Loaded ${this.rules.length} self-rules`)
    }

    /**
     * Analyze corrections and generate new rules
     */
    async analyzeCorrections(): Promise<number> {
        let newRules = 0
        try {
            const { getCorrectionLearner } = await import('./L7-learning.js')
            const learner = getCorrectionLearner()
            const corrections = learner.getRecentCorrections?.(20) || []

            if (corrections.length === 0) {
                console.log('[L20] No corrections to analyze')
                return 0
            }

            this.stats.totalCorrectionsAnalyzed += corrections.length

            // Group corrections by similar context
            const groups = new Map<string, typeof corrections>()
            for (const c of corrections) {
                const key = `${c.userId || 'legacy'}::${this.normalizeContext(c.context || '')}`
                if (!groups.has(key)) groups.set(key, [])
                groups.get(key)!.push(c)
            }

            // Generate rules from groups with 1+ corrections (pattern)
            for (const [scopedContext, group] of groups) {
                if (group.length < 1) continue
                const separator = scopedContext.indexOf('::')
                const userId = scopedContext.slice(0, separator)
                const context = scopedContext.slice(separator + 2)

                const existingRule = this.rules.find(r => r.pattern === context && r.userId === userId)
                if (existingRule) {
                    existingRule.confidence = Math.min(1, existingRule.confidence + 0.1)
                    continue
                }

                // Extract rule — use LLM if available for smarter synthesis
                const correctedResponses = group.map(c => c.correctedResponse || '')
                const originals = group.map(c => c.originalResponse || '')
                let synthesizedRule: string | null = null

                if (this.llm) {
                    synthesizedRule = await this.synthesizeRuleWithLLM(context, originals, correctedResponses)
                }
                if (!synthesizedRule) {
                    synthesizedRule = this.findCommonInstruction(correctedResponses)
                }

                if (synthesizedRule) {
                    const rule: SelfRule = {
                        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        pattern: context,
                        rule: synthesizedRule,
                        source: 'correction',
                        confidence: Math.min(1, group.length * 0.3),
                        appliedCount: 0,
                        createdAt: Date.now(),
                        userId,
                    }
                    this.rules.push(rule)
                    newRules++
                    console.log(`[L20] New rule${this.llm ? ' (LLM)' : ''}: "${synthesizedRule.slice(0, 80)}" (confidence: ${rule.confidence})`)
                }
            }

            this.stats.totalRules = this.rules.length
            this.stats.lastAnalysis = Date.now()
            saveRules(this.rules)

        } catch (err) {
            console.log(`[L20] Analysis error: ${err}`)
        }

        return newRules
    }

    /**
     * Get rules relevant to a user message for prompt injection
     */
    getRulesForContext(message: string, userId?: string): string[] {
        const lowerMessage = message.toLowerCase()
        const relevant: string[] = []

        for (const rule of this.rules) {
            if (rule.confidence < 0.3) continue
            if (rule.source === 'correction') {
                if (userId && rule.userId !== userId) continue
                if (!userId && rule.userId && rule.userId !== 'legacy') continue
            }

            // Check if any words from the pattern appear in the message
            const patternWords = rule.pattern.toLowerCase().split(/\s+/).filter(w => w.length > 3)
            const matchCount = patternWords.filter(w => lowerMessage.includes(w)).length
            const matchRatio = patternWords.length > 0 ? matchCount / patternWords.length : 0

            if (matchRatio >= 0.3) {
                relevant.push(rule.rule)
                rule.appliedCount++
                this.stats.rulesApplied++
                rule.lastApplied = Date.now()
            }
        }

        if (relevant.length > 0) {
            saveRules(this.rules)
        }

        return relevant.slice(0, 5) // Max 5 rules per prompt
    }

    /**
     * Build prompt block for system prompt injection
     */
    buildPromptBlock(message: string, userId?: string): string | null {
        const rules = this.getRulesForContext(message, userId)
        const parts: string[] = []

        if (rules.length > 0) {
            parts.push(`## SELBST-GELERNTE REGELN\nDiese Regeln hat Nova aus vergangenen Korrekturen gelernt:\n${rules.map(r => `- ${r}`).join('\n')}`)
        }

        // Inject trace-based performance insights if available
        try {
            const insightsPath = join(DATA_DIR, 'trace-insights.json')
            if (existsSync(insightsPath)) {
                const insights = JSON.parse(readFileSync(insightsPath, 'utf-8'))
                if (insights?.recommendations?.length > 0) {
                    parts.push(`## PERFORMANCE-ERKENNTNISSE (automatisch)\n${insights.recommendations.map((r: string) => `- ${r}`).join('\n')}`)
                }
            }
        } catch { /* non-critical */ }

        return parts.length > 0 ? '\n\n' + parts.join('\n\n') : null
    }

    /**
     * Add a manual rule
     */
    addManualRule(pattern: string, rule: string): SelfRule {
        const newRule: SelfRule = {
            id: `manual_${Date.now()}`,
            pattern,
            rule,
            source: 'manual',
            confidence: 0.8,
            appliedCount: 0,
            createdAt: Date.now(),
        }
        this.rules.push(newRule)
        this.stats.totalRules = this.rules.length
        saveRules(this.rules)
        return newRule
    }

    /**
     * Start periodic analysis (every 24h)
     */
    start(): void {
        if (this.intervalId) return

        // Run analysis now
        this.analyzeCorrections().then(n => {
            if (n > 0) console.log(`[L20] Generated ${n} new rules from corrections`)
        })

        // Then every 5 minutes
        this.intervalId = setInterval(async () => {
            const n = await this.analyzeCorrections()
            if (n > 0) console.log(`[L20] Generated ${n} new rules from corrections`)
            await this.checkForEvolutionTrigger()
        }, 5 * 60 * 1000)

        console.log(`[L20 Self-Improvement] Started — ${this.rules.length} rules active, next analysis in 5m`)
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }

    getStats(): ImprovementStats {
        return { ...this.stats }
    }

    getRules(): SelfRule[] {
        return [...this.rules]
    }

    formatStatus(): string {
        const lines = [
            `🧬 *Self-Improvement Engine*\n`,
            `📊 Regeln: ${this.rules.length}`,
            `🔍 Korrekturen analysiert: ${this.stats.totalCorrectionsAnalyzed}`,
            `✅ Regeln angewendet: ${this.stats.rulesApplied}`,
            `⏰ Letzte Analyse: ${this.stats.lastAnalysis ? new Date(this.stats.lastAnalysis).toLocaleString('de-DE') : 'Nie'}`,
        ]

        if (this.rules.length > 0) {
            lines.push('\n*Top Regeln:*')
            const top = [...this.rules].sort((a, b) => b.appliedCount - a.appliedCount).slice(0, 5)
            for (const r of top) {
                lines.push(`• "${r.rule.slice(0, 60)}" (${r.appliedCount}x, ${Math.round(r.confidence * 100)}%)`)
            }
        }

        return lines.join('\n')
    }

    // ============================================
    // Internal Helpers
    // ============================================

    private normalizeContext(context: string): string {
        return context
            .toLowerCase()
            .replace(/[^a-zäöüß\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100)
    }

    private findCommonInstruction(responses: string[]): string | null {
        if (responses.length < 2) return null

        // Simple: take the shortest response as the "instruction"
        const sorted = responses.filter(r => r.length > 10).sort((a, b) => a.length - b.length)
        if (sorted.length === 0) return null

        const shortest = sorted[0]
        if (shortest.length > 200) return shortest.slice(0, 200)
        return shortest
    }

    /**
     * Check if accumulated patterns warrant a Self-Evolution proposal
     * Triggers when 3+ high-confidence rules exist that have been applied many times
     */
    private async checkForEvolutionTrigger(): Promise<void> {
        const highConfidenceRules = this.rules.filter(r => r.confidence >= 0.7 && r.appliedCount >= 3)
        if (highConfidenceRules.length < 3) return

        // Only trigger once per day max
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
        if (this.lastEvolutionProposal && this.lastEvolutionProposal > oneDayAgo) return

        this.lastEvolutionProposal = Date.now()

        const topRules = highConfidenceRules
            .sort((a, b) => b.appliedCount - a.appliedCount)
            .slice(0, 5)
            .map(r => `- ${r.rule}`)
            .join('\n')

        console.log(`[L20] 🧬 Self-Evolution trigger: ${highConfidenceRules.length} high-confidence rules found`)
        console.log(`[L20] 💡 Top patterns that could be evolved into code:\n${topRules}`)

        // Queue evolution suggestion via proactive learning
        try {
            const { storeKnowledge } = await import('../intelligence/proactive-learning.js')
            storeKnowledge(
                'self-evolution-proposal',
                [
                    `${highConfidenceRules.length} wiederkehrende Verhaltensmuster gefunden`,
                    `Kandidaten für Code-Evolution: ${topRules.replace(/\n/g, ' | ')}`,
                    `Nutze self_evolve Tool um diese Muster dauerhaft einzubauen`,
                ]
            )
        } catch { /* proactive learning not available */ }
    }

    /**
     * LLM-powered rule synthesis: analyze correction patterns intelligently
     */
    private async synthesizeRuleWithLLM(context: string, originals: string[], corrections: string[]): Promise<string | null> {
        if (!this.llm) return null
        try {
            const prompt = `Du bist Novas Selbst-Verbesserungs-Modul. Analysiere diese Korrekturen und extrahiere EINE klare Verhaltensregel.

Kontext: ${context}

Originale Antworten (FALSCH):
${originals.slice(0, 3).map((o, i) => `${i + 1}. ${o.slice(0, 200)}`).join('\n')}

Korrigierte Antworten (RICHTIG):
${corrections.slice(0, 3).map((c, i) => `${i + 1}. ${c.slice(0, 200)}`).join('\n')}

Extrahiere EINE kurze, präzise Regel (max 100 Zeichen) die Nova in Zukunft befolgen soll. Nur die Regel, kein anderer Text.`

            const response = await this.llm.complete([
                { role: 'system', content: 'Du extrahierst kurze Verhaltensregeln aus Korrektur-Mustern. Antworte NUR mit der Regel.' },
                { role: 'user', content: prompt },
            ])

            const rule = response.content?.trim()
            if (rule && rule.length > 5 && rule.length < 200) {
                console.log(`[L20] LLM synthesized rule: "${rule}"`)
                return rule
            }
        } catch (err) {
            console.log(`[L20] LLM synthesis failed, falling back to heuristic: ${err}`)
        }
        return null
    }
}

// ============================================
// Singleton
// ============================================

let engine: SelfImprovementEngine | null = null

export function getSelfImprovementEngine(): SelfImprovementEngine {
    if (!engine) {
        engine = new SelfImprovementEngine()
    }
    return engine
}

export function setInternalLLM(llm: any): void {
    getSelfImprovementEngine().setLLM(llm)
}

export default { SelfImprovementEngine, getSelfImprovementEngine, setInternalLLM }
