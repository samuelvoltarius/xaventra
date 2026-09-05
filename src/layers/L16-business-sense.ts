/**
 * L16 Business Sense - Clarification Layer
 * 
 * Helps Nova understand WHAT to build, not just HOW:
 * - Detects vague requirements
 * - Generates clarifying questions
 * - Suggests scope breakdowns
 * - Prevents blind implementation
 */

// ============================================
// Types
// ============================================

export interface ClarificationResult {
    needsClarification: boolean
    confidence: number  // 0-1, how confident Nova is about the requirement
    questions: ClarificationQuestion[]
    suggestedScope?: ScopeBreakdown
    originalRequest: string
    analysis: string
}

export interface ClarificationQuestion {
    id: string
    category: 'scope' | 'technical' | 'priority' | 'constraint' | 'user'
    question: string
    options?: string[]  // Multiple choice options
    defaultAnswer?: string
    importance: 'required' | 'recommended' | 'optional'
}

export interface ScopeBreakdown {
    summary: string
    phases: Phase[]
    estimatedEffort: 'hours' | 'days' | 'weeks'
    risks: string[]
}

export interface Phase {
    name: string
    tasks: string[]
    dependencies: string[]
}

// ============================================
// Vagueness Patterns
// ============================================

interface VaguenessPattern {
    id: string
    pattern: RegExp
    category: ClarificationQuestion['category']
    questionTemplate: string
    options?: string[]
}

const VAGUENESS_PATTERNS: VaguenessPattern[] = [
    // Vague performance requirements
    {
        id: 'faster',
        pattern: /(?:schneller|faster|performanter|optimier)/gi,
        category: 'scope',
        questionTemplate: 'Was genau soll schneller werden?',
        options: ['Ladezeit', 'API-Response', 'Build-Zeit', 'Datenbank-Queries', 'Benutzer-Workflow'],
    },
    {
        id: 'improve',
        pattern: /(?:verbessern?|improve|besser machen)/gi,
        category: 'scope',
        questionTemplate: 'Was genau soll verbessert werden und wie messen wir den Erfolg?',
    },
    {
        id: 'fix',
        pattern: /(?:fix|reparier|beheb).*(?:bug|fehler|problem)/gi,
        category: 'technical',
        questionTemplate: 'Kannst du den Fehler genauer beschreiben? Was ist das erwartete vs. tatsächliche Verhalten?',
    },

    // Vague scope
    {
        id: 'some-feature',
        pattern: /(?:irgendein|irgendwie|ein paar|some kind of|basically)/gi,
        category: 'scope',
        questionTemplate: 'Kannst du die Anforderung präziser beschreiben?',
    },
    {
        id: 'simple',
        pattern: /(?:einfach|simple|basic|schnell mal|kurz)/gi,
        category: 'scope',
        questionTemplate: 'Was bedeutet "einfach" in diesem Kontext? Welche Features sind Minimum?',
    },
    {
        id: 'better-ux',
        pattern: /(?:bessere? ux|user experience|benutzerfreundlich)/gi,
        category: 'user',
        questionTemplate: 'Was ist das konkrete UX-Problem? Welche User-Journey soll verbessert werden?',
    },

    // Missing constraints
    {
        id: 'asap',
        pattern: /(?:asap|so schnell wie möglich|dringend|urgent)/gi,
        category: 'priority',
        questionTemplate: 'Was ist die tatsächliche Deadline? Welche Teile haben höchste Priorität?',
    },
    {
        id: 'scale',
        pattern: /(?:skalier|scale|wachsen|mehr user)/gi,
        category: 'constraint',
        questionTemplate: 'Welche Last erwarten wir? (z.B. 100/1000/10000 gleichzeitige User)',
    },

    // Technical ambiguity
    {
        id: 'integrate',
        pattern: /(?:integrier|anbinden|connect|verknüpf)/gi,
        category: 'technical',
        questionTemplate: 'Welches System soll angebunden werden? Gibt es eine API-Dokumentation?',
    },
    {
        id: 'like-x',
        pattern: /(?:wie bei|so wie|ähnlich wie|like in)/gi,
        category: 'scope',
        questionTemplate: 'Welche spezifischen Aspekte sollen übernommen werden?',
    },
]

