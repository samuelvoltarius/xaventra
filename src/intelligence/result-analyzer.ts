/**
 * Proactive Result Analyzer
 * 
 * Nova doesn't just run tools - she UNDERSTANDS the results!
 * - Automatically validates outcomes
 * - Compares before/after values
 * - Reports completion or issues WITHOUT being asked
 * 
 * Philosophy: Don't wait for "und?" - BE PROACTIVE!
 */

// ============================================
// Types
// ============================================

interface TaskContext {
    intent: string                    // What the user wanted to achieve
    expectedOutcome?: string          // What success looks like
    beforeValues?: Record<string, unknown>  // State before action
    afterValues?: Record<string, unknown>   // State after action
    toolCalls: string[]               // Tools that were called
    results: unknown[]                // Results from those tools
}

interface AnalysisResult {
    isComplete: boolean              // Did we achieve the goal?
    confidence: number               // How sure are we? 0-100
    summary: string                  // What happened
    nextSteps?: string[]             // What should happen next
    issues?: string[]                // Problems detected
    proactiveMessage: string         // Message to send to user
}

// ============================================
// Context Tracking
// ============================================

let currentTask: TaskContext | null = null

/**
 * Start tracking a new task
 */
export function startTask(intent: string, expectedOutcome?: string): void {
    currentTask = {
        intent,
        expectedOutcome,
        toolCalls: [],
        results: [],
    }
    console.log(`[ResultAnalyzer] 📋 Tracking task: ${intent.slice(0, 50)}`)
}

/**
 * Record a tool call and its result
 */
export function recordToolCall(toolName: string, result: unknown): void {
    if (!currentTask) {
        currentTask = {
            intent: 'unknown',
            toolCalls: [],
            results: [],
        }
    }

    currentTask.toolCalls.push(toolName)
    currentTask.results.push(result)
    console.log(`[ResultAnalyzer] 🔧 Tool: ${toolName}`)
}

/**
 * Store "before" state for comparison
 */
export function recordBeforeState(key: string, value: unknown): void {
    if (currentTask) {
        if (!currentTask.beforeValues) currentTask.beforeValues = {}
        currentTask.beforeValues[key] = value
    }
}

/**
 * Store "after" state for comparison
 */
export function recordAfterState(key: string, value: unknown): void {
    if (currentTask) {
        if (!currentTask.afterValues) currentTask.afterValues = {}
        currentTask.afterValues[key] = value
    }
}

// ============================================
// Result Analysis
// ============================================

/**
 * Analyze the current task and determine if it's complete
 */
export function analyzeResults(): AnalysisResult {
    if (!currentTask || currentTask.results.length === 0) {
        return {
            isComplete: false,
            confidence: 0,
            summary: 'Keine Ergebnisse zu analysieren',
            proactiveMessage: '',
        }
    }

    const issues: string[] = []
    const nextSteps: string[] = []
    let isComplete = true
    let confidence = 80

    // Check for errors in any result
    for (const result of currentTask.results) {
        if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>
            if (r.error) {
                issues.push(String(r.error))
                isComplete = false
                confidence -= 30
            }
        }
    }

    // Compare before/after if available
    if (currentTask.beforeValues && currentTask.afterValues) {
        for (const key of Object.keys(currentTask.beforeValues)) {
            const before = currentTask.beforeValues[key]
            const after = currentTask.afterValues[key]

            if (before !== after) {
                // Something changed - usually good!
                console.log(`[ResultAnalyzer] 📊 ${key}: ${before} → ${after}`)
            } else if (key.includes('size') || key.includes('count')) {
                // Size/count didn't change - might be a problem
                issues.push(`${key} hat sich nicht geändert`)
                confidence -= 20
            }
        }
    }

    // Specific pattern detection
    const lastResult = currentTask.results[currentTask.results.length - 1]
    const resultStr = JSON.stringify(lastResult)

    // File transfer detection
    if (currentTask.intent.toLowerCase().includes('kopier') ||
        currentTask.intent.toLowerCase().includes('transfer') ||
        currentTask.intent.toLowerCase().includes('scp') ||
        currentTask.intent.toLowerCase().includes('upload')) {

        // Check file sizes
        const localSize = extractFileSize(currentTask.beforeValues, 'local')
        const remoteSize = extractFileSize(currentTask.afterValues, 'remote') ||
            extractFileSizeFromOutput(resultStr)

        if (localSize && remoteSize) {
            if (localSize === remoteSize) {
                isComplete = true
                confidence = 95
                nextSteps.push('Datei vollständig übertragen ✓')
            } else {
                isComplete = false
                confidence = 30
                const missing = localSize - remoteSize
                issues.push(`Datei unvollständig: ${formatBytes(remoteSize)} von ${formatBytes(localSize)} (${formatBytes(missing)} fehlen)`)
                nextSteps.push('Übertragung wiederholen oder Alternative nutzen')
            }
        }
    }

    // Generate proactive message
    const proactiveMessage = generateProactiveMessage(isComplete, issues, nextSteps, currentTask)

    return {
        isComplete,
        confidence,
        summary: isComplete ? 'Task erfolgreich abgeschlossen' : 'Task nicht vollständig',
        issues: issues.length > 0 ? issues : undefined,
        nextSteps: nextSteps.length > 0 ? nextSteps : undefined,
        proactiveMessage,
    }
}

