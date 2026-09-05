/**
 * Nova - Output Quality Gate
 * 
 * Validates AI outputs to ensure:
 * 1. No placeholders or TODOs
 * 2. No truncated/incomplete code
 * 3. Honest about unknowns
 * 4. Complete implementations only
 * 
 * This is the "honesty layer" that prevents typical AI mistakes.
 */

// ============================================
// Types
// ============================================

export type QualityIssue = {
    type: QualityIssueType
    severity: 'warning' | 'error'
    message: string
    location?: { start: number; end: number }
    suggestion?: string
}

export type QualityIssueType =
    | 'placeholder'        // "// TODO", "implement later"
    | 'truncated'          // "...", "remaining code"
    | 'mock'               // fake data, dummy implementations
    | 'hallucination'      // made up APIs, wrong syntax
    | 'incomplete'         // missing imports, undefined vars
    | 'vague'              // unclear explanations

export interface ValidationResult {
    valid: boolean
    issues: QualityIssue[]
    confidence: number     // 0-1 how confident we are this is complete
    requiresHumanReview: boolean
}

// ============================================
// Detection Patterns
// ============================================

const PLACEHOLDER_PATTERNS = [
    // Direct placeholders
    { pattern: /\/\/\s*TODO\b/gi, message: 'Contains TODO comment' },
    { pattern: /\/\/\s*FIXME\b/gi, message: 'Contains FIXME comment' },
    { pattern: /\/\/\s*XXX\b/gi, message: 'Contains XXX comment' },
    { pattern: /\/\/\s*HACK\b/gi, message: 'Contains HACK comment' },

    // Lazy implementations
    { pattern: /implement(ed)?\s*(later|here|this)/gi, message: 'Deferred implementation' },
    { pattern: /would\s+(go|be|do|implement)\s+here/gi, message: 'Placeholder description' },
    { pattern: /will\s+be\s+implemented/gi, message: 'Not yet implemented' },
    { pattern: /placeholder/gi, message: 'Contains placeholder' },
    { pattern: /stub\s*(function|method|class)?/gi, message: 'Stub implementation' },

    // Fake data indicators
    { pattern: /example\.(com|org|net)/gi, message: 'Example domain (may be placeholder)' },
    { pattern: /your[_-]?api[_-]?key/gi, message: 'Placeholder API key' },
    { pattern: /\bxxx+\b/gi, message: 'XXX placeholder' },
    { pattern: /\bfoo|bar|baz\b/gi, message: 'Generic placeholder variable' },
]

