/**
 * L17 - Autonomous Learning Loop
 * 
 * This layer enables TRUE self-learning:
 * 1. Attempt a task
 * 2. If fails → Analyze WHY
 * 3. Research solution (google/web search)
 * 4. Modify approach (write file, create tool, etc)
 * 5. Retry with new approach
 * 6. NEVER GIVE UP - repeat until success (hours/days if needed!)
 * 7. SAVE what worked for future use
 * 
 * Nova will NEVER give up - she keeps trying until she finds a solution!
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { join } from 'node:path'
import { toolProvidesActionEvidence } from '../core/action-intent.js'
import { isSuccessfulToolResult } from '../tools/tool-result-quality.js'

// ============================================
// Types
// ============================================

export interface LearningAttempt {
    iteration: number
    action: string
    result: 'success' | 'failure'
    error?: string
    analysis?: string
    solution?: string
    timestamp: number
}

export interface LearningSession {
    goal: string
    attempts: LearningAttempt[]
    finalResult: 'success' | 'failure' | 'in_progress'
    learnedSolution?: string
    startedAt: number
    endedAt?: number
}

export interface LearnedKnowledge {
    problem: string
    solution: string
    code?: string
    learnedAt: number
    successCount: number
}

// ============================================
// Knowledge Storage
// ============================================

const KNOWLEDGE_FILE = 'learned-solutions.json'

function getKnowledgePath(): string {
    const dir = process.env.NOVA_RUNTIME_ROOT
        ? join(process.env.NOVA_RUNTIME_ROOT, '.nova-learning')
        : join(process.cwd(), '.nova-learning')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, KNOWLEDGE_FILE)
}

function loadKnowledge(): LearnedKnowledge[] {
    const path = getKnowledgePath()
    if (!existsSync(path)) return []
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LearnedKnowledge[]
        return parsed.filter(entry => {
            const solution = String(entry?.solution || '')
            const metaOnly = /^Tool\s+(nova_capabilities|find_capability|resolve_capability|load_skill_pack|build_skill|create_skill):/i.test(solution)
            return isLearnableProblem(entry?.problem || '') && !metaOnly && isSuccessfulToolResult(solution)
        })
    } catch (err) {
        // NICHT still auf [] zuruecksetzen: der naechste saveKnowledge()
        // wuerde die leere Liste zurueckschreiben und das gesamte autonome
        // Lernwissen unwiderruflich loeschen. Kaputte Datei beiseitelegen.
        console.error("[L17] Lernwissen unlesbar - Datei wird gesichert statt ueberschrieben:", err)
        try { renameSync(getKnowledgePath(), getKnowledgePath() + ".kaputt-" + Date.now()) }
        catch (e) { console.error("[L17] Sicherung fehlgeschlagen:", e) }
        return []
    }
}

function saveKnowledge(knowledge: LearnedKnowledge[]): void {
    // Atomar: ein Absturz mitten im Schreiben hinterliess sonst eine
    // halbe Datei, die beim naechsten Start als kaputt galt.
    atomicWriteJsonSync(getKnowledgePath(), knowledge)
}

export interface VerifiedLearningEvidence {
    verified: true
    toolName: string
    result: unknown
    timestamp?: number
}

export function isLearnableProblem(problem: string): boolean {
    const text = String(problem || '').trim()
    if (text.length < 12 || /^\d+$/.test(text)) return false
    const meaningful = text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || []
    return meaningful.length >= 3
}

export function rememberSolution(
    problem: string,
    solution: string,
    code?: string,
    evidence?: VerifiedLearningEvidence,
): boolean {
    if (!isLearnableProblem(problem)) {
        console.log(`[L17 Learning] Ignored generic/follow-up learning key: ${JSON.stringify(problem)}`)
        return false
    }
    if (evidence?.verified !== true || !evidence.toolName) {
        console.warn('[L17 Learning] Ignored unverified solution candidate')
        return false
    }
    if (!toolProvidesActionEvidence(evidence.toolName) || !isSuccessfulToolResult(evidence.result)) {
        console.warn(`[L17 Learning] Ignored non-fulfilling outcome from ${evidence.toolName}`)
        return false
    }
    const knowledge = loadKnowledge()

    // Check if we already know this
    const existing = knowledge.find(k => k.problem.toLowerCase() === problem.toLowerCase())
    if (existing) {
        existing.successCount++
        existing.solution = solution
        if (code) existing.code = code
    } else {
        knowledge.push({
            problem,
            solution,
            code,
            learnedAt: Date.now(),
            successCount: 1
        })
    }

    saveKnowledge(knowledge)
    console.log(`[L17 Learning] 💾 Remembered solution for: ${problem.slice(0, 50)}...`)
    return true
}

export function recallSolution(problem: string): LearnedKnowledge | null {
    const knowledge = loadKnowledge()

    const normalizedProblem = problem.trim().toLowerCase()
    if (!normalizedProblem) return null

    // Very short or generic follow-ups ("warum?", "ja", "mach das") only
    // make sense with the current conversation. Reusing global learned
    // solutions for them causes unrelated memory injection.
    const stopWords = new Set([
        'aber', 'also', 'bitte', 'das', 'dann', 'der', 'die', 'ein', 'eine',
        'es', 'ich', 'ist', 'ja', 'kannst', 'mach', 'mal', 'mir', 'nein',
        'noch', 'sie', 'so', 'und', 'warum', 'was', 'wie', 'wieso', 'du',
    ])
    const tokenize = (value: string) => value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}:/._-]+/gu, ' ')
        .split(/\s+/)
        .filter(token => token.length >= 3 && !stopWords.has(token))

    const words = tokenize(normalizedProblem)
    const exactMatch = knowledge.find(k => k.problem.trim().toLowerCase() === normalizedProblem)
    if (exactMatch) return exactMatch
    if (words.length < 3 || normalizedProblem.length < 20) return null

    // Fuzzy match
    let bestMatch: LearnedKnowledge | null = null
    let bestScore = 0

    for (const k of knowledge) {
        const kWords = tokenize(k.problem)
        if (kWords.length < 3) continue
        const matches = words.filter(w => kWords.includes(w)).length
        const score = matches / Math.max(words.length, kWords.length)

        if (matches >= 2 && score > bestScore && score >= 0.65) {
            bestScore = score
            bestMatch = k
        }
    }

    if (bestMatch) {
        console.log(`[L17 Learning] 🧠 Found previous solution for similar problem!`)
    }

    return bestMatch
}

// ============================================
// Internal LLM
// ============================================

let internalLlm: any = null

export function setInternalLLM(llm: any): void {
    internalLlm = llm
    console.log('[L17] 🧠 LLM-based failure analysis enabled')
}

// ============================================
// Learning Loop
// ============================================

export class AutonomousLearner {
    private maxIterations = 100  // Soft limit for logging, not for stopping
    private persistentMode = true  // NEVER give up!
    private backoffDelayMs = 60000  // 1 minute between attempts after 10 failures
    private currentSession: LearningSession | null = null

    /**
     * Start a learning session for a goal
     */
    startSession(goal: string): void {
        if (!isLearnableProblem(goal)) {
            this.currentSession = null
            return
        }
        // First check if we already know how to do this
        const known = recallSolution(goal)
        if (known) {
            console.log(`[L17 Learning] Already know how to: ${goal}`)
            console.log(`[L17 Learning] Solution: ${known.solution}`)
        }

        this.currentSession = {
            goal,
            attempts: [],
            finalResult: 'in_progress',
            startedAt: Date.now()
        }

        console.log(`[L17 Learning] 🎯 Starting learning session: ${goal}`)
    }

    /**
     * Record an attempt
     */
    recordAttempt(action: string, success: boolean, error?: string): LearningAttempt {
        if (!this.currentSession) {
            this.startSession('Unknown goal')
        }

        const attempt: LearningAttempt = {
            iteration: this.currentSession!.attempts.length + 1,
            action,
            result: success ? 'success' : 'failure',
            error,
            timestamp: Date.now()
        }

        this.currentSession!.attempts.push(attempt)

        console.log(`[L17 Learning] Attempt ${attempt.iteration}: ${attempt.result}`)

        return attempt
    }

    recordVerifiedOutcome(outcome: {
        toolName: string
        request: string
        result: unknown
        success: boolean
        verified: true
    }): LearningAttempt {
        if (!isLearnableProblem(outcome.request)) {
            return { iteration: 0, action: outcome.toolName, result: outcome.success ? 'success' : 'failure', timestamp: Date.now() }
        }
        if (!this.currentSession) this.startSession(outcome.request || 'Verified tool task')
        const attempt = this.recordAttempt(
            outcome.toolName,
            outcome.success,
            outcome.success ? undefined : String(outcome.result),
        )
        if (outcome.success && this.currentSession) {
            const summary = typeof outcome.result === 'string'
                ? outcome.result.slice(0, 500)
                : JSON.stringify(outcome.result).slice(0, 500)
            rememberSolution(this.currentSession.goal, `Tool ${outcome.toolName}: ${summary}`, undefined, {
                verified: true,
                toolName: outcome.toolName,
                result: outcome.result,
            })
        }
        return attempt
    }

    /**
     * Analyze why the last attempt failed — uses LLM if available, regex fallback
     */
    async analyzeFailure(error: string): Promise<string> {
        // Try LLM-based analysis first
        if (internalLlm) {
            try {
                const prompt = `Analyze this error and categorize it. Return ONLY one of: FILE_OR_COMMAND_MISSING, CODE_SYNTAX_ERROR, PERMISSION_ISSUE, NETWORK_TIMEOUT, IMPORT_ERROR, DEPENDENCY_MISSING, CONFIG_ERROR, or UNKNOWN_ERROR. Then a brief explanation.

Error: ${error.slice(0, 300)}

Format: CATEGORY: explanation`

                const result = await internalLlm.complete(prompt)
                const text = typeof result === 'string' ? result : result?.text || result?.content || ''
                const category = text.split(':')[0]?.trim() || 'UNKNOWN_ERROR'
                console.log(`[L17 Learning] 🧠 LLM Analysis: ${text.slice(0, 100)}`)
                return category
            } catch {
                // Fall through to regex
            }
        }

        // Regex fallback
        const analyses: string[] = []
        if (error.includes('not found') || error.includes('nicht gefunden')) analyses.push('FILE_OR_COMMAND_MISSING')
        if (error.includes('SyntaxError')) analyses.push('CODE_SYNTAX_ERROR')
        if (error.includes('permission') || error.includes('denied')) analyses.push('PERMISSION_ISSUE')
        if (error.includes('timeout') || error.includes('ETIMEDOUT')) analyses.push('NETWORK_TIMEOUT')
        if (error.includes('import') || error.includes('module')) analyses.push('IMPORT_ERROR')

        const analysis = analyses.join(', ') || 'UNKNOWN_ERROR'
        console.log(`[L17 Learning] Analysis: ${analysis}`)
        return analysis
    }

    /**
     * Generate next action based on failure analysis
     */
    generateNextAction(analysis: string, originalAction: string): string {
        const suggestions: Record<string, string> = {
            'FILE_OR_COMMAND_MISSING': `Use write_file to create the missing file first, then retry`,
            'CODE_SYNTAX_ERROR': `Create a proper script file instead of inline code`,
            'PERMISSION_ISSUE': `Try alternative approach or request elevated permissions`,
            'NETWORK_TIMEOUT': `Check network connectivity or try different endpoint`,
            'IMPORT_ERROR': `Research correct import syntax with web_search, then create fixed script`,
            'UNKNOWN_ERROR': `Research the error message with google_search to find solution`,
        }

        return suggestions[analysis] || suggestions['UNKNOWN_ERROR']
    }

    /**
     * Check if we should keep trying — with DEAD-END DETECTION
     */
    shouldContinue(): boolean {
        if (!this.currentSession) return false

        const attempts = this.currentSession.attempts
        const attemptCount = attempts.length
        const lastAttempt = attempts[attemptCount - 1]

        // Stop if success
        if (lastAttempt?.result === 'success') {
            this.currentSession.finalResult = 'success'
            return false
        }

        // === DEAD-END DETECTION ===

        // Hard limit: 20 attempts max (even in persistent mode)
        if (attemptCount >= 20) {
            console.log(`[L17 Learning] 🛑 DEAD-END: 20 Versuche erreicht — Session wird zwangsbeendet!`)
            this.currentSession.finalResult = 'failure'
            return false
        }

        // Same error 5 times = dead-end (unfixable problem)
        if (attemptCount >= 5) {
            const recentErrors = attempts.slice(-5).map(a => a.error?.slice(0, 80) || '')
            const uniqueErrors = new Set(recentErrors)
            if (uniqueErrors.size === 1 && recentErrors[0] !== '') {
                console.log(`[L17 Learning] 🛑 DEAD-END: Gleicher Fehler 5x hintereinander — Problem nicht lösbar!`)
                console.log(`[L17 Learning] Fehler: ${recentErrors[0]}`)
                this.currentSession.finalResult = 'failure'
                return false
            }
        }

        // Time limit: 10 minutes max per session
        const sessionDuration = Date.now() - this.currentSession.startedAt
        if (sessionDuration > 10 * 60 * 1000) {
            console.log(`[L17 Learning] 🛑 DEAD-END: Zeitlimit (10 Minuten) überschritten!`)
            this.currentSession.finalResult = 'failure'
            return false
        }

        // Add backoff delay after 5 failures
        if (attemptCount >= 5) {
            const delay = Math.min(this.backoffDelayMs * Math.floor(attemptCount / 5), 120000) // Max 2 min
            console.log(`[L17 Learning] ⏳ Backoff: ${Math.round(delay / 1000)}s (Versuch ${attemptCount})`)
        }

        return true
    }

    /**
     * End session and save learnings
     */
    endSession(success: boolean, solution?: string): void {
        if (!this.currentSession) return

        this.currentSession.finalResult = success ? 'success' : 'failure'
        this.currentSession.endedAt = Date.now()

        // Only recordVerifiedOutcome may persist a solution. A model-generated
        // session summary is not proof that an action really succeeded.
        if (success && solution) this.currentSession.learnedSolution = solution

        const duration = (this.currentSession.endedAt - this.currentSession.startedAt) / 1000
        console.log(`[L17 Learning] Session ended: ${this.currentSession.finalResult} (${duration}s, ${this.currentSession.attempts.length} attempts)`)

        this.currentSession = null
    }

    /**
     * Get learning prompt for LLM
     */
    getLearningPrompt(): string {
        if (!this.currentSession) return ''

        const attempts = this.currentSession.attempts
        const lastAttempt = attempts[attempts.length - 1]

        if (!lastAttempt || lastAttempt.result === 'success') return ''

        return `
## 🔄 AUTONOMOUS LEARNING MODE AKTIV!
Dein letzter Versuch (${lastAttempt.iteration}/${this.maxIterations}) ist fehlgeschlagen.

FEHLER: ${lastAttempt.error || 'Unbekannt'}

DU MUSST JETZT:
1. Analysiere WARUM es fehlgeschlagen ist
2. Recherchiere mit google_search oder web_search
3. Erstelle eine ANDERE Lösung (write_file, create_tool)
4. Versuche es ERNEUT

GEBE NICHT AUF! Du hast noch ${this.maxIterations - lastAttempt.iteration} Versuche!
`
    }

    /**
     * Get current session info
     */
    getSessionInfo(): { attempts: number; maxIterations: number; goal: string } | null {
        if (!this.currentSession) return null
        return {
            attempts: this.currentSession.attempts.length,
            maxIterations: this.maxIterations,
            goal: this.currentSession.goal
        }
    }
}

// ============================================
// Global Instance
// ============================================

let learner: AutonomousLearner | null = null

export function getLearner(): AutonomousLearner {
    if (!learner) {
        learner = new AutonomousLearner()
    }
    return learner
}

export default {
    AutonomousLearner,
    getLearner,
    rememberSolution,
    recallSolution,
    setInternalLLM,
}
