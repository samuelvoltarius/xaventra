/**
 * Task Planner
 * 
 * Breaks complex user requests into executable steps.
 * Each step can use tools and the results feed into the next step.
 */

// ============================================
// Types
// ============================================

export interface TaskStep {
    id: number
    description: string
    tool?: string
    params?: Record<string, unknown>
    status: 'pending' | 'running' | 'done' | 'failed'
    result?: unknown
    error?: string
}

export interface TaskPlan {
    id: string
    originalRequest: string
    steps: TaskStep[]
    currentStep: number
    status: 'planning' | 'executing' | 'done' | 'failed'
    createdAt: number
}

// ============================================
// Step Detection Patterns
// ============================================

const STEP_PATTERNS = [
    {
        // Installation requests
        pattern: /install(iere?|ation)?|einrichten|setup/i,
        steps: (match: string, request: string) => {
            const pkg = request.match(/install(?:iere?)?\s+(\S+)/i)?.[1] || 'package'
            return [
                { description: `Prüfe ob ${pkg} bereits installiert ist`, tool: 'run_command' },
                { description: `Installiere ${pkg}`, tool: 'run_command' },
                { description: 'Verifiziere Installation', tool: 'run_command' },
            ]
        }
    },
    {
        // Create file/script requests
        pattern: /erstell|create|schreib.*script|mach.*datei/i,
        steps: (match: string, request: string) => [
            { description: 'Recherchiere best practices', tool: 'web_search' },
            { description: 'Erstelle die Datei', tool: 'write_file' },
            { description: 'Teste die Datei', tool: 'run_command' },
        ]
    },
    {
        // Search + action requests
        pattern: /such.*und.*|find.*dann/i,
        steps: () => [
            { description: 'Suche nach Informationen', tool: 'web_search' },
            { description: 'Analysiere Ergebnisse' },
            { description: 'Führe Aktion aus' },
        ]
    },
    {
        // Complex project requests
        pattern: /projekt|app|anwendung|website/i,
        steps: () => [
            { description: 'Analysiere Anforderungen' },
            { description: 'Erstelle Projektstruktur', tool: 'run_command' },
            { description: 'Erstelle Hauptdateien', tool: 'write_file' },
            { description: 'Installiere Dependencies', tool: 'run_command' },
            { description: 'Teste das Projekt', tool: 'run_command' },
        ]
    },
]

// ============================================
// Planner Functions
// ============================================

/**
 * Analyze request and create a plan
 */
export function createPlan(request: string): TaskPlan {
    const plan: TaskPlan = {
        id: crypto.randomUUID().slice(0, 8),
        originalRequest: request,
        steps: [],
        currentStep: 0,
        status: 'planning',
        createdAt: Date.now(),
    }

    // Try to match patterns
    for (const { pattern, steps } of STEP_PATTERNS) {
        const match = request.match(pattern)
        if (match) {
            const generatedSteps = steps(match[0], request)
            plan.steps = generatedSteps.map((s, i) => ({
                id: i + 1,
                description: s.description,
                tool: s.tool,
                status: 'pending' as const,
            }))
            break
        }
    }

    // If no pattern matches, create a simple plan
    if (plan.steps.length === 0) {
        plan.steps = [
            { id: 1, description: 'Analysiere Anfrage', status: 'pending' },
            { id: 2, description: 'Führe Hauptaktion aus', status: 'pending' },
            { id: 3, description: 'Überprüfe Ergebnis', status: 'pending' },
        ]
    }

    console.log(`[TaskPlanner] Created plan with ${plan.steps.length} steps`)
    return plan
}

/**
 * Check if request needs multi-step planning
 */
export function needsPlanning(request: string): boolean {
    // Complex requests benefit from planning
    const complexIndicators = [
        /und.*dann/i,          // "und dann"
        /schritt.*für.*schritt/i,
        /erstell.*komplett/i,
        /setup.*projekt/i,
        /install.*und.*konfigur/i,
        /such.*install.*test/i,
        request.length > 100,  // Long requests
        (request.match(/,/g) || []).length >= 2,  // Multiple commas = multiple tasks
    ]

    return complexIndicators.some(ind =>
        typeof ind === 'boolean' ? ind : ind.test(request)
    )
}

/**
 * Get current step
 */
export function getCurrentStep(plan: TaskPlan): TaskStep | null {
    if (plan.currentStep >= plan.steps.length) return null
    return plan.steps[plan.currentStep]
}

/**
 * Mark current step as done and advance
 */
export function advanceStep(plan: TaskPlan, result?: unknown): TaskPlan {
    if (plan.currentStep < plan.steps.length) {
        plan.steps[plan.currentStep].status = 'done'
        plan.steps[plan.currentStep].result = result
        plan.currentStep++
    }

    if (plan.currentStep >= plan.steps.length) {
        plan.status = 'done'
    }

    return plan
}

/**
 * Mark current step as failed
 */
export function failStep(plan: TaskPlan, error: string): TaskPlan {
    if (plan.currentStep < plan.steps.length) {
        plan.steps[plan.currentStep].status = 'failed'
        plan.steps[plan.currentStep].error = error
    }
    plan.status = 'failed'
    return plan
}

/**
 * Get plan summary for user
 */
export function getPlanSummary(plan: TaskPlan): string {
    const stepList = plan.steps.map((s, i) => {
        const icon = s.status === 'done' ? '✅' :
            s.status === 'failed' ? '❌' :
                s.status === 'running' ? '🔄' : '⬜'
        return `${icon} ${i + 1}. ${s.description}`
    }).join('\n')

    return `📋 **Plan** (${plan.currentStep}/${plan.steps.length}):\n${stepList}`
}

/**
 * Get prompt addition for planning context
 */
export function getPlanningPrompt(plan: TaskPlan): string {
    const currentStep = getCurrentStep(plan)
    if (!currentStep) return ''

    const prevSteps = plan.steps
        .filter(s => s.status === 'done')
        .map(s => `✅ ${s.description}: ${JSON.stringify(s.result).slice(0, 100)}`)
        .join('\n')

    return `

## AKTUELLER PLAN
${getPlanSummary(plan)}

## VORHERIGE ERGEBNISSE
${prevSteps || 'Keine'}

## NÄCHSTER SCHRITT
${currentStep.description}${currentStep.tool ? ` (nutze: ${currentStep.tool})` : ''}

Führe NUR diesen einen Schritt aus!`
}

export default {
    createPlan,
    needsPlanning,
    getCurrentStep,
    advanceStep,
    failStep,
    getPlanSummary,
    getPlanningPrompt,
}