// ============================================
// Business Sense Analyzer
// ============================================

export class BusinessSenseAnalyzer {
    private minConfidenceToAsk = 0.7  // Ask if confidence < 70%

    constructor() {
        console.log(`[L16 BusinessSense] Analyzer initialized`)
    }

    /**
     * Analyze a request for clarity
     */
    async analyzeRequest(request: string, context?: string): Promise<ClarificationResult> {
        console.log(`[L16 BusinessSense] Analyzing: ${request.slice(0, 50)}...`)

        const questions: ClarificationQuestion[] = []
        let confidence = 1.0

        // Check for vagueness patterns
        for (const pattern of VAGUENESS_PATTERNS) {
            if (pattern.pattern.test(request)) {
                confidence -= 0.15  // Each vague pattern reduces confidence

                questions.push({
                    id: pattern.id,
                    category: pattern.category,
                    question: pattern.questionTemplate,
                    options: pattern.options,
                    importance: confidence < 0.5 ? 'required' : 'recommended',
                })
            }
        }

        // Check for very short requests
        if (request.split(' ').length < 10) {
            confidence -= 0.2
            questions.push({
                id: 'too-short',
                category: 'scope',
                question: 'Die Anforderung ist sehr kurz. Kannst du mehr Details geben?',
                importance: 'required',
            })
        }

        // Check if missing key info
        const missingInfo = this.detectMissingInfo(request)
        questions.push(...missingInfo)
        confidence -= missingInfo.length * 0.1

        // Clamp confidence
        confidence = Math.max(0, Math.min(1, confidence))

        const needsClarification = confidence < this.minConfidenceToAsk || questions.some(q => q.importance === 'required')

        // Build analysis
        const analysis = this.buildAnalysis(request, questions, confidence)

        return {
            needsClarification,
            confidence,
            questions: questions.slice(0, 5),  // Max 5 questions
            originalRequest: request,
            analysis,
        }
    }

    /**
     * Detect missing key information
     */
    private detectMissingInfo(request: string): ClarificationQuestion[] {
        const questions: ClarificationQuestion[] = []
        const lower = request.toLowerCase()

        // No user mentioned
        if (!/(user|benutzer|kunde|client|admin)/i.test(lower)) {
            questions.push({
                id: 'no-user',
                category: 'user',
                question: 'Wer sind die Zielnutzer dieser Funktion?',
                options: ['Endkunden', 'Admins', 'Entwickler', 'Alle'],
                importance: 'recommended',
            })
        }

        // No specific tech mentioned for technical task
        if (/(bauen|erstellen|implement|entwickeln)/i.test(lower) &&
            !/(react|next|nest|prisma|api|database|frontend|backend)/i.test(lower)) {
            questions.push({
                id: 'no-tech',
                category: 'technical',
                question: 'In welchem Teil des Systems soll das implementiert werden?',
                options: ['Frontend (Next.js)', 'Backend (NestJS)', 'Datenbank', 'API', 'Fullstack'],
                importance: 'recommended',
            })
        }

        // No success criteria
        if (!/(wenn|bis|erfolgreich|fertig|done|abgeschlossen)/i.test(lower)) {
            questions.push({
                id: 'no-criteria',
                category: 'scope',
                question: 'Woran erkennen wir, dass die Aufgabe erledigt ist?',
                importance: 'optional',
            })
        }

        return questions
    }