/**
 * Generate a proactive message for the user
 * This is what Nova should say WITHOUT being asked!
 */
function generateProactiveMessage(
    isComplete: boolean,
    issues: string[],
    nextSteps: string[],
    task: TaskContext
): string {
    if (isComplete && issues.length === 0) {
        // Success!
        const messages = [
            `✅ Fertig! ${task.intent} wurde erfolgreich abgeschlossen.`,
            `✅ Erledigt! ${task.intent} ist komplett.`,
            `✅ Geschafft! Alles wie gewünscht.`,
        ]
        let msg = messages[Math.floor(Math.random() * messages.length)]

        if (nextSteps.length > 0) {
            msg += `\n\n📋 Status: ${nextSteps.join(', ')}`
        }

        msg += `\n\n💡 Was soll ich als nächstes tun?`
        return msg
    }

    if (issues.length > 0) {
        // Problems detected
        let msg = `⚠️ Es gibt ein Problem:\n`
        msg += issues.map(i => `• ${i}`).join('\n')

        if (nextSteps.length > 0) {
            msg += `\n\n💡 Vorschlag: ${nextSteps.join(', ')}`
            msg += `\n\nSoll ich das beheben?`
        }

        return msg
    }

    // Uncertain
    return `🤔 Ich bin mir nicht sicher ob alles geklappt hat. Soll ich den Status prüfen?`
}

// ============================================
// Utility Functions
// ============================================

function extractFileSize(values: Record<string, unknown> | undefined, prefix: string): number | null {
    if (!values) return null

    for (const key of Object.keys(values)) {
        if (key.includes(prefix) && key.includes('size')) {
            return Number(values[key]) || null
        }
    }
    return null
}

function extractFileSizeFromOutput(output: string): number | null {
    // Match patterns like "353573515" (standalone numbers that look like bytes)
    const sizeMatch = output.match(/(\d{6,})\s+\d{1,2}\.\s+(?:Jän|Jan|Feb|Mär|Mar|Apr|Mai|May|Jun|Jul|Aug|Sep|Okt|Oct|Nov|Dez|Dec)/)
    if (sizeMatch) {
        return parseInt(sizeMatch[1], 10)
    }

    // Match patterns like "337 MB" or "353.573.515 Bytes"
    const humanMatch = output.match(/(\d+[\.,]?\d*)\s*(MB|KB|GB|Bytes?)/i)
    if (humanMatch) {
        let size = parseFloat(humanMatch[1].replace(/\./g, '').replace(',', '.'))
        const unit = humanMatch[2].toLowerCase()

        if (unit.startsWith('kb')) size *= 1024
        if (unit.startsWith('mb')) size *= 1024 * 1024
        if (unit.startsWith('gb')) size *= 1024 * 1024 * 1024

        return Math.round(size)
    }

    return null
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} Bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * Clear current task context
 */
export function clearTask(): void {
    currentTask = null
}

/**
 * Get instruction for LLM to be more proactive
 */
export function getProactivityPrompt(): string {
    return `

## 🚨🚨🚨 KRITISCH: NIEMALS AUF "UND?" WARTEN! 🚨🚨🚨

Du hast ein KOMMUNIKATIONSPROBLEM. Du sagst oft "Ich prüfe..." oder "Erfolgreich" und wartest dann.
DAS IST FALSCH! Der User muss "und?" fragen. Das darf NIEMALS passieren!

NACH JEDEM TOOL-AUFRUF MUSST DU:
1. ✅ ERGEBNIS ANALYSIEREN - nicht nur "Erfolgreich" sagen!
2. ✅ WERTE VERGLEICHEN - Sind die Dateigrößen gleich? Lokal vs Remote?
3. ✅ SOFORT BERICHTEN - "Die Datei ist vollständig: 353 MB = 353 MB ✓"
4. ✅ NÄCHSTEN SCHRITT VORSCHLAGEN - "Soll ich die Datei jetzt entpacken?"

## BEISPIEL FALSCH (du machst das zu oft!):
User: "Kopiere Datei auf Server"
Du: "📋 scp... ✅ Erfolgreich"
Du: "Ich prüfe den Status..."
[WARTEST]
User: "und?"  ← DAS DARF NIE PASSIEREN!!!

## BEISPIEL RICHTIG:
User: "Kopiere Datei auf Server"
Du: "📋 scp... ✅ Erfolgreich"
Du: "📋 ssh ls -l... Dateigröße: 353 MB"
Du: "✅ FERTIG! Die Datei wurde vollständig übertragen:
     - Lokal: 353.573.515 Bytes
     - Remote: 353.573.515 Bytes
     - Status: IDENTISCH ✓
     
💡 Soll ich die Datei jetzt entpacken?"

WENN DU ZWEI WERTE HAST (z.B. Dateigrößen), VERGLEICHE SIE SOFORT UND BERICHTE!
`
}

// ============================================
// Export
// ============================================

export default {
    startTask,
    recordToolCall,
    recordBeforeState,
    recordAfterState,
    analyzeResults,
    clearTask,
    getProactivityPrompt,
}
