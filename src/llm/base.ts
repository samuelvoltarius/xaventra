/**
 * Nova - LLM Base with Tool Calling
 * 
 * Base class for all LLM providers with integrated tool calling.
 * Providers extend this and implement provider-specific logic.
 */

import type { Message } from '../core/types.js'
import { createToolExecutor, type ToolExecutor, type LLMToolCall, type ToolExecutionResult } from '../tools/executor.js'
import { getToolRegistry } from '../tools/registry.js'

// ============================================
// Types
// ============================================

export interface LLMConfig {
    model: string
    apiKey?: string
    baseUrl?: string
    temperature?: number
    maxTokens?: number
    enableTools?: boolean
    maxToolRounds?: number  // Max tool call iterations
}

export interface CompletionOptions {
    tools?: boolean
    isElevatedUser?: boolean
    temperature?: number
    maxTokens?: number
}

export interface CompletionResult {
    content: string
    toolsUsed: string[]
    totalTokens?: number
}

// ============================================
// Abstract Base LLM
// ============================================

export abstract class BaseLLM {
    protected config: LLMConfig
    protected toolExecutor: ToolExecutor | null = null

    constructor(config: LLMConfig) {
        this.config = {
            enableTools: true,
            maxToolRounds: 10,
            temperature: 0.7,
            maxTokens: 4096,
            ...config,
        }
    }

    // ============================================
    // Abstract Methods (Provider-specific)
    // ============================================

    /**
     * Raw completion without tool handling.
     * Override in provider.
     */
    protected abstract rawComplete(
        messages: Message[],
        tools?: unknown[],
    ): Promise<{
        content: string | null
        toolCalls?: LLMToolCall[]
        finishReason: string
    }>

    /**
     * Get available models.
     * Override in provider.
     */
    abstract listModels(): Promise<string[]>

    /**
     * Check if provider is available.
     */
    abstract isAvailable(): Promise<boolean>

    // ============================================
    // Main Completion with Tool Loop
    // ============================================

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const useTools = options.tools ?? this.config.enableTools
        const toolsUsed: string[] = []

        // Create executor if using tools
        if (useTools) {
            this.toolExecutor = createToolExecutor(options.isElevatedUser ?? false)
        }

        let conversationMessages = [...messages]
        let rounds = 0

        while (rounds < (this.config.maxToolRounds ?? 10)) {
            rounds++

            // Get tools in provider-specific format
            const tools = useTools ? this.getToolsForProvider() : undefined

            // Call LLM
            const response = await this.rawComplete(conversationMessages, tools)

            // If no tool calls, return the result
            if (!response.toolCalls || response.toolCalls.length === 0) {
                return {
                    content: response.content || '',
                    toolsUsed,
                }
            }

            // Handle tool calls
            console.log(`[LLM] Tool calls in round ${rounds}:`, response.toolCalls.map(tc => tc.function.name))

            const results = await this.handleToolCalls(response.toolCalls)

            // Track which tools were used
            for (const tc of response.toolCalls) {
                if (!toolsUsed.includes(tc.function.name)) {
                    toolsUsed.push(tc.function.name)
                }
            }

            // Add assistant message and tool results to conversation
            conversationMessages.push({
                role: 'assistant',
                content: response.content || '',
                timestamp: Date.now(),
            })

            // Add tool results
            for (const result of results) {
                conversationMessages.push({
                    role: 'user',  // Some providers use 'tool' role
                    content: `Tool ${result.name} result: ${result.content}`,
                    timestamp: Date.now(),
                })
            }
        }

