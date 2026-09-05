/**
 * Nova - Skill Generator
 * 
 * LLM-based code generation for new tools/skills
 */

// ============================================
// Types
// ============================================

export interface SkillSpec {
    name: string
    description: string
    inputSchema?: Record<string, { type: string; description: string; required?: boolean }>
    examples?: Array<{ input: string; output: string }>
}

export interface GeneratedSkill {
    name: string
    code: string
    testCode: string
    metadata: {
        generatedAt: number
        prompt: string
        model?: string
    }
}

// ============================================
// Prompts
// ============================================

const SKILL_GENERATION_PROMPT = `Du bist ein erfahrener TypeScript-Entwickler. Generiere eine Nova-Skill-Funktion.

REGELN:
- Verwende TypeScript
- Keine Semicolons, Single Quotes
- Die Funktion muss async sein
- Gebe ein Objekt mit { success: boolean, result: any } zurück
- Keine externen Dependencies
- Keine Dateisystem-Operationen
- Keine Netzwerk-Calls

FORMAT:
\`\`\`typescript
export async function skillName(input: InputType): Promise<{ success: boolean; result: any }> {
    // Implementation
    return { success: true, result: ... }
}
\`\`\`
`

const TEST_GENERATION_PROMPT = `Generiere einfache Tests für die folgende Skill-Funktion.

REGELN:
- Verwende die assert() Funktion (wird bereitgestellt)
- Teste Happy Path und Edge Cases
- Mindestens 3 Tests

FORMAT:
\`\`\`typescript
assert(condition, 'Beschreibung des Tests')
\`\`\`
`

// ============================================
// Generator Class
// ============================================

export class SkillGenerator {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private llm: any = null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setLLM(llm: any): void {
        this.llm = llm
    }

    // ============================================
    // Generate Skill
    // ============================================

    async generate(spec: SkillSpec): Promise<GeneratedSkill> {
        if (!this.llm) {
            throw new Error('LLM not configured')
        }

        const prompt = this.buildSkillPrompt(spec)

        // Generate skill code
        const codeResponse = await this.llm.complete([
            { role: 'system', content: SKILL_GENERATION_PROMPT },
            { role: 'user', content: prompt }
        ])

        const code = this.extractCode(codeResponse.content)

        // Generate test code
        const testResponse = await this.llm.complete([
            { role: 'system', content: TEST_GENERATION_PROMPT },
            { role: 'user', content: `Skill-Code:\n${code}\n\nGeneriere Tests.` }
        ])

        const testCode = this.extractCode(testResponse.content)

        return {
            name: spec.name,
            code,
            testCode,
            metadata: {
                generatedAt: Date.now(),
                prompt,
            }
        }
    }

    // ============================================
    // Build Prompt
    // ============================================

    private buildSkillPrompt(spec: SkillSpec): string {
        let prompt = `Erstelle eine Skill-Funktion mit folgenden Eigenschaften:\n\n`
        prompt += `Name: ${spec.name}\n`
        prompt += `Beschreibung: ${spec.description}\n`

        if (spec.inputSchema) {
            prompt += `\nInput-Schema:\n`
            for (const [key, value] of Object.entries(spec.inputSchema)) {
                prompt += `  - ${key}: ${value.type} - ${value.description}${value.required ? ' (required)' : ''}\n`
            }
        }

        if (spec.examples && spec.examples.length > 0) {
            prompt += `\nBeispiele:\n`
            for (const example of spec.examples) {
                prompt += `  Input: ${example.input}\n`
                prompt += `  Output: ${example.output}\n\n`
            }
        }

        return prompt
    }

    // ============================================
    // Extract Code
    // ============================================

    private extractCode(response: string): string {
        // Extract code from markdown code blocks
        const codeBlockMatch = response.match(/```(?:typescript|ts|javascript|js)?\s*([\s\S]*?)```/)
        if (codeBlockMatch) {
            return codeBlockMatch[1].trim()
        }

        // Fallback: return as-is
        return response.trim()
    }

    // ============================================
    // Generate from Description
    // ============================================

    async generateFromDescription(description: string): Promise<GeneratedSkill> {
        // Parse description to extract name
        const nameMatch = description.match(/(?:create|make|build|generate)\s+(?:a\s+)?(?:tool|skill|function)\s+(?:for\s+)?(\w+)/i)
        const name = nameMatch ? nameMatch[1] : `skill_${Date.now().toString(36)}`

        const spec: SkillSpec = {
            name: this.sanitizeName(name),
            description,
        }

        return this.generate(spec)
    }

    private sanitizeName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
    }
}

// ============================================
// Singleton
// ============================================

let globalGenerator: SkillGenerator | null = null

export function getSkillGenerator(): SkillGenerator {
    if (!globalGenerator) {
        globalGenerator = new SkillGenerator()
    }
    return globalGenerator
}
