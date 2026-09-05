/**
 * Nova - Ollama / Custom LLM Adapter
 * 
 * Supports:
 * - Ollama (local LLM)
 * - Any OpenAI-compatible API
 * - Custom endpoints
 */

// ============================================
// Types
// ============================================

export interface CustomLLMConfig {
    baseUrl: string           // e.g. http://localhost:11434 for Ollama
    model: string             // e.g. llama3, mistral, codellama
    apiKey?: string           // Optional for authenticated APIs
    type?: 'ollama' | 'openai-compatible' | 'custom'
    headers?: Record<string, string>
}

export interface CompletionResult {
    content: string
    model: string
    tokensUsed?: number
    finishReason?: string
}

export interface Message {
    role: 'user' | 'assistant' | 'system'
    content: string
}

// ============================================
// Ollama-specific types
// ============================================

// OllamaChatResponse type used for chat completions

interface OllamaChatResponse {
    message: { role: string; content: string }
    done: boolean
    model?: string
    eval_count?: number
}

// ============================================
// Custom LLM Class
// ============================================

export class CustomLLM {
    private config: CustomLLMConfig

    constructor(config: CustomLLMConfig) {
        this.config = {
            type: 'ollama',
            ...config,
        }
    }

    setModel(model: string): void {
        this.config.model = model
    }

    getModel(): string {
        return this.config.model
    }

    getBaseUrl(): string {
        return this.config.baseUrl
    }

    // ============================================
    // Chat Completion
    // ============================================

    async complete(
        messages: Message[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): Promise<CompletionResult> {
        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()

        if (this.config.type === 'ollama') {
            return this.completeOllama(messages, systemPrompt, options)
        } else {
            return this.completeOpenAICompatible(messages, systemPrompt, options)
        }
    }

    // ============================================
    // Ollama Implementation
    // ============================================

    private async completeOllama(
        messages: Message[],
        systemPrompt: string,
        options: { maxTokens?: number; temperature?: number }
    ): Promise<CompletionResult> {
        const ollamaMessages = [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content })),
        ]

        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.config.headers,
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: ollamaMessages,
                stream: false,
                // Qwen 3.x may otherwise spend the complete token/time budget
                // in a separate thinking field and return empty message content.
                // Nova's service clients require an actionable final answer.
                think: false,
                options: {
                    num_predict: options.maxTokens ?? 4096,
                    temperature: options.temperature ?? 0.7,
                },
            }),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`Ollama error: ${error}`)
        }

        const data = await response.json() as OllamaChatResponse

        return {
            content: data.message?.content ?? '',
            model: data.model ?? this.config.model,
            tokensUsed: data.eval_count,
        }
    }

    // ============================================
    // OpenAI-Compatible Implementation
    // ============================================

    private async completeOpenAICompatible(
        messages: Message[],
        systemPrompt: string,
        options: { maxTokens?: number; temperature?: number }
    ): Promise<CompletionResult> {
        const allMessages = [
            { role: 'system', content: systemPrompt },
            ...messages,
        ]

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.config.headers,
        }

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`
        }

        const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.config.model,
                messages: allMessages,
                max_tokens: options.maxTokens ?? 4096,
                temperature: options.temperature ?? 0.7,
            }),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`API error: ${error}`)
        }

        const data = await response.json() as {
            choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
            usage?: { total_tokens?: number }
        }

        return {
            content: data.choices?.[0]?.message?.content ?? '',
            model: this.config.model,
            tokensUsed: data.usage?.total_tokens,
            finishReason: data.choices?.[0]?.finish_reason,
        }
    }

    // ============================================
    // Streaming
    // ============================================

    async *stream(
        messages: Message[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): AsyncGenerator<string, void, unknown> {
        const systemPrompt = options.systemPrompt ?? this.buildDefaultSystemPrompt()

        if (this.config.type === 'ollama') {
            yield* this.streamOllama(messages, systemPrompt, options)
        } else {
            yield* this.streamOpenAICompatible(messages, systemPrompt, options)
        }
    }

    private async *streamOllama(
        messages: Message[],
        systemPrompt: string,
        options: { maxTokens?: number; temperature?: number }
    ): AsyncGenerator<string, void, unknown> {
        const ollamaMessages = [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content })),
        ]

        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.config.headers,
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: ollamaMessages,
                stream: true,
                options: {
                    num_predict: options.maxTokens ?? 4096,
                    temperature: options.temperature ?? 0.7,
                },
            }),
        })

        if (!response.ok) {
            throw new Error(`Ollama streaming error: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })
            const lines = chunk.split('\n').filter(l => l.trim())

            for (const line of lines) {
                try {
                    const data = JSON.parse(line) as OllamaChatResponse
                    if (data.message?.content) {
                        yield data.message.content
                    }
                } catch {
                    // Skip
                }
            }
        }
    }

    private async *streamOpenAICompatible(
        messages: Message[],
        systemPrompt: string,
        options: { maxTokens?: number; temperature?: number }
    ): AsyncGenerator<string, void, unknown> {
        const allMessages = [
            { role: 'system', content: systemPrompt },
            ...messages,
        ]

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.config.headers,
        }

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`
        }

        const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.config.model,
                messages: allMessages,
                max_tokens: options.maxTokens ?? 4096,
                temperature: options.temperature ?? 0.7,
                stream: true,
            }),
        })

        if (!response.ok) {
            throw new Error(`Streaming error: ${response.status}`)
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
    }

    // ============================================
    // Helpers
    // ============================================

    private buildDefaultSystemPrompt(): string {
        return `Du bist Nova ✨ - ein selbstlernender KI-Assistent.
