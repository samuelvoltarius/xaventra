/**
 * Nova - OpenAI LLM Adapter
 * 
 * Supports GPT-4, GPT-5.4, o1, o3 models
 * Falls back to Codex CLI proxy for ChatGPT subscription models
 */

import { CodexCLIAdapter, isCodexAvailable, isCodexAuthenticated } from './codex-cli-adapter.js'

// ============================================
// Types
// ============================================

export interface Message {
    role: 'user' | 'assistant' | 'system'
    content: string
}

export interface OpenAIConfig {
    apiKey: string
    model?: string
    baseUrl?: string
}

export interface CompletionResult {
    content: string
    model: string
    tokensUsed?: number
    finishReason?: string
}

// ============================================
// OpenAI Adapter (with Codex CLI fallback)
// ============================================

export class OpenAILLM {
    private apiKey: string
    private baseUrl: string
    private currentModel: string
    private codexAdapter: CodexCLIAdapter | null = null
    private useCodexCLI: boolean = false

    constructor(config: OpenAIConfig) {
        this.apiKey = config.apiKey
        this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
        this.currentModel = config.model ?? 'auto'

        // Check if Codex CLI is available as fallback
        if (isCodexAvailable() && isCodexAuthenticated()) {
            try {
                this.codexAdapter = new CodexCLIAdapter(this.currentModel)
                console.log('[OpenAI] ✓ Codex CLI available as fallback')
            } catch (e) {
                console.log('[OpenAI] ⚠ Codex CLI found but init failed:', e)
            }
        }
    }

    setModel(model: string): void {
        this.currentModel = model
        if (this.codexAdapter) this.codexAdapter.setModel(model)
    }

    getModel(): string {
        return this.currentModel
    }

    async complete(
        messages: Message[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): Promise<CompletionResult> {
        // If already switched to Codex CLI mode, use it directly
        if (this.useCodexCLI && this.codexAdapter) {
            return this.completeViaCodex(messages, options)
        }

        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()

        const allMessages = [
            { role: 'system', content: systemPrompt },
            ...messages,
        ]

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.currentModel,
                    messages: allMessages,
                    max_tokens: options.maxTokens ?? 4096,
                    temperature: options.temperature ?? 0.7,
                }),
            })

            if (!response.ok) {
                const error = await response.text()
                const status = response.status

                // Fallback to Codex CLI for quota/auth errors
                if ((status === 429 || status === 401) && this.codexAdapter) {
                    console.log(`[OpenAI] API returned ${status}, falling back to Codex CLI proxy`)
                    this.useCodexCLI = true
                    return this.completeViaCodex(messages, options)
                }

                throw new Error(`OpenAI API error: ${error}`)
            }

            const data = await response.json() as {
                choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
                usage?: { total_tokens?: number }
            }

            return {
                content: data.choices?.[0]?.message?.content ?? '',
                model: this.currentModel,
                tokensUsed: data.usage?.total_tokens,
                finishReason: data.choices?.[0]?.finish_reason,
            }
        } catch (err) {
            // Network errors — try Codex CLI fallback
            if (this.codexAdapter && !this.useCodexCLI) {
                console.log('[OpenAI] API request failed, trying Codex CLI:', (err as Error).message?.slice(0, 100))
                this.useCodexCLI = true
                return this.completeViaCodex(messages, options)
            }
            throw err
        }
    }

    private async completeViaCodex(
        messages: Message[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): Promise<CompletionResult> {
        if (!this.codexAdapter) throw new Error('Codex CLI not available')

        // Build prompt from messages
        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()
        const userMessages = messages.filter(m => m.role === 'user')
        const lastUserMessage = userMessages[userMessages.length - 1]?.content || ''

        const result = await this.codexAdapter.complete(lastUserMessage, {
            systemPrompt,
            model: this.currentModel,
            timeoutMs: 60000,
        })

        return {
            content: result.content,
            model: result.model,
            tokensUsed: result.tokensUsed,
            finishReason: 'stop',
        }
    }

    async *stream(
        messages: Message[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): AsyncGenerator<string, void, unknown> {
        // If Codex CLI mode is active, use it for streaming
        if (this.useCodexCLI && this.codexAdapter) {
            yield* this.streamViaCodex(messages, options)
            return
        }

        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()

        const allMessages = [
            { role: 'system', content: systemPrompt },
            ...messages,
        ]

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.currentModel,
                    messages: allMessages,
                    max_tokens: options.maxTokens ?? 4096,
                    temperature: options.temperature ?? 0.7,
                    stream: true,
                }),
            })

            if (!response.ok) {
                // Fallback to Codex CLI
                if ((response.status === 429 || response.status === 401) && this.codexAdapter) {
                    console.log(`[OpenAI] Stream API returned ${response.status}, falling back to Codex CLI`)
                    this.useCodexCLI = true
                    yield* this.streamViaCodex(messages, options)
                    return
                }
                throw new Error(`OpenAI streaming error: ${response.status}`)
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
                        const json = line.slice(6)
                        if (json === '[DONE]') return

                        try {
                            const data = JSON.parse(json)
                            const text = data.choices?.[0]?.delta?.content
                            if (text) yield text
                        } catch {
                            // Skip
                        }
                    }
                }
            }
        } catch (err) {
            // Network errors — try Codex CLI fallback
            if (this.codexAdapter && !this.useCodexCLI) {
                console.log('[OpenAI] Stream failed, trying Codex CLI:', (err as Error).message?.slice(0, 100))
                this.useCodexCLI = true
                yield* this.streamViaCodex(messages, options)
                return
            }
            throw err
        }
    }

    private async *streamViaCodex(
        messages: Message[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): AsyncGenerator<string, void, unknown> {
        if (!this.codexAdapter) throw new Error('Codex CLI not available')

        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()
        const userMessages = messages.filter(m => m.role === 'user')
        const lastUserMessage = userMessages[userMessages.length - 1]?.content || ''

        yield* this.codexAdapter.stream(lastUserMessage, {
            systemPrompt,
            model: this.currentModel,
            timeoutMs: 60000,
        })
    }

    private buildDefaultSystemPrompt(): string {
        return `Du bist Nova ✨ - ein selbstlernender KI-Assistent.
Du antwortest auf Deutsch, präzise und freundlich.`
    }
}

// ============================================
// Factory
// ============================================

export function createOpenAILLM(config: OpenAIConfig): OpenAILLM {
    return new OpenAILLM(config)
}

export default { OpenAILLM, createOpenAILLM }