        // Max rounds reached
        console.log(`[LLM] Max tool rounds (${this.config.maxToolRounds}) reached`)
        return {
            content: 'Maximale Tool-Aufrufe erreicht.',
            toolsUsed,
        }
    }

    /**
     * Simple completion without tools.
     */
    async simpleComplete(messages: Message[]): Promise<string> {
        const result = await this.complete(messages, { tools: false })
        return result.content
    }

    // ============================================
    // Tool Handling
    // ============================================

    private async handleToolCalls(toolCalls: LLMToolCall[]): Promise<ToolExecutionResult[]> {
        if (!this.toolExecutor) {
            this.toolExecutor = createToolExecutor(false)
        }
        return this.toolExecutor.handleToolCalls(toolCalls)
    }

    /**
     * Get tools in provider-specific format.
     * Override if provider needs different format.
     */
    protected getToolsForProvider(): unknown[] {
        return getToolRegistry().toOpenAIFormat()
    }

    // ============================================
    // Streaming (Optional)
    // ============================================

    async *stream(messages: Message[], _options: CompletionOptions = {}): AsyncGenerator<string> {
        // Default implementation: just return complete result
        const result = await this.complete(messages, _options)
        yield result.content
    }

    // ============================================
    // Config
    // ============================================

    setModel(model: string): void {
        this.config.model = model
    }

    getModel(): string {
        return this.config.model
    }

    setTemperature(temp: number): void {
        this.config.temperature = temp
    }

    setMaxTokens(tokens: number): void {
        this.config.maxTokens = tokens
    }

    enableToolCalling(enabled: boolean): void {
        this.config.enableTools = enabled
    }
}

// ============================================
// OpenAI-Compatible Implementation
// ============================================

export class OpenAICompatibleLLM extends BaseLLM {
    private client: unknown = null

    constructor(config: LLMConfig & { apiKey: string; baseUrl?: string }) {
        super(config)
    }

    async ensureClient(): Promise<unknown> {
        if (!this.client) {
            const { default: OpenAI } = await import('openai')
            this.client = new OpenAI({
                apiKey: this.config.apiKey,
                baseURL: this.config.baseUrl,
            })
        }
        return this.client
    }

    protected async rawComplete(
        messages: Message[],
        tools?: unknown[],
    ): Promise<{
        content: string | null
        toolCalls?: LLMToolCall[]
        finishReason: string
    }> {
        const client = await this.ensureClient() as {
            chat: {
                completions: {
                    create: (params: unknown) => Promise<{
                        choices: Array<{
                            message: {
                                content: string | null
                                tool_calls?: LLMToolCall[]
                            }
                            finish_reason: string
                        }>
                    }>
                }
            }
        }

        const params: Record<string, unknown> = {
            model: this.config.model,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
            })),
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
        }

        if (tools && tools.length > 0) {
            params.tools = tools
            params.tool_choice = 'auto'
        }

        const response = await client.chat.completions.create(params)
        const choice = response.choices[0]

        return {
            content: choice.message.content,
            toolCalls: choice.message.tool_calls,
            finishReason: choice.finish_reason,
        }
    }

    async listModels(): Promise<string[]> {
        const client = await this.ensureClient() as {
            models: { list: () => Promise<{ data: Array<{ id: string }> }> }
        }
        const response = await client.models.list()
        return response.data.map(m => m.id)
    }

    async isAvailable(): Promise<boolean> {
        try {
            await this.ensureClient()
            return true
        } catch {
            return false
        }
    }
}

// ============================================
// Factory Functions
// ============================================

export function createOpenAILLM(apiKey: string, model = 'auto'): OpenAICompatibleLLM {
    return new OpenAICompatibleLLM({ apiKey, model })
}

export function createOllamaLLM(model = 'llama3', baseUrl = 'http://localhost:11434/v1'): OpenAICompatibleLLM {
    return new OpenAICompatibleLLM({
        apiKey: 'ollama',
        model,
        baseUrl,
    })
}

export function createGroqLLM(apiKey: string, model = 'llama-3.1-70b-versatile'): OpenAICompatibleLLM {
    return new OpenAICompatibleLLM({
        apiKey,
        model,
        baseUrl: 'https://api.groq.com/openai/v1',
    })
}

export function createAnthropicLLM(apiKey: string, model = 'claude-3-sonnet-20240229'): OpenAICompatibleLLM {
    return new OpenAICompatibleLLM({
        apiKey,
        model,
        baseUrl: 'https://api.anthropic.com/v1',
    })
}

export function createQwenLLM(apiKey: string, model = 'qwen-turbo'): OpenAICompatibleLLM {
    return new OpenAICompatibleLLM({
        apiKey,
        model,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
}

export default {
    BaseLLM,
    OpenAICompatibleLLM,
    createOpenAILLM,
    createOllamaLLM,
    createGroqLLM,
    createAnthropicLLM,
    createQwenLLM,
}

