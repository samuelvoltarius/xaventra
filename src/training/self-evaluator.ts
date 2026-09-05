/**
 * Self-Evaluator
 * 
 * Nova evaluates her own responses and suggests improvements.
 * Provides quality scoring and auto-correction hints.
 */

// ============================================
// Types
// ============================================

export interface EvaluationResult {
    score: number  // 0-100
    aspects: AspectScore[]
    improvements: string[]
    improvedResponse?: string
}

export interface AspectScore {
    name: string
    score: number
    feedback: string
}

// ============================================
// Evaluation Criteria
// ============================================

const EVALUATION_ASPECTS = [
    {
        name: 'Relevanz',
        weight: 25,
        evaluate: (query: string, response: string): { score: number; feedback: string } => {
            // Check if response addresses the query
            const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
            const responseWords = response.toLowerCase()
            const relevantWords = queryWords.filter(w => responseWords.includes(w))
            const ratio = queryWords.length > 0 ? relevantWords.length / queryWords.length : 0

            return {
                score: Math.round(ratio * 100),
                feedback: ratio > 0.5 ? 'Antwort adressiert die Frage' : 'Antwort könnte relevanter sein',
            }
        }
    },
    {
        name: 'Vollständigkeit',
        weight: 20,
        evaluate: (_query: string, response: string): { score: number; feedback: string } => {
            // Check response completeness
            const hasCode = /```[\s\S]+```/.test(response)
            const hasExplanation = response.length > 100
            const hasSteps = /\d\.|step|schritt/i.test(response)

            let score = 50
            if (hasCode) score += 20
            if (hasExplanation) score += 15
            if (hasSteps) score += 15

            return {
                score: Math.min(100, score),
                feedback: score > 70 ? 'Umfassende Antwort' : 'Könnte ausführlicher sein',
            }
        }
    },
    {
        name: 'Klarheit',
        weight: 20,
        evaluate: (_query: string, response: string): { score: number; feedback: string } => {
            // Check clarity
            const avgSentenceLen = response.split(/[.!?]/).map(s => s.trim().split(' ').length).reduce((a, b) => a + b, 0) / (response.split(/[.!?]/).length || 1)
            const hasFormatting = /\*\*|#{1,3}|`/.test(response)

            let score = 60
            if (avgSentenceLen < 20) score += 20  // Shorter sentences = clearer
            if (hasFormatting) score += 20

            return {
                score: Math.min(100, score),
                feedback: score > 70 ? 'Klar strukturiert' : 'Bessere Formatierung würde helfen',
            }
        }
    },
    {
        name: 'Hilfsbereitschaft',
        weight: 20,
        evaluate: (query: string, response: string): { score: number; feedback: string } => {
            // Check if response is actionable/helpful
            const isQuestion = query.includes('?')
            const hasAnswer = !isQuestion || response.length > 50
            const hasActionable = /soll ich|kannst du|versuch|hier ist/i.test(response)
            const hasToolUse = /\[TOOL:/i.test(response)

            let score = 50
            if (hasAnswer) score += 20
            if (hasActionable) score += 15
            if (hasToolUse) score += 15

            return {
                score: Math.min(100, score),
                feedback: score > 70 ? 'Hilfreiche Antwort' : 'Könnte aktiver helfen',
            }
        }
    },
    {
        name: 'Sprachqualität',
        weight: 15,
        evaluate: (query: string, response: string): { score: number; feedback: string } => {
            // Check language consistency
            const isGermanQuery = /[äöüß]|und|oder|nicht/i.test(query)
            const hasEnglishPhrases = /\b(I am|I will|I can|you should|please|sorry)\b/i.test(response)

            let score = 80
            if (isGermanQuery && hasEnglishPhrases) score -= 30
            if (response.length < 20) score -= 20

            return {
                score: Math.max(0, score),
                feedback: score > 70 ? 'Sprachlich konsistent' : 'Sprache mischen vermeiden',
            }
        }
    },
]

// ============================================
// Main API
// ============================================

/**
 * Evaluate a response
 */
export function evaluate(query: string, response: string, toolsUsed: string[] = []): EvaluationResult {
    const aspects: AspectScore[] = []
    let totalScore = 0
    let totalWeight = 0

    for (const aspect of EVALUATION_ASPECTS) {
        const result = aspect.evaluate(query, response)
        aspects.push({
            name: aspect.name,
            score: result.score,
            feedback: result.feedback,
        })
        totalScore += result.score * aspect.weight
        totalWeight += aspect.weight
    }

    // Bonus for tool usage when appropriate
    const actionWords = ['install', 'erstell', 'such', 'zeig', 'liste']
    const needsTool = actionWords.some(w => query.toLowerCase().includes(w))
    if (needsTool && toolsUsed.length > 0) {
        totalScore += 10 * totalWeight / 100
    }

    const score = Math.round(totalScore / totalWeight)
    const improvements = generateImprovements(aspects)

    return {
        score,
        aspects,
        improvements,
    }
}

/**
 * Generate improvement suggestions
 */
function generateImprovements(aspects: AspectScore[]): string[] {
    const improvements: string[] = []

    for (const aspect of aspects) {
        if (aspect.score < 60) {
            switch (aspect.name) {
                case 'Relevanz':
                    improvements.push('Gehe direkter auf die Frage ein')
                    break
                case 'Vollständigkeit':
                    improvements.push('Füge mehr Details oder Beispiele hinzu')
                    break
                case 'Klarheit':
                    improvements.push('Nutze Formatierung (Bullet Points, Code Blocks)')
                    break
                case 'Hilfsbereitschaft':
                    improvements.push('Biete konkrete Aktionen an')
                    break
                case 'Sprachqualität':
                    improvements.push('Bleibe konsistent bei einer Sprache')
                    break
            }
        }
    }

    return improvements
}

/**
 * Get evaluation summary
 */
export function getEvaluationSummary(result: EvaluationResult): string {
    const icon = result.score >= 80 ? '🌟' : result.score >= 60 ? '✅' : result.score >= 40 ? '⚠️' : '❌'

    let summary = `${icon} **Selbst-Bewertung: ${result.score}/100**\n`

    for (const aspect of result.aspects) {
        const bar = '█'.repeat(Math.floor(aspect.score / 10)) + '░'.repeat(10 - Math.floor(aspect.score / 10))
        summary += `\n${aspect.name}: ${bar} ${aspect.score}%`
    }

    if (result.improvements.length > 0) {
        summary += `\n\n💡 **Verbesserungen:**\n${result.improvements.map(i => `• ${i}`).join('\n')}`
    }

    return summary
}

/**
 * Quick score check
 */
export function getQuickScore(query: string, response: string): number {
    const result = evaluate(query, response)
    return result.score
}

export default {
    evaluate,
    getEvaluationSummary,
    getQuickScore,
}