const TRUNCATION_PATTERNS = [
    // Explicit truncation
    { pattern: /\.{3,}\s*$/m, message: 'Ends with ellipsis (truncated)' },
    { pattern: /\/\/\s*\.{3}/g, message: 'Comment ellipsis (truncated)' },
    { pattern: /\/\*\s*\.{3}\s*\*\//g, message: 'Block comment ellipsis' },

    // Lazy references
    { pattern: /remaining\s*(code|implementation)/gi, message: 'Incomplete: mentions remaining code' },
    { pattern: /rest\s+of\s+(the\s+)?(code|implementation)/gi, message: 'Incomplete: references rest of code' },
    { pattern: /etc\.?\s*$/gm, message: 'Ends with etc (may be incomplete)' },
    { pattern: /and\s+so\s+on/gi, message: 'Vague: "and so on"' },
    { pattern: /similar\s+(to|for)\s+other/gi, message: 'Lazy: similar patterns not shown' },
]

const MOCK_PATTERNS = [
    // Mock indicators
    { pattern: /mock(ed|ing)?/gi, message: 'Contains mock' },
    { pattern: /fake\s*(data|response|api)/gi, message: 'Fake implementation' },
    { pattern: /dummy/gi, message: 'Dummy implementation' },
    { pattern: /sample\s*(data|response)/gi, message: 'Sample data placeholder' },

    // Hardcoded test values
    { pattern: /test@test\.com/gi, message: 'Test email placeholder' },
    { pattern: /password123|admin123/gi, message: 'Placeholder password' },
    { pattern: /1234567890/g, message: 'Placeholder number' },
]

const VAGUE_PATTERNS = [
    // Unclear explanations
    { pattern: /somehow/gi, message: 'Vague: "somehow"' },
    { pattern: /magic(ally)?/gi, message: 'Vague: "magic"' },
    { pattern: /just\s+works/gi, message: 'Vague: "just works"' },
    { pattern: /you\s+(?:know|get)\s+the\s+idea/gi, message: 'Incomplete explanation' },
    { pattern: /basically/gi, message: 'Oversimplification: "basically"' },
]

// ============================================
// Output Validator Class
// ============================================

export class OutputValidator {
    private strictMode: boolean
    private customPatterns: Array<{ pattern: RegExp; message: string; type: QualityIssueType }>

    constructor(options: { strictMode?: boolean } = {}) {
        this.strictMode = options.strictMode ?? true
        this.customPatterns = []
    }

    // ============================================
    // Main Validation
    // ============================================

    validate(output: string): ValidationResult {
        const issues: QualityIssue[] = []

        // Check all pattern categories
        this.checkPatterns(output, PLACEHOLDER_PATTERNS, 'placeholder', issues)
        this.checkPatterns(output, TRUNCATION_PATTERNS, 'truncated', issues)
        this.checkPatterns(output, MOCK_PATTERNS, 'mock', issues)
        this.checkPatterns(output, VAGUE_PATTERNS, 'vague', issues)
        this.checkPatterns(output, this.customPatterns.map(p => ({ pattern: p.pattern, message: p.message })), 'incomplete', issues)

        // Check for incomplete code
        this.checkIncompleteCode(output, issues)

        // Calculate confidence
        const confidence = this.calculateConfidence(output, issues)

        // Determine if human review needed
        const hasErrors = issues.some(i => i.severity === 'error')
        const requiresHumanReview = hasErrors || confidence < 0.7

        return {
            valid: !hasErrors,
            issues,
            confidence,
            requiresHumanReview,
        }
    }

    // ============================================
    // Pattern Checking
    // ============================================

    private checkPatterns(
        output: string,
        patterns: Array<{ pattern: RegExp; message: string }>,
        type: QualityIssueType,
        issues: QualityIssue[]
    ): void {
        for (const { pattern, message } of patterns) {
            // Ensure global flag for matchAll
            const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
            const matches = output.matchAll(new RegExp(pattern.source, flags))

            for (const match of matches) {
                // Determine severity based on type and strict mode
                const severity = this.strictMode || type === 'truncated' || type === 'placeholder'
                    ? 'error'
                    : 'warning'

                issues.push({
                    type,
                    severity,
                    message,
                    location: match.index !== undefined
                        ? { start: match.index, end: match.index + match[0].length }
                        : undefined,
                    suggestion: this.getSuggestion(type, match[0]),
                })
            }
        }
    }

    // ============================================
    // Code Completeness Check
    // ============================================

    private checkIncompleteCode(output: string, issues: QualityIssue[]): void {
        // Check for unbalanced brackets
        const brackets: Record<string, number> = { '{': 0, '[': 0, '(': 0 }
        const closers: Record<string, string> = { '}': '{', ']': '[', ')': '(' }

        for (const char of output) {
            if (char in brackets) brackets[char]++
            if (char in closers) brackets[closers[char]]--
        }

        for (const [bracket, count] of Object.entries(brackets)) {
            if (count > 0) {
                issues.push({
                    type: 'incomplete',
                    severity: 'error',
                    message: `Unbalanced brackets: ${count} unclosed '${bracket}'`,
                    suggestion: 'Complete all code blocks',
                })
            }
        }

        // Check for empty function bodies
        const emptyFunctions = output.match(/\{\s*\}/g)
        if (emptyFunctions && emptyFunctions.length > 0) {
            issues.push({
                type: 'incomplete',
                severity: 'warning',
                message: `Found ${emptyFunctions.length} empty code blocks`,
                suggestion: 'Implement function bodies',
            })
        }

        // Check for "pass" or empty returns
        if (/\breturn\s*;?\s*$/m.test(output)) {
            issues.push({
                type: 'incomplete',
                severity: 'warning',
                message: 'Empty return statement found',
                suggestion: 'Return a meaningful value',
            })
        }
    }

    // ============================================
    // Confidence Calculation
    // ============================================

    private calculateConfidence(output: string, issues: QualityIssue[]): number {
        let confidence = 1.0

        // Deduct for each issue
        for (const issue of issues) {
            if (issue.severity === 'error') {
                confidence -= 0.2
            } else {
                confidence -= 0.05
            }
        }

        // Bonus for explicitly admitting unknowns (honesty)
        if (/i don'?t know|ich weiß nicht|unsicher|not sure|unclear/i.test(output)) {
            confidence += 0.1 // Honesty is good
        }

        // Deduct for overconfident language without substance
        if (/definitely|absolutely|certainly|100%/i.test(output)) {
            confidence -= 0.1
        }

        return Math.max(0, Math.min(1, confidence))
    }

    // ============================================
    // Suggestions
    // ============================================

    private getSuggestion(type: QualityIssueType, match: string): string {
        switch (type) {
            case 'placeholder':
                return 'Implement the actual functionality instead of leaving a placeholder'
            case 'truncated':
                return 'Provide the complete code without truncation'
            case 'mock':
                return 'Use real implementation instead of mock data'
            case 'vague':
                return 'Provide specific, concrete explanation'
            case 'incomplete':
                return 'Complete the implementation'
            default:
                return 'Review and fix this issue'
        }
    }

    // ============================================
    // Custom Patterns
    // ============================================

    addPattern(pattern: RegExp, message: string, type: QualityIssueType): void {
        this.customPatterns.push({ pattern, message, type })
    }

    // ============================================
    // Utility Methods
    // ============================================

    /**
     * Check if output should be rejected
     */
    shouldReject(output: string): boolean {
        const result = this.validate(output)
        return !result.valid || result.confidence < 0.5
    }

    /**
     * Get a human-readable report
     */
    getReport(output: string): string {
        const result = this.validate(output)

        if (result.valid && result.issues.length === 0) {
            return '✅ Output passes quality check'
        }

        const lines = [
            `⚠️ Quality Issues Found (Confidence: ${(result.confidence * 100).toFixed(0)}%)`,
            '',
        ]

        for (const issue of result.issues) {
            const icon = issue.severity === 'error' ? '❌' : '⚠️'
            lines.push(`${icon} [${issue.type}] ${issue.message}`)
            if (issue.suggestion) {
                lines.push(`   → ${issue.suggestion}`)
            }
        }

        if (result.requiresHumanReview) {
            lines.push('')
            lines.push('🔍 Human review required')
        }

        return lines.join('\n')
    }
}

// ============================================
// Factory
// ============================================

export function createOutputValidator(strictMode = true): OutputValidator {
    return new OutputValidator({ strictMode })
}

// ============================================
// Middleware Function
// ============================================

/**
 * Wrap LLM response with quality validation
 * Returns validated response or throws if quality is too low
 */
export async function withQualityGate<T extends string>(
    generateFn: () => Promise<T>,
    validator?: OutputValidator
): Promise<{ output: T; validation: ValidationResult }> {
    const v = validator ?? createOutputValidator()
    const output = await generateFn()
    const validation = v.validate(output)

    if (!validation.valid) {
        console.warn('[Nova Quality] Output failed validation:')
        console.warn(v.getReport(output))
    }

    return { output, validation }
}

export default {
    OutputValidator,
    createOutputValidator,
    withQualityGate,
}
