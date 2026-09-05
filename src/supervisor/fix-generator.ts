/**
 * Fix Generator for Supervisor
 * 
 * Uses LLM (OpenAI or Ollama) to generate code fixes for detected errors.
 * Returns structured fix proposals that can be applied and tested.
 */

import { PatternMatch, ErrorPattern } from './pattern-matcher.js'
import { LogEntry } from '../logging/structured-logger.js'

// ============================================
// Types
// ============================================

export interface FixProposal {
    id: string
    patternMatch: PatternMatch
    timestamp: Date
    // The proposed fix
    description: string
    changes: FileChange[]
    commands?: string[]  // Shell commands to run (e.g., npm install)
    // Confidence and metadata
    confidence: number  // 0-1
    reasoning: string
    provider: 'openai' | 'ollama' | 'manual'
    // Status tracking
    status: 'proposed' | 'testing' | 'applied' | 'failed' | 'rejected'
    testResult?: {
        success: boolean
        output?: string
        buildOutput?: string
        testOutput?: string
        errors?: string[]
        error?: string
    }
}

export interface FileChange {
    filePath: string
    action: 'modify' | 'create' | 'delete'
    // For modify/create
    oldContent?: string
    newContent?: string
    // For targeted changes
    searchReplace?: {
        search: string
        replace: string
    }
}

export interface GeneratorConfig {
    provider: 'openai' | 'ollama'
    maxRetries: number
    // OpenAI config
    openaiApiKey?: string
    openaiModel?: string
    // Ollama config
    ollamaUrl?: string
    ollamaModel?: string
}

// ============================================
// Fix Generator
// ============================================

export class FixGenerator {
    private config: GeneratorConfig
    private proposals: Map<string, FixProposal> = new Map()

    constructor(config: Partial<GeneratorConfig> = {}) {
        this.config = {
            provider: config.provider || 'openai',
            maxRetries: config.maxRetries || 3,
            openaiApiKey: config.openaiApiKey,
            openaiModel: config.openaiModel || 'auto', // resolved dynamically
            ollamaUrl: config.ollamaUrl || 'http://localhost:11434',
            ollamaModel: config.ollamaModel || 'auto', // resolved dynamically
        }

        // Resolve models dynamically
        import('../core/model-resolver.js').then(async ({ resolveModelId }) => {
            if (this.config.openaiModel === 'auto') {
                this.config.openaiModel = await resolveModelId('chat')
            }
            if (this.config.ollamaModel === 'auto') {
                this.config.ollamaModel = await resolveModelId('small')
            }
            console.log(`[FixGenerator] Models resolved: openai=${this.config.openaiModel}, ollama=${this.config.ollamaModel}`)
        }).catch(() => { })

        console.log(`[FixGenerator] Initialized with provider: ${this.config.provider}`)
    }

    /**
     * Generate a fix proposal for a pattern match
     */
    async generateFix(match: PatternMatch): Promise<FixProposal | null> {
        console.log(`[FixGenerator] Generating fix for: ${match.pattern.name}`)

        const prompt = this.buildPrompt(match)

        try {
            const response = await this.callLLM(prompt)
            const proposal = this.parseResponse(response, match)

            if (proposal) {
                this.proposals.set(proposal.id, proposal)
                console.log(`[FixGenerator] ✅ Generated proposal: ${proposal.description.slice(0, 50)}...`)
            }

            return proposal
        } catch (err) {
            console.error(`[FixGenerator] ❌ Failed to generate fix:`, err)
            return null
        }
    }

    /**
     * Build the LLM prompt for fix generation
     */
    private buildPrompt(match: PatternMatch): string {
        const contextLogs = match.context
            .map(e => `[${e.level}] [${e.layer}] ${e.message}`)
            .join('\n')

        return `You are a code repair specialist. Analyze this error and propose a fix.

## Error Pattern
- **Name**: ${match.pattern.name}
- **Description**: ${match.pattern.description}
- **Severity**: ${match.pattern.severity}
- **Fix Hint**: ${match.pattern.fixHint || 'None provided'}

## Error Log Entry
- **Layer**: ${match.entry.layer}
- **Message**: ${match.entry.message}
- **Error Details**: ${match.entry.error?.message || 'N/A'}
- **Stack Trace**: ${match.entry.error?.stack?.split('\n').slice(0, 5).join('\n') || 'N/A'}
- **Metadata**: ${JSON.stringify(match.entry.metadata || {}, null, 2)}

## Context (Recent Logs)
${contextLogs || 'No context available'}

## Instructions
Propose a fix for this error. Respond in this exact JSON format:

\`\`\`json
{
  "description": "Brief description of the fix",
  "reasoning": "Why this fix should work",
  "confidence": 0.8,
  "changes": [
    {
      "filePath": "path/to/file.ts",
      "action": "modify",
      "searchReplace": {
        "search": "old code to find",
        "replace": "new code to insert"
      }
    }
  ],
  "commands": ["npm install some-package"]
}
\`\`\`

Rules:
1. Be specific about file paths and code changes
2. Keep changes minimal and surgical
3. If unsure, set confidence low
4. Commands should be safe (no destructive operations)
5. If the error can't be auto-fixed, set confidence to 0
`
    }

