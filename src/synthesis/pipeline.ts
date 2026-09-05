/**
 * Nova - Skill Synthesis Pipeline
 * 
 * Complete pipeline: Generate → Validate → Test → Promote
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillSpec, GeneratedSkill, getSkillGenerator } from './generator.js'
import { validateSkillCode, runSkillTests } from './sandbox.js'

// ============================================
// Types
// ============================================

export type PipelineStage = 'generate' | 'validate' | 'test' | 'promote' | 'complete' | 'failed'

export interface PipelineResult {
    success: boolean
    stage: PipelineStage
    skill?: GeneratedSkill
    validationErrors?: string[]
    testResults?: unknown
    error?: string
}

export interface SynthesizedSkill {
    id: string
    name: string
    code: string
    path: string
    synthesizedAt: number
    fromDescription: string
}

// ============================================
// Directories
// ============================================

const SKILLS_DIR = join(process.cwd(), '.nova-skills')
const PENDING_DIR = join(SKILLS_DIR, 'pending')
const APPROVED_DIR = join(SKILLS_DIR, 'approved')

function ensureDirectories(): void {
    for (const dir of [SKILLS_DIR, PENDING_DIR, APPROVED_DIR]) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }
    }
}

// ============================================
// Pipeline Class
// ============================================

export class SynthesisPipeline {
    private results: Map<string, PipelineResult> = new Map()
    private synthesizedSkills: SynthesizedSkill[] = []

    // ============================================
    // Full Pipeline
    // ============================================

    async run(spec: SkillSpec | string): Promise<PipelineResult> {
        ensureDirectories()

        const generator = getSkillGenerator()
        let currentStage: PipelineStage = 'generate'
        let skill: GeneratedSkill | undefined

        try {
            // Stage 1: Generate
            console.log(`[Synthesis] Stage 1: Generating skill...`)
            currentStage = 'generate'

            if (typeof spec === 'string') {
                skill = await generator.generateFromDescription(spec)
            } else {
                skill = await generator.generate(spec)
            }

            console.log(`[Synthesis] Generated: ${skill.name}`)

            // Stage 2: Validate
            console.log(`[Synthesis] Stage 2: Validating...`)
            currentStage = 'validate'

            const validation = validateSkillCode(skill.code)
            if (!validation.valid) {
                return {
                    success: false,
                    stage: 'validate',
                    skill,
                    validationErrors: validation.errors,
                    error: 'Validation failed: ' + validation.errors.join(', '),
                }
            }

            console.log(`[Synthesis] Validation passed`)

            // Stage 3: Test
            console.log(`[Synthesis] Stage 3: Running tests...`)
            currentStage = 'test'

            const testResult = await runSkillTests(skill.code, skill.testCode, { timeout: 30000 })
            if (!testResult.passed) {
                return {
                    success: false,
                    stage: 'test',
                    skill,
                    testResults: testResult.results,
                    error: testResult.error || 'Tests failed',
                }
            }

            console.log(`[Synthesis] Tests passed`)

            // Stage 4: Promote
            console.log(`[Synthesis] Stage 4: Promoting...`)
            currentStage = 'promote'

            const promoted = await this.promoteSkill(skill, typeof spec === 'string' ? spec : spec.description)

            console.log(`[Synthesis] Skill promoted: ${promoted.path}`)

            return {
                success: true,
                stage: 'complete',
                skill,
                testResults: testResult.results,
            }

        } catch (err) {
            return {
                success: false,
                stage: currentStage,
                skill,
                error: String(err),
            }
        }
    }

    // ============================================
    // Promote Skill
    // ============================================

    private async promoteSkill(skill: GeneratedSkill, description: string): Promise<SynthesizedSkill> {
        const id = `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const filename = `${skill.name}.ts`
        const path = join(APPROVED_DIR, filename)

        // Write skill file
        const fileContent = `/**
 * Nova Synthesized Skill: ${skill.name}
 * Generated: ${new Date().toISOString()}
 * Description: ${description}
 */

${skill.code}
`
        writeFileSync(path, fileContent)

        // Write test file
        const testPath = join(APPROVED_DIR, `${skill.name}.test.ts`)
        writeFileSync(testPath, skill.testCode)

        // Record synthesized skill
        const synthesized: SynthesizedSkill = {
            id,
            name: skill.name,
            code: skill.code,
            path,
            synthesizedAt: Date.now(),
            fromDescription: description,
        }

        this.synthesizedSkills.push(synthesized)
        this.saveRegistry()

        return synthesized
    }

    // ============================================
    // Registry Management
    // ============================================

    private saveRegistry(): void {
        const registryPath = join(SKILLS_DIR, 'registry.json')
        writeFileSync(registryPath, JSON.stringify(this.synthesizedSkills, null, 2))
    }

    loadRegistry(): void {
        const registryPath = join(SKILLS_DIR, 'registry.json')
        if (existsSync(registryPath)) {
            try {
                this.synthesizedSkills = JSON.parse(readFileSync(registryPath, 'utf-8'))
            } catch {
                this.synthesizedSkills = []
            }
        }
    }

    getSynthesizedSkills(): SynthesizedSkill[] {
        return [...this.synthesizedSkills]
    }

    // ============================================
    // Status
    // ============================================

    getResult(skillName: string): PipelineResult | undefined {
        return this.results.get(skillName)
    }
}

// ============================================
// Singleton
// ============================================

let globalPipeline: SynthesisPipeline | null = null

export function getSynthesisPipeline(): SynthesisPipeline {
    if (!globalPipeline) {
        globalPipeline = new SynthesisPipeline()
        globalPipeline.loadRegistry()
    }
    return globalPipeline
}