Du antwortest auf Deutsch, präzise und freundlich.`
    }

    // ============================================
    // List Available Models (Ollama)
    // ============================================

    async listModels(): Promise<string[]> {
        if (this.config.type !== 'ollama') {
            return [this.config.model]
        }

        try {
            const response = await fetch(`${this.config.baseUrl}/api/tags`)
            if (!response.ok) return []

            const data = await response.json() as { models?: Array<{ name: string }> }
            return data.models?.map(m => m.name) ?? []
        } catch {
            return []
        }
    }

    // ============================================
    // Health Check
    // ============================================

    async healthCheck(): Promise<{ ok: boolean; error?: string; models?: string[] }> {
        try {
            if (this.config.type === 'ollama') {
                const response = await fetch(`${this.config.baseUrl}/api/tags`)
                if (!response.ok) {
                    return { ok: false, error: `HTTP ${response.status}` }
                }
                const models = await this.listModels()
                return { ok: true, models }
            } else {
                // For OpenAI-compatible, just check if endpoint responds
                const headers: Record<string, string> = { 'Content-Type': 'application/json' }
                if (this.config.apiKey) {
                    headers['Authorization'] = `Bearer ${this.config.apiKey}`
                }

                const response = await fetch(`${this.config.baseUrl}/v1/models`, { headers })
                return { ok: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` }
            }
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
    }
}

// ============================================
// Factory Functions
// ============================================

export function createOllamaLLM(baseUrl = 'http://localhost:11434', model = 'llama3'): CustomLLM {
    return new CustomLLM({
        baseUrl,
        model,
        type: 'ollama',
    })
}

export function createCustomLLM(config: CustomLLMConfig): CustomLLM {
    return new CustomLLM(config)
}

// ============================================
// Preset Configurations
// ============================================

export const OLLAMA_PRESETS = {
    llama3: { model: 'llama3', description: 'Meta Llama 3 (8B)' },
    llama3_70b: { model: 'llama3:70b', description: 'Meta Llama 3 (70B)' },
    mistral: { model: 'mistral', description: 'Mistral 7B' },
    codellama: { model: 'codellama', description: 'Code Llama' },
    gemma: { model: 'gemma', description: 'Gemma (open-source)' },
    phi3: { model: 'phi3', description: 'Microsoft Phi-3' },
    qwen2: { model: 'qwen2', description: 'Alibaba Qwen 2' },
}

export default {
    CustomLLM,
    createOllamaLLM,
    createCustomLLM,
    OLLAMA_PRESETS,
}