    /**
     * Call the configured LLM provider
     */
    private async callLLM(prompt: string): Promise<string> {
        if (this.config.provider === 'ollama') {
            return this.callOllama(prompt)
        }
        return this.callOpenAI(prompt)
    }

    /**
     * Call OpenAI API
     */
    private async callOpenAI(prompt: string): Promise<string> {
        try {
            const apiKey = process.env.OPENAI_API_KEY
            if (!apiKey) {
                throw new Error('No OpenAI API key configured')
            }

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: this.config.openaiModel || 'auto',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 2000,
                    temperature: 0.2,
                }),
            })

            if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`)
            const data = await response.json() as any
            const text = data.choices?.[0]?.message?.content
            if (!text) throw new Error('Invalid OpenAI response')
            return text
        } catch (err) {
            console.error('[FixGenerator] OpenAI call failed:', err)
            throw err
        }
    }

    /**
     * Call Ollama API (Phase 2)
     */
    private async callOllama(prompt: string): Promise<string> {
        try {
            const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.config.ollamaModel,
                    prompt,
                    stream: false,
                    options: {
                        temperature: 0.3,
                    },
                }),
            })

            const data = await response.json() as any
            return data.response || ''
        } catch (err) {
            console.error('[FixGenerator] Ollama call failed:', err)
            throw err
        }
    }

    /**
     * Parse LLM response into a FixProposal
     */
    private parseResponse(response: string, match: PatternMatch): FixProposal | null {
        try {
            // Extract JSON from response
            const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
            if (!jsonMatch) {
                console.warn('[FixGenerator] No JSON block found in response')
                return null
            }

            const parsed = JSON.parse(jsonMatch[1])

            // Validate required fields
            if (!parsed.description || !parsed.changes || parsed.confidence === undefined) {
                console.warn('[FixGenerator] Invalid fix proposal structure')
                return null
            }

            const proposal: FixProposal = {
                id: `fix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                patternMatch: match,
                timestamp: new Date(),
                description: parsed.description,
                changes: parsed.changes,
                commands: parsed.commands || [],
                confidence: parsed.confidence,
                reasoning: parsed.reasoning || '',
                provider: this.config.provider,
                status: 'proposed',
            }

            return proposal
        } catch (err) {
            console.error('[FixGenerator] Failed to parse response:', err)
            return null
        }
    }

    // ============================================
    // Query API
    // ============================================

    /**
     * Get all proposals
     */
    getProposals(): FixProposal[] {
        return Array.from(this.proposals.values())
    }

    /**
     * Get proposal by ID
     */
    getProposal(id: string): FixProposal | undefined {
        return this.proposals.get(id)
    }

    /**
     * Update proposal status
     */
    updateProposalStatus(
        id: string,
        status: FixProposal['status'],
        testResult?: FixProposal['testResult']
    ): void {
        const proposal = this.proposals.get(id)
        if (proposal) {
            proposal.status = status
            if (testResult) proposal.testResult = testResult
        }
    }

    /**
     * Get pending proposals (not yet tested)
     */
    getPendingProposals(): FixProposal[] {
        return this.getProposals().filter(p => p.status === 'proposed')
    }

    /**
     * Get successful fixes
     */
    getSuccessfulFixes(): FixProposal[] {
        return this.getProposals().filter(p => p.status === 'applied')
    }
}

// ============================================
// Singleton
// ============================================

let generator: FixGenerator | null = null

export function getFixGenerator(config?: Partial<GeneratorConfig>): FixGenerator {
    if (!generator) {
        generator = new FixGenerator(config)
    }
    return generator
}

export default { FixGenerator, getFixGenerator }
