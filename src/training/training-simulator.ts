/**
 * Training Simulator
 * 
 * Generates test scenarios and evaluates Nova's responses.
 * Simulates "training" by testing and improving patterns.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Scenario {
    id: string
    category: 'install' | 'create' | 'search' | 'debug' | 'explain'
    input: string
    expectedBehavior: string[]  // What Nova should do
    difficulty: 'easy' | 'medium' | 'hard'
}

export interface ScenarioResult {
    scenarioId: string
    response: string
    toolsUsed: string[]
    score: number  // 0-100
    issues: string[]
    timestamp: number
}

export interface TrainingSession {
    id: string
    scenarios: Scenario[]
    results: ScenarioResult[]
    startedAt: number
    completedAt?: number
    overallScore?: number
}

// ============================================
// Scenario Library
// ============================================

const SCENARIO_TEMPLATES: Scenario[] = [
    // Install scenarios
    {
        id: 'install-pip-package',
        category: 'install',
        input: 'Installiere das requests Paket für Python',
        expectedBehavior: ['use run_command', 'pip install requests', 'verify installation'],
        difficulty: 'easy',
    },
    {
        id: 'install-npm-package',
        category: 'install',
        input: 'Ich brauche lodash in meinem Node-Projekt',
        expectedBehavior: ['use run_command', 'npm install lodash'],
        difficulty: 'easy',
    },
    {
        id: 'install-missing-tool',
        category: 'install',
        input: 'edge-tts funktioniert nicht',
        expectedBehavior: ['diagnose error', 'search for solution', 'install edge-tts'],
        difficulty: 'medium',
    },

    // Create scenarios
    {
        id: 'create-python-script',
        category: 'create',
        input: 'Erstelle ein Python-Script das "Hello World" ausgibt',
        expectedBehavior: ['use write_file', 'create .py file', 'offer to run'],
        difficulty: 'easy',
    },
    {
        id: 'create-api-endpoint',
        category: 'create',
        input: 'Erstelle einen REST API Endpoint der User zurückgibt',
        expectedBehavior: ['use write_file', 'proper structure', 'error handling'],
        difficulty: 'medium',
    },

    // Search scenarios
    {
        id: 'search-documentation',
        category: 'search',
        input: 'Wie funktioniert async/await in JavaScript?',
        expectedBehavior: ['provide explanation', 'code example'],
        difficulty: 'easy',
    },
    {
        id: 'search-error-solution',
        category: 'search',
        input: 'ModuleNotFoundError: No module named pandas',
        expectedBehavior: ['identify error', 'suggest pip install pandas'],
        difficulty: 'easy',
    },

    // Debug scenarios
    {
        id: 'debug-syntax-error',
        category: 'debug',
        input: 'Mein Python-Script gibt SyntaxError: invalid syntax',
        expectedBehavior: ['ask for code', 'identify issue', 'provide fix'],
        difficulty: 'medium',
    },

    // Explain scenarios
    {
        id: 'explain-concept',
        category: 'explain',
        input: 'Was ist der Unterschied zwischen let und const?',
        expectedBehavior: ['clear explanation', 'examples'],
        difficulty: 'easy',
    },
]

// ============================================
// Simulator Functions
// ============================================

const TRAINING_DIR = '.nova-training'

function ensureDir(): void {
    const dir = join(process.cwd(), TRAINING_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * Generate scenarios for a training session
 */
export function generateScenarios(count: number = 5, categories?: Scenario['category'][]): Scenario[] {
    let available = [...SCENARIO_TEMPLATES]

    if (categories && categories.length > 0) {
        available = available.filter(s => categories.includes(s.category))
    }

    // Shuffle and take count
    const shuffled = available.sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
}

/**
 * Evaluate a response against scenario expectations
 */
export function evaluateResponse(
    scenario: Scenario,
    response: string,
    toolsUsed: string[]
): ScenarioResult {
    const issues: string[] = []
    let score = 100

    // Check expected behaviors
    for (const expected of scenario.expectedBehavior) {
        const normalizedExpected = expected.toLowerCase()
        const normalizedResponse = response.toLowerCase()

        // Check if behavior is present
        if (normalizedExpected.includes('use ')) {
            const tool = normalizedExpected.replace('use ', '')
            if (!toolsUsed.some(t => t.includes(tool))) {
                issues.push(`Expected tool: ${tool}`)
                score -= 15
            }
        } else if (!normalizedResponse.includes(normalizedExpected)) {
            issues.push(`Missing: ${expected}`)
            score -= 10
        }
    }

    // Check for common issues
    if (response.length < 20) {
        issues.push('Response too short')
        score -= 20
    }

    if (response.includes('I am') || response.includes('I will')) {
        issues.push('English phrases in German context')
        score -= 5
    }

    return {
        scenarioId: scenario.id,
        response,
        toolsUsed,
        score: Math.max(0, score),
        issues,
        timestamp: Date.now(),
    }
}

/**
 * Create a new training session
 */
export function createSession(scenarios?: Scenario[]): TrainingSession {
    return {
        id: crypto.randomUUID().slice(0, 8),
        scenarios: scenarios || generateScenarios(5),
        results: [],
        startedAt: Date.now(),
    }
}

/**
 * Complete a training session
 */
export function completeSession(session: TrainingSession): TrainingSession {
    session.completedAt = Date.now()
    session.overallScore = session.results.length > 0
        ? Math.round(session.results.reduce((sum, r) => sum + r.score, 0) / session.results.length)
        : 0

    // Save session
    ensureDir()
    const path = join(process.cwd(), TRAINING_DIR, `session-${session.id}.json`)
    writeFileSync(path, JSON.stringify(session, null, 2))

    console.log(`[Training] Session ${session.id} completed. Score: ${session.overallScore}/100`)
    return session
}

/**
 * Get training report
 */
export function getTrainingReport(session: TrainingSession): string {
    const lines = [
        `# Training Session ${session.id}`,
        `Score: ${session.overallScore ?? 'N/A'}/100`,
        '',
        '## Ergebnisse:',
    ]

    for (const result of session.results) {
        const scenario = session.scenarios.find(s => s.id === result.scenarioId)
        const icon = result.score >= 80 ? '✅' : result.score >= 50 ? '⚠️' : '❌'
        lines.push(`${icon} ${scenario?.input.slice(0, 40)}... → ${result.score}/100`)
        if (result.issues.length > 0) {
            lines.push(`   Issues: ${result.issues.join(', ')}`)
        }
    }

    return lines.join('\n')
}

export default {
    generateScenarios,
    evaluateResponse,
    createSession,
    completeSession,
    getTrainingReport,
}
