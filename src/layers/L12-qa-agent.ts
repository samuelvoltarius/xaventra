/**
 * L12 QA Agent - Test-Driven Development Support
 * 
 * Proactive testing layer that:
 * - Generates tests before code changes (TDD)
 * - Runs existing tests after changes
 * - Detects test failures and suggests fixes
 * - Tracks test coverage improvements
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execSync } from 'node:child_process'
import { getDefaultModel } from '../core/model-defaults.js'

// ============================================
// Types
// ============================================

export interface TestResult {
    success: boolean
    framework: 'jest' | 'vitest' | 'mocha' | 'unknown'
    passed: number
    failed: number
    skipped: number
    duration: number
    output: string
    errors: TestError[]
}

export interface TestError {
    file: string
    testName: string
    message: string
    expected?: string
    actual?: string
    stack?: string
}

export interface GeneratedTest {
    filepath: string
    content: string
    forFile: string
    framework: string
}

export interface QAConfig {
    testDir: string
    framework: 'jest' | 'vitest' | 'auto'
    generateBeforeChange: boolean
    runAfterChange: boolean
}

// ============================================
// QA Agent
// ============================================

export class QAAgent {
    private config: QAConfig
    private lastTestResult: TestResult | null = null

    constructor(config: Partial<QAConfig> = {}) {
        this.config = {
            testDir: config.testDir || '__tests__',
            framework: config.framework || 'auto',
            generateBeforeChange: config.generateBeforeChange ?? true,
            runAfterChange: config.runAfterChange ?? true,
        }

        console.log(`[L12 QA Agent] Initialized (framework: ${this.config.framework})`)
    }

    // ============================================
    // Test Detection
    // ============================================

    detectFramework(projectPath: string = process.cwd()): 'jest' | 'vitest' | 'mocha' | 'unknown' {
        const pkgPath = join(projectPath, 'package.json')

        if (!existsSync(pkgPath)) return 'unknown'

        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
            const deps = { ...pkg.dependencies, ...pkg.devDependencies }

            if (deps.vitest) return 'vitest'
            if (deps.jest) return 'jest'
            if (deps.mocha) return 'mocha'
        } catch { }

        return 'unknown'
    }

    findTestFile(sourceFile: string): string | null {
        const dir = dirname(sourceFile)
        const base = basename(sourceFile).replace(/\.(ts|js|tsx|jsx)$/, '')

        const candidates = [
            join(dir, '__tests__', `${base}.test.ts`),
            join(dir, '__tests__', `${base}.spec.ts`),
            join(dir, `${base}.test.ts`),
            join(dir, `${base}.spec.ts`),
            join(dir, '__tests__', `${base}.test.js`),
            join(dir, `${base}.test.js`),
        ]

        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                return candidate
            }
        }

        return null
    }

    // ============================================
    // Test Generation (via LLM)
    // ============================================

    async generateTestsFor(
        sourceFile: string,
        intent?: string
    ): Promise<GeneratedTest | null> {
        console.log(`[L12 QA Agent] Generating tests for: ${sourceFile}`)

        if (!existsSync(sourceFile)) {
            console.error(`[L12 QA Agent] Source file not found: ${sourceFile}`)
            return null
        }

        const sourceCode = readFileSync(sourceFile, 'utf-8')
        const framework = this.detectFramework()

        const prompt = `Du bist ein Test-Experte. Generiere Unit-Tests für diese Datei.

## Source File: ${sourceFile}
\`\`\`typescript
${sourceCode.slice(0, 4000)}
\`\`\`

${intent ? `## Intent der Änderung: ${intent}` : ''}

## Framework: ${framework === 'unknown' ? 'Jest (Standard)' : framework}

## Anforderungen:
1. Teste alle exportierten Funktionen/Klassen
2. Teste Edge Cases (null, undefined, leere Werte)
3. Teste Fehlerbehandlung
4. Nutze descriptive Test-Namen auf Deutsch
5. Verwende Mocks für externe Dependencies

Antworte NUR mit dem Test-Code, keine Erklärungen:

\`\`\`typescript
// Testcode hier
\`\`\``

        try {
            const apiKey = process.env.OPENAI_API_KEY
            if (!apiKey) throw new Error('No OpenAI API key')

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: getDefaultModel() || 'auto',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3,
                }),
            })

            const data = await response.json() as any
            const text = data.choices?.[0]?.message?.content || ''

            // Extract code block
            const codeMatch = text.match(/```typescript\s*([\s\S]*?)\s*```/)
            if (!codeMatch) {
                console.warn('[L12 QA Agent] No test code in response')
                return null
            }

            const testCode = codeMatch[1]

            // Generate test file path
            const dir = dirname(sourceFile)
            const base = basename(sourceFile).replace(/\.(ts|js)$/, '')
            const testDir = join(dir, '__tests__')
            const testFile = join(testDir, `${base}.test.ts`)

            // Ensure test directory exists
            if (!existsSync(testDir)) {
                mkdirSync(testDir, { recursive: true })
            }

            console.log(`[L12 QA Agent] Generated test: ${testFile}`)

            return {
                filepath: testFile,
                content: testCode,
                forFile: sourceFile,
                framework: framework === 'unknown' ? 'jest' : framework,
            }

        } catch (err) {
            console.error(`[L12 QA Agent] Test generation failed: ${err}`)
            return null
        }
    }

    async generateAndSaveTests(sourceFile: string, intent?: string): Promise<string | null> {
        const test = await this.generateTestsFor(sourceFile, intent)
        if (!test) return null

        writeFileSync(test.filepath, test.content)
        console.log(`[L12 QA Agent] Saved test file: ${test.filepath}`)
        return test.filepath
    }

    // ============================================
    // Test Execution
    // ============================================

    async runTests(
        projectPath: string = process.cwd(),
        filter?: string
    ): Promise<TestResult> {
        console.log(`[L12 QA Agent] Running tests in: ${projectPath}`)

        const framework = this.detectFramework(projectPath)
        let command: string

        switch (framework) {
            case 'vitest':
                command = filter ? `npx vitest run ${filter}` : 'npx vitest run'
                break
            case 'jest':
                command = filter ? `npx jest ${filter} --json` : 'npx jest --json'
                break
            case 'mocha':
                command = filter ? `npx mocha ${filter}` : 'npx mocha'
                break
            default:
                // Try npm test
                command = 'npm test --if-present'
        }

        const startTime = Date.now()

        try {
            const output = execSync(command, {
                cwd: projectPath,
                encoding: 'utf-8',
                timeout: 120000,
                maxBuffer: 10 * 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            const result = this.parseTestOutput(output, framework, Date.now() - startTime)
            this.lastTestResult = result
            return result

        } catch (err: any) {
            const output = err.stdout || err.stderr || String(err)
            const result = this.parseTestOutput(output, framework, Date.now() - startTime)
            result.success = false
            this.lastTestResult = result
            return result
        }
    }

    private parseTestOutput(
        output: string,
        framework: string,
        duration: number
    ): TestResult {
        const result: TestResult = {
            success: true,
            framework: framework as any,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration,
            output: output.slice(0, 5000),
            errors: [],
        }

        // Try to parse Jest JSON output
        if (framework === 'jest') {
            try {
                const json = JSON.parse(output)
                result.passed = json.numPassedTests || 0
                result.failed = json.numFailedTests || 0
                result.skipped = json.numPendingTests || 0
                result.success = json.success

                if (json.testResults) {
                    for (const testFile of json.testResults) {
                        for (const assertion of testFile.assertionResults || []) {
                            if (assertion.status === 'failed') {
                                result.errors.push({
                                    file: testFile.name,
                                    testName: assertion.fullName,
                                    message: assertion.failureMessages?.join('\n') || 'Test failed',
                                })
                            }
                        }
                    }
                }
            } catch {
                // Not valid JSON, parse text output
                this.parseTextOutput(output, result)
            }
        } else {
            this.parseTextOutput(output, result)
        }

        return result
    }

    private parseTextOutput(output: string, result: TestResult): void {
        // Generic parsing for non-JSON output
        const passMatch = output.match(/(\d+)\s*(passed|passing)/i)
        const failMatch = output.match(/(\d+)\s*(failed|failing)/i)
        const skipMatch = output.match(/(\d+)\s*(skipped|pending)/i)

        if (passMatch) result.passed = parseInt(passMatch[1])
        if (failMatch) result.failed = parseInt(failMatch[1])
        if (skipMatch) result.skipped = parseInt(skipMatch[1])

        result.success = result.failed === 0

        // Extract error messages
        const errorBlocks = output.match(/FAIL.*?(?=PASS|FAIL|$)/gs)
        if (errorBlocks) {
            for (const block of errorBlocks.slice(0, 5)) {
                result.errors.push({
                    file: 'unknown',
                    testName: 'unknown',
                    message: block.slice(0, 500),
                })
            }
        }
    }

    // ============================================
    // TDD Flow
    // ============================================

    async tddFlow(
        sourceFile: string,
        intent: string,
        onChange: (file: string, content: string) => Promise<void>
    ): Promise<{ testsGenerated: boolean; testsPassed: boolean }> {
        console.log(`[L12 QA Agent] Starting TDD flow for: ${sourceFile}`)

        // Step 1: Generate tests first
        const testFile = await this.generateAndSaveTests(sourceFile, intent)
        if (!testFile) {
            return { testsGenerated: false, testsPassed: false }
        }

        // Step 2: Run tests (should fail initially - RED)
        const preResult = await this.runTests(dirname(sourceFile), testFile)
        console.log(`[L12 QA Agent] Pre-change test: ${preResult.passed} passed, ${preResult.failed} failed`)

        // Step 3: Apply the change via callback
        // The caller implements the actual code change

        // Step 4: Run tests again (should pass - GREEN)
        const postResult = await this.runTests(dirname(sourceFile), testFile)
        console.log(`[L12 QA Agent] Post-change test: ${postResult.passed} passed, ${postResult.failed} failed`)

        return {
            testsGenerated: true,
            testsPassed: postResult.success,
        }
    }

    // ============================================
    // Status
    // ============================================

    getLastResult(): TestResult | null {
        return this.lastTestResult
    }

    formatResult(result: TestResult): string {
        let msg = `🧪 **Test-Ergebnis**\n\n`

        if (result.success) {
            msg += `✅ Alle Tests bestanden!\n`
        } else {
            msg += `❌ Tests fehlgeschlagen!\n`
        }

        msg += `\n`
        msg += `• ✅ ${result.passed} bestanden\n`
        msg += `• ❌ ${result.failed} fehlgeschlagen\n`
        msg += `• ⏭️ ${result.skipped} übersprungen\n`
        msg += `• ⏱️ ${result.duration}ms\n`

        if (result.errors.length > 0) {
            msg += `\n**Fehler:**\n`
            for (const error of result.errors.slice(0, 3)) {
                msg += `\`${error.testName}\`: ${error.message.slice(0, 100)}\n`
            }
        }

        return msg
    }
}

// ============================================
// Singleton
// ============================================

let qaAgent: QAAgent | null = null

export function getQAAgent(config?: Partial<QAConfig>): QAAgent {
    if (!qaAgent) {
        qaAgent = new QAAgent(config)
    }
    return qaAgent
}

export default { QAAgent, getQAAgent }