    /**
     * Build analysis summary
     */
    private buildAnalysis(request: string, questions: ClarificationQuestion[], confidence: number): string {
        if (confidence >= 0.8) {
            return 'Anforderung ist klar genug für die Umsetzung.'
        } else if (confidence >= 0.5) {
            return `Anforderung ist verständlich, aber ${questions.length} Punkte sollten geklärt werden.`
        } else {
            return `Anforderung ist zu vage. ${questions.length} wichtige Fragen müssen erst geklärt werden.`
        }
    }

    /**
     * Generate a scope breakdown suggestion
     */
    async suggestScope(request: string): Promise<ScopeBreakdown> {
        // This would ideally call an LLM for complex breakdown
        // For now, simple heuristics

        const wordCount = request.split(' ').length
        const effort: ScopeBreakdown['estimatedEffort'] =
            wordCount < 20 ? 'hours' :
                wordCount < 50 ? 'days' : 'weeks'

        return {
            summary: `Scope für: ${request.slice(0, 50)}...`,
            phases: [
                {
                    name: 'Phase 1: Analyse',
                    tasks: ['Anforderungen klären', 'Bestehendes verstehen'],
                    dependencies: [],
                },
                {
                    name: 'Phase 2: Implementierung',
                    tasks: ['Code schreiben', 'Tests hinzufügen'],
                    dependencies: ['Phase 1'],
                },
                {
                    name: 'Phase 3: Review & Deploy',
                    tasks: ['Code Review', 'QA', 'Deployment'],
                    dependencies: ['Phase 2'],
                },
            ],
            estimatedEffort: effort,
            risks: [
                'Scope Creep bei unklaren Anforderungen',
                'Integration mit bestehenden Systemen',
            ],
        }
    }

    /**
     * Format clarification request for user
     */
    formatClarificationRequest(result: ClarificationResult): string {
        if (!result.needsClarification) {
            return `✅ Verstanden! Ich starte mit der Umsetzung.`
        }

        let msg = `🤔 **Kurze Rückfrage vor dem Start**\n\n`
        msg += `_Confidence: ${Math.round(result.confidence * 100)}%_\n\n`

        const required = result.questions.filter(q => q.importance === 'required')
        const optional = result.questions.filter(q => q.importance !== 'required')

        if (required.length > 0) {
            msg += `**Muss ich wissen:**\n`
            for (let i = 0; i < required.length; i++) {
                msg += `${i + 1}. ${required[i].question}\n`
                if (required[i].options) {
                    msg += `   → Optionen: ${required[i].options!.join(', ')}\n`
                }
            }
            msg += `\n`
        }

        if (optional.length > 0) {
            msg += `**Wäre hilfreich:**\n`
            for (const q of optional.slice(0, 2)) {
                msg += `• ${q.question}\n`
            }
        }

        msg += `\n_Oder sag "mach einfach" wenn du mir vertraust._`

        return msg
    }

    /**
     * Check if user wants to skip clarification
     */
    shouldSkipClarification(userResponse: string): boolean {
        const skipPhrases = [
            /mach (einfach|mal|los)/i,
            /ist mir egal/i,
            /du entscheidest/i,
            /vertrau dir/i,
            /just do it/i,
            /proceed/i,
            /skip/i,
        ]

        return skipPhrases.some(p => p.test(userResponse))
    }
}

// ============================================
// Internal LLM for deeper requirement analysis
// ============================================

let internalLlm: any = null

export function setInternalLLM(llm: any): void {
    internalLlm = llm
    console.log('[L16 BusinessSense] ✓ Internal LLM connected')
}

export function getInternalLLM(): any {
    return internalLlm
}

// ============================================
// Singleton
// ============================================

let businessSenseAnalyzer: BusinessSenseAnalyzer | null = null

export function getBusinessSenseAnalyzer(): BusinessSenseAnalyzer {
    if (!businessSenseAnalyzer) {
        businessSenseAnalyzer = new BusinessSenseAnalyzer()
    }
    return businessSenseAnalyzer
}

export default { BusinessSenseAnalyzer, getBusinessSenseAnalyzer, setInternalLLM, getInternalLLM }
