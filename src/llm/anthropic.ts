/**
 * Nova - Anthropic (Claude) LLM Adapter
 * 
 * Supports Claude 3.5, 4, Opus, Sonnet models
 */

// ============================================
// Types
// ============================================

export interface Message {
    role: 'user' | 'assistant'
    content: string
}

export interface AnthropicConfig {
    apiKey: string
    model?: string
}

export interface CompletionResult {
    content: string
    model: string
    tokensUsed?: number
    stopReason?: string
}

// ============================================
// Model Constants
// ============================================

const ANTHROPIC_API = 'https://api.anthropic.com/v1'
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

// ============================================
// Anthropic Adapter
// ============================================

export class AnthropicLLM {
    private apiKey: string
    private currentModel: string

    constructor(config: AnthropicConfig) {
        this.apiKey = config.apiKey
        this.currentModel = config.model ?? DEFAULT_MODEL
    }

    setModel(model: string): void {
        this.currentModel = model
    }

    getModel(): string {
        return this.currentModel
    }

    async complete(
        messages: Message[],
        options: { maxTokens?: number; systemPrompt?: string } = {}
    ): Promise<CompletionResult> {
        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()

        const response = await fetch(`${ANTHROPIC_API}/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.currentModel,
                max_tokens: options.maxTokens ?? 4096,
                system: systemPrompt,
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                })),
            }),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`Anthropic API error: ${error}`)
        }

        const data = await response.json() as {
            content?: Array<{ type: string; text?: string }>
            usage?: { input_tokens?: number; output_tokens?: number }
            stop_reason?: string
        }

        const textContent = data.content?.find(c => c.type === 'text')

        return {
            content: textContent?.text ?? '',
            model: this.currentModel,
            tokensUsed: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
            stopReason: data.stop_reason,
        }
    }

    async *stream(
        messages: Message[],
        options: { maxTokens?: number; systemPrompt?: string } = {}
    ): AsyncGenerator<string, void, unknown> {
        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()

        const response = await fetch(`${ANTHROPIC_API}/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.currentModel,
                max_tokens: options.maxTokens ?? 4096,
                system: systemPrompt,
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                })),
                stream: true,
            }),
        })

        if (!response.ok) {
            throw new Error(`Anthropic streaming error: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6))
                        if (data.type === 'content_block_delta' && data.delta?.text) {
                            yield data.delta.text
                        }
                    } catch {
                        // Skip
                    }
                }
            }
        }
    }

    private buildDefaultSystemPrompt(): string {
        return `Du bist Nova ✨ - ein selbstlernender KI-Assistent.
Du antwortest auf Deutsch, präzise und freundlich.`
    }
}

// ============================================
// Factory
// ============================================

export function createAnthropicLLM(config: AnthropicConfig): AnthropicLLM {
    return new AnthropicLLM(config)
}

export default { AnthropicLLM, createAnthropicLLM }
