/**
 * Auto-Tester for Supervisor
 * 
 * Tests proposed fixes by:
 * 1. Creating a temp branch
 * 2. Applying the fix
 * 3. Running build & tests
 * 4. Reporting results
 */

import { execSync, exec } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FixProposal, FileChange } from './fix-generator.js'

// ============================================
// Types
// ============================================

export interface TestResult {
    success: boolean
    buildOutput: string
    testOutput?: string
    errors: string[]
    duration: number
}

export interface TesterConfig {
    workDir: string
    buildCommand: string
    testCommand?: string
    timeout: number  // ms
    autoCommit: boolean
}

// ============================================
// Auto-Tester
// ============================================

export class AutoTester {
    private config: TesterConfig
    private tempBranch: string = ''

    constructor(config: Partial<TesterConfig> = {}) {
        this.config = {
            workDir: config.workDir || process.cwd(),
            buildCommand: config.buildCommand || 'npm run build',
            testCommand: config.testCommand,
            timeout: config.timeout || 60000,  // 60s default
            autoCommit: config.autoCommit ?? false,
        }
        console.log(`[AutoTester] Initialized in: ${this.config.workDir}`)
    }

    /**
     * Test a fix proposal
     */
    async testFix(proposal: FixProposal): Promise<TestResult> {
        const startTime = Date.now()
        const errors: string[] = []
        let buildOutput = ''
        let testOutput = ''

        console.log(`[AutoTester] Testing fix: ${proposal.description.slice(0, 50)}...`)

        try {
            // 1. Create temp branch
            this.tempBranch = `fix/${proposal.patternMatch.pattern.id}-${Date.now()}`
            this.createBranch()

            // 2. Apply changes
            for (const change of proposal.changes) {
                try {
                    this.applyChange(change)
                } catch (err) {
                    errors.push(`Failed to apply change to ${change.filePath}: ${err}`)
                }
            }

            // 3. Run commands (if any)
            if (proposal.commands?.length) {
                for (const cmd of proposal.commands) {
                    try {
                        console.log(`[AutoTester] Running: ${cmd}`)
                        execSync(cmd, {
                            cwd: this.config.workDir,
                            timeout: this.config.timeout,
                            stdio: 'pipe',
                        })
                    } catch (err) {
                        errors.push(`Command failed: ${cmd} - ${err}`)
                    }
                }
            }

            // 4. Run build
            try {
                console.log(`[AutoTester] Building: ${this.config.buildCommand}`)
                buildOutput = execSync(this.config.buildCommand, {
                    cwd: this.config.workDir,
                    timeout: this.config.timeout,
                    stdio: 'pipe',
                }).toString()
            } catch (err: any) {
                buildOutput = err.stdout?.toString() || err.message
                errors.push(`Build failed: ${buildOutput.slice(0, 500)}`)
            }

            // 5. Run tests (if configured)
            if (this.config.testCommand && errors.length === 0) {
                try {
                    console.log(`[AutoTester] Testing: ${this.config.testCommand}`)
                    testOutput = execSync(this.config.testCommand, {
                        cwd: this.config.workDir,
                        timeout: this.config.timeout,
                        stdio: 'pipe',
                    }).toString()
                } catch (err: any) {
                    testOutput = err.stdout?.toString() || err.message
                    errors.push(`Tests failed: ${testOutput.slice(0, 500)}`)
                }
            }

            const success = errors.length === 0

            // 6. Handle result
            if (success && this.config.autoCommit) {
                this.commitAndMerge(proposal)
            } else {
                // Cleanup - revert to original branch
                this.revertChanges()
            }

            const result: TestResult = {
                success,
                buildOutput,
                testOutput,
                errors,
                duration: Date.now() - startTime,
            }

            console.log(`[AutoTester] ${success ? '✅ Success' : '❌ Failed'} in ${result.duration}ms`)
            return result

        } catch (err) {
            console.error(`[AutoTester] Unexpected error:`, err)
            this.revertChanges()
            return {
                success: false,
                buildOutput: '',
                errors: [`Unexpected error: ${err}`],
                duration: Date.now() - startTime,
            }
        }
    }

