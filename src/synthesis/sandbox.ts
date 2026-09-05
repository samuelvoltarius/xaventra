/**
 * Nova - Skill Sandbox
 * 
 * Isolated execution environment for new skills
 * Uses worker_threads for isolation with timeouts
 */

import { Worker } from 'node:worker_threads'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface SandboxOptions {
    timeout: number      // Max execution time in ms
    memoryLimit: number  // Max memory in MB (advisory)
}

export interface SandboxResult {
    success: boolean
    output: unknown
    error?: string
    durationMs: number
    memoryUsed?: number
}

// ============================================
// Default Options
// ============================================

const DEFAULT_OPTIONS: SandboxOptions = {
    timeout: 30000,      // 30 seconds
    memoryLimit: 128,    // 128 MB
}

// ============================================
// Sandbox Directory
// ============================================

const SANDBOX_DIR = join(process.cwd(), '.nova-sandbox')

function ensureSandboxDir(): void {
    if (!existsSync(SANDBOX_DIR)) {
        mkdirSync(SANDBOX_DIR, { recursive: true })
    }
}

// ============================================
// Sandbox Execution
// ============================================

export async function runInSandbox(
    code: string,
    options: Partial<SandboxOptions> = {}
): Promise<SandboxResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const startTime = Date.now()

    ensureSandboxDir()

    // Create temporary file
    const fileId = `sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const filePath = join(SANDBOX_DIR, `${fileId}.mjs`)

    // Wrap code for worker execution
    const wrappedCode = `
import { parentPort } from 'node:worker_threads'

async function runSandboxedCode() {
    try {
        ${code}
    } catch (err) {
        throw err
    }
}

runSandboxedCode()
    .then(result => {
        parentPort?.postMessage({ success: true, result })
    })
    .catch(err => {
        parentPort?.postMessage({ success: false, error: String(err) })
    })
`

    try {
        writeFileSync(filePath, wrappedCode)

        return await new Promise<SandboxResult>((resolve) => {
            const worker = new Worker(filePath, {
                resourceLimits: {
                    maxOldGenerationSizeMb: opts.memoryLimit,
                    maxYoungGenerationSizeMb: opts.memoryLimit / 4,
                }
            })

            const timeoutHandle = setTimeout(() => {
                worker.terminate()
                resolve({
                    success: false,
                    output: null,
                    error: `Timeout after ${opts.timeout}ms`,
                    durationMs: opts.timeout,
                })
            }, opts.timeout)

            worker.on('message', (msg: { success: boolean; result?: unknown; error?: string }) => {
                clearTimeout(timeoutHandle)
                resolve({
                    success: msg.success,
                    output: msg.result,
                    error: msg.error,
                    durationMs: Date.now() - startTime,
                })
            })

            worker.on('error', (err) => {
                clearTimeout(timeoutHandle)
                resolve({
                    success: false,
                    output: null,
                    error: String(err),
                    durationMs: Date.now() - startTime,
                })
            })

            worker.on('exit', (code) => {
                clearTimeout(timeoutHandle)
                if (code !== 0) {
                    resolve({
                        success: false,
                        output: null,
                        error: `Worker exited with code ${code}`,
                        durationMs: Date.now() - startTime,
                    })
                }
            })
        })
    } finally {
        // Cleanup
        try {
            unlinkSync(filePath)
        } catch {
            // Ignore cleanup errors
        }
    }
}

// ============================================
// Safe Skill Validation
// ============================================

const FORBIDDEN_PATTERNS = [
    /\bprocess\b/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
    /\bglobalThis\b/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bmodule\s*\./,
    /\.constructor\b/,
    /__proto__/,
    /require\s*\(\s*['"]child_process['"]\s*\)/,
    /require\s*\(\s*['"]fs['"]\s*\)/,
    /import\s+.*from\s+['"]child_process['"]/,
    /import\s+.*from\s+['"]fs['"]/,
    /process\.exit/,
    /eval\s*\(/,
    /Function\s*\(/,
    /\.exec\s*\(/,
    /\.spawn\s*\(/,
    /rm\s+-rf/,
    /del\s+\/s\s+\/q/,
]

export function validateSkillCode(code: string): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(code)) {
            errors.push(`Forbidden pattern detected: ${pattern.source}`)
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

// ============================================
// Test Runner
// ============================================

export async function runSkillTests(
    skillCode: string,
    testCode: string,
    options: Partial<SandboxOptions> = {}
): Promise<{ passed: boolean; results: unknown; error?: string }> {
    const combinedCode = `
// Skill Code
${skillCode}

// Test Code
const testResults = []
const assert = (condition, message) => {
    testResults.push({
        passed: !!condition,
        message: message || (condition ? 'OK' : 'Failed'),
    })
}

${testCode}

return testResults
`

    const result = await runInSandbox(combinedCode, options)

    if (!result.success) {
        return { passed: false, results: [], error: result.error }
    }

    const testResults = result.output as Array<{ passed: boolean; message: string }>
    const allPassed = Array.isArray(testResults) && testResults.every(t => t.passed)

    return {
        passed: allPassed,
        results: testResults,
        error: allPassed ? undefined : 'Some tests failed',
    }
}
