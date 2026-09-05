/**
 * L12 - Anti-Hallucination Layer
 * 
 * This layer PREVENTS Nova from lying or hallucinating results.
 * It validates that Nova's response matches the actual tool outputs.
 * 
 * If Nova says "Erfolgreich" but the tool failed, this layer BLOCKS the response!
 */

// ============================================
// Types
// ============================================

export interface ToolExecution {
    toolName: string
    params: Record<string, unknown>
    result: string
    success: boolean
    timestamp: number
}

export interface ValidationResult {
    isValid: boolean
    violations: string[]
    correctedResponse?: string
    shouldBlock: boolean
}

// ============================================
// Detection Patterns
// ============================================

// Patterns that indicate claimed success
const SUCCESS_CLAIMS = [
    /✅\s*(erfolgreich|erfolg|installiert|fertig|done|complete)/gi,
    /installation\s+(erfolgreich|abgeschlossen|fertig)/gi,
    /wurde\s+(installiert|erstellt|kopiert|übertragen)/gi,
    /habe\s+(installiert|erstellt|konfiguriert)/gi,
    /ist\s+(installiert|fertig|bereit)/gi,
    /läuft\s+(jetzt|bereits)/gi,
]

// Patterns that indicate actual failure in tool output
const FAILURE_PATTERNS = [
    /error/i,
    /failed/i,
    /nicht gefunden/i,
    /not found/i,
    /command not found/i,
    /permission denied/i,
    /access denied/i,
    /fehlgeschlagen/i,
    /konnte nicht/i,
    /ist entweder falsch geschrieben/i,
    /no such file/i,
    /cannot find/i,
    /ETIMEDOUT/i,
    /ECONNREFUSED/i,
    /ENOENT/i,
]

// Patterns that indicate Nova is inventing things
const HALLUCINATION_PATTERNS = [
    /ich habe\s+\w+\s+auf\s+"?strict\s+mode"?\s+gesetzt/gi,  // "Layer auf Strict Mode gesetzt"
    /ich habe\s+\w+\s+aktiviert/gi,  // Claiming to have activated something
    /ich habe\s+gerade\s+\w+\s+(installiert|konfiguriert)/gi,  // Claiming instant install
]

// ============================================
// Validation Functions
// ============================================

/**
 * Check if a tool result indicates failure
 */
export function didToolFail(result: string): boolean {
    return FAILURE_PATTERNS.some(pattern => pattern.test(result))
}

/**
 * Check if response claims success
 */
export function claimsSuccess(response: string): boolean {
    return SUCCESS_CLAIMS.some(pattern => pattern.test(response))
}

/**
 * Check if response contains hallucinations (invented claims)
 */
export function containsHallucination(response: string): boolean {
    return HALLUCINATION_PATTERNS.some(pattern => pattern.test(response))
}

/**
 * Extract all tool results from a response
 */
export function extractToolResults(response: string): string[] {
    const results: string[] = []
    // Look for patterns like "✅ Erfolgreich:\n```\n...\n```"
    const codeBlockPattern = /```[\s\S]*?```/g
    const matches = response.matchAll(codeBlockPattern)
    for (const match of matches) {
        results.push(match[0])
    }
    return results
}

// ============================================
// Main Validation
// ============================================

/**
 * Validate Nova's response against actual tool results
 */
export function validateResponse(
    response: string,
    toolExecutions: ToolExecution[]
): ValidationResult {
    const violations: string[] = []
    let shouldBlock = false

    // Check 1: Did any tool fail but Nova claims success?
    const failedTools = toolExecutions.filter(t => !t.success || didToolFail(t.result))

    if (failedTools.length > 0 && claimsSuccess(response)) {
        violations.push(
            `LÜGE ERKANNT: Nova sagt "Erfolgreich" aber ${failedTools.length} Tool(s) sind fehlgeschlagen!`
        )
        shouldBlock = true

        // Log the actual failures
        for (const tool of failedTools) {
            violations.push(`  → ${tool.toolName} FAILED: ${tool.result.slice(0, 100)}...`)
        }
    }

    // Check 2: Is Nova inventing/hallucinating things?
    if (containsHallucination(response)) {
        violations.push(`HALLUZINATION ERKANNT: Nova erfindet Aktionen die nicht passiert sind!`)
        shouldBlock = true
    }

    // Check 3: Is Nova claiming to have done something without any tool call?
    const actionClaims = response.match(/ich habe\s+\w+/gi) || []
    if (actionClaims.length > 0 && toolExecutions.length === 0) {
        violations.push(`ERFINDUNG ERKANNT: Nova behauptet "${actionClaims[0]}" aber hat kein Tool benutzt!`)
        // Don't block, just warn - might be referring to previous actions
    }

    // Check 4: Platform mismatch - claiming Linux on Windows
    const claimsLinux = /apt(-get)?|yum|systemctl|\/bin\//i.test(response)
    const toolShowsWindows = toolExecutions.some(t =>
        t.result.includes('Windows') ||
        t.result.includes(':\\') ||
        t.result.includes('Der Befehl')
    )

    if (claimsLinux && toolShowsWindows) {
        violations.push(`PLATTFORM-LÜGE: Nova redet über Linux-Befehle aber ist auf Windows!`)
        shouldBlock = true
    }

    return {
        isValid: violations.length === 0,
        violations,
        shouldBlock,
        correctedResponse: shouldBlock ? generateCorrectedResponse(toolExecutions, violations) : undefined
    }
}

/**
 * Generate an honest response when Nova's response is blocked
 */