    /**
     * Create a temporary git branch
     */
    private createBranch(): void {
        try {
            // Stash any changes
            execSync('git stash', { cwd: this.config.workDir, stdio: 'pipe' })
            // Create and checkout new branch
            execSync(`git checkout -b ${this.tempBranch}`, { cwd: this.config.workDir, stdio: 'pipe' })
            console.log(`[AutoTester] Created branch: ${this.tempBranch}`)
        } catch (err) {
            console.warn(`[AutoTester] Could not create branch (git may not be available)`)
        }
    }

    /**
     * Apply a file change
     */
    private applyChange(change: FileChange): void {
        const fullPath = join(this.config.workDir, change.filePath)

        if (change.action === 'delete') {
            // We don't auto-delete files for safety
            console.warn(`[AutoTester] Skip delete: ${change.filePath} (not allowed)`)
            return
        }

        if (change.action === 'create') {
            if (change.newContent) {
                writeFileSync(fullPath, change.newContent)
                console.log(`[AutoTester] Created: ${change.filePath}`)
            }
            return
        }

        if (change.action === 'modify') {
            if (!existsSync(fullPath)) {
                throw new Error(`File not found: ${change.filePath}`)
            }

            let content = readFileSync(fullPath, 'utf-8')

            if (change.searchReplace) {
                const { search, replace } = change.searchReplace
                if (!content.includes(search)) {
                    throw new Error(`Search string not found in ${change.filePath}`)
                }
                content = content.replace(search, replace)
            } else if (change.newContent) {
                content = change.newContent
            }

            writeFileSync(fullPath, content)
            console.log(`[AutoTester] Modified: ${change.filePath}`)
        }
    }

    /**
     * Revert changes and return to master
     */
    private revertChanges(): void {
        try {
            execSync('git checkout master', { cwd: this.config.workDir, stdio: 'pipe' })
            if (this.tempBranch) {
                execSync(`git branch -D ${this.tempBranch}`, { cwd: this.config.workDir, stdio: 'pipe' })
            }
            execSync('git stash pop', { cwd: this.config.workDir, stdio: 'pipe' })
            console.log(`[AutoTester] Reverted to master`)
        } catch (err) {
            // Ignore errors during cleanup
        }
    }

    /**
     * Commit fix and merge to master
     */
    private commitAndMerge(proposal: FixProposal): void {
        try {
            const message = `fix: ${proposal.description} (auto-fix by Supervisor)`
            execSync('git add -A', { cwd: this.config.workDir, stdio: 'pipe' })
            execSync(`git commit -m "${message}"`, { cwd: this.config.workDir, stdio: 'pipe' })
            execSync('git checkout master', { cwd: this.config.workDir, stdio: 'pipe' })
            execSync(`git merge ${this.tempBranch}`, { cwd: this.config.workDir, stdio: 'pipe' })
            execSync(`git branch -d ${this.tempBranch}`, { cwd: this.config.workDir, stdio: 'pipe' })
            execSync('git stash pop', { cwd: this.config.workDir, stdio: 'pipe' })
            console.log(`[AutoTester] ✅ Merged fix to master: ${message}`)
        } catch (err) {
            console.error(`[AutoTester] Failed to commit/merge:`, err)
            this.revertChanges()
        }
    }

    /**
     * Quick validation without git branching (faster for simple checks)
     */
    async quickCheck(): Promise<boolean> {
        try {
            execSync(this.config.buildCommand, {
                cwd: this.config.workDir,
                timeout: this.config.timeout,
                stdio: 'pipe',
            })
            return true
        } catch {
            return false
        }
    }
}

// ============================================
// Singleton
// ============================================

let tester: AutoTester | null = null

export function getAutoTester(config?: Partial<TesterConfig>): AutoTester {
    if (!tester) {
        tester = new AutoTester(config)
    }
    return tester
}

export default { AutoTester, getAutoTester }