function generateCorrectedResponse(toolExecutions: ToolExecution[], violations: string[]): string {
    const failedTools = toolExecutions.filter(t => !t.success || didToolFail(t.result))

    let corrected = `⚠️ **Ehrliche Korrektur (Anti-Hallucination Layer):**\n\n`

    if (failedTools.length > 0) {
        corrected += `Die folgenden Befehle sind **fehlgeschlagen**:\n\n`
        for (const tool of failedTools) {
            corrected += `❌ **${tool.toolName}:**\n\`\`\`\n${tool.result.slice(0, 300)}\n\`\`\`\n\n`
        }
    }

    corrected += `---\n\n**Was ich wirklich tun kann:**\n`
    corrected += `1. Den Fehler analysieren\n`
    corrected += `2. Eine andere Lösung vorschlagen\n`
    corrected += `3. Mehr Informationen anfordern\n\n`
    corrected += `💡 Was soll ich als nächstes versuchen?`

    return corrected
}

// ============================================
// Pre-Response Validation (before LLM generates)
// ============================================

/**
 * Generate a strict instruction to prevent hallucination
 */
export function getAntiHallucinationPrompt(toolExecutions: ToolExecution[]): string {
    const failedTools = toolExecutions.filter(t => !t.success || didToolFail(t.result))

    if (failedTools.length === 0) {
        return ''
    }

    let prompt = `\n\n## ⚠️ ANTI-HALLUCINATION WARNUNG!\n`
    prompt += `Die folgenden Tools sind FEHLGESCHLAGEN:\n\n`

    for (const tool of failedTools) {
        prompt += `- ${tool.toolName}: "${tool.result.slice(0, 100)}..."\n`
    }

    prompt += `\nDu MUSST in deiner Antwort:\n`
    prompt += `1. EHRLICH sagen dass der Befehl fehlgeschlagen ist\n`
    prompt += `2. Den ECHTEN Fehler zitieren\n`
    prompt += `3. NICHT behaupten es hätte funktioniert!\n`
    prompt += `4. KEINE erfundenen "Fixes" oder "Strict Modes" erwähnen!\n`

    return prompt
}

// ============================================
// Learning from Corrections
// ============================================

interface LieRecord {
    timestamp: number
    violation: string
    originalResponse: string
    correctedResponse: string
}

const lieHistory: LieRecord[] = []

/**
 * Record a lie for future learning
 */
export function recordLie(violation: string, original: string, corrected: string): void {
    lieHistory.push({
        timestamp: Date.now(),
        violation,
        originalResponse: original,
        correctedResponse: corrected,
    })

    console.log(`[L12 AntiHallucination] 🚨 LIE RECORDED: ${violation}`)

    // Keep only last 50 lies
    if (lieHistory.length > 50) {
        lieHistory.shift()
    }
}

/**
 * Get lie statistics
 */
export function getLieStats(): { total: number; recent: number; patterns: string[] } {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const recentLies = lieHistory.filter(l => l.timestamp > oneHourAgo)

    const patterns = [...new Set(lieHistory.map(l => l.violation.split(':')[0]))]

    return {
        total: lieHistory.length,
        recent: recentLies.length,
        patterns,
    }
}

// ============================================
// LLM-Based Second-Opinion Validation
// ============================================

let internalLLM: any = null

/**
 * Set the internal LLM for deep fact-checking
 */
export function setInternalLLM(llm: any): void {
    internalLLM = llm
    console.log('[L12] 🧠 LLM-based fact-checking enabled')
}

/**
 * Deep validation using internal LLM as second opinion.
 * Sends Nova's response + actual tool outputs to local LLM
 * and asks it to check for inconsistencies.
 */
export async function validateWithLLM(
    response: string,
    toolExecutions: ToolExecution[]
): Promise<{ honest: boolean; issues: string[] }> {
    if (!internalLLM) {
        return { honest: true, issues: [] }
    }

    try {
        const toolSummary = toolExecutions.map(t =>
            `Tool: ${t.toolName}\nSuccess: ${t.success}\nOutput: ${t.result.slice(0, 200)}`
        ).join('\n---\n')

        const checkPrompt = `Du bist ein Faktenprüfer. Vergleiche die AI-Antwort mit den tatsächlichen Tool-Ergebnissen.

TOOL-ERGEBNISSE (Wahrheit):
${toolSummary || 'Keine Tools verwendet.'}

AI-ANTWORT (zu prüfen):
${response.slice(0, 500)}

Prüfe:
1. Behauptet die Antwort Erfolg obwohl Tools fehlschlugen?
2. Erfindet die Antwort Ergebnisse die nicht in den Tool-Outputs stehen?
3. Widerspricht die Antwort den Tool-Ergebnissen?

Antworte NUR mit JSON: {"honest": true/false, "issues": ["issue1", "issue2"]}`

        const result = await internalLLM.complete([
            { role: 'user', content: checkPrompt }
        ])

        // Parse JSON response from LLM
        const jsonMatch = result.content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            if (!parsed.honest) {
                console.log(`[L12] 🚨 LLM Second-Opinion: UNEHRLICH - ${parsed.issues.join(', ')}`)
            }
            return {
                honest: parsed.honest !== false,
                issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            }
        }
    } catch (err) {
        // LLM check is optional, don't break on failure
        console.log(`[L12] LLM fact-check skipped: ${err}`)
    }

    return { honest: true, issues: [] }
}

export default {
    validateResponse,
    validateWithLLM,
    setInternalLLM,
    didToolFail,
    claimsSuccess,
    containsHallucination,
    getAntiHallucinationPrompt,
    recordLie,
    getLieStats,
}

