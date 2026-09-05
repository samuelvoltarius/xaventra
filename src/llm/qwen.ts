/**
 * Nova - Qwen LLM Provider
 * 
 * Qwen (通义千问) integration via Alibaba Cloud DashScope API.
 * Supports both Qwen models and Qwen-VL (vision) models.
 */

import { Message, StreamingChunk, LLMResponse } from '../core/types.js'

// ============================================
// Types
// ============================================

export interface QwenConfig {
    apiKey: string
    model?: string
    maxTokens?: number
    temperature?: number
    baseUrl?: string
}

interface QwenMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

interface QwenRequest {
    model: string
    input: {
        messages: QwenMessage[]
    }
    parameters?: {
        max_tokens?: number
        temperature?: number
        top_p?: number
        result_format?: 'text' | 'message'
        incremental_output?: boolean
    }
}

interface QwenResponse {
    output: {
        text?: string
        choices?: Array<{
            message: {
                role: string
                content: string
            }
            finish_reason: string
        }>
        finish_reason?: string
    }
    usage: {
        input_tokens: number
        output_tokens: number
        total_tokens: number
    }
    request_id: string
}

interface QwenStreamEvent {
    output: {
        text?: string
        choices?: Array<{
            message: {
                content: string
            }
            finish_reason?: string
        }>
        finish_reason?: string
    }
    usage?: {
        input_tokens: number
        output_tokens: number
        total_tokens: number
    }
}

// ============================================
// Qwen Adapter
// ============================================

export class QwenAdapter {
    private config: QwenConfig
    private baseUrl: string

    constructor(config: QwenConfig) {
        this.config = config
        this.baseUrl = config.baseUrl || 'https://dashscope.aliyuncs.com/api/v1'
    }

    private get model(): string {
        return this.config.model || 'qwen-turbo'
    }

    // Convert Nova messages to Qwen format
    private convertMessages(messages: Message[]): QwenMessage[] {
        return messages.map(msg => ({
            role: msg.role as 'system' | 'user' | 'assistant',
            content: msg.content,
        }))
    }

    // ============================================
    // Non-streaming completion
    // ============================================

    async complete(messages: Message[]): Promise<LLMResponse> {
        const body: QwenRequest = {
            model: this.model,
            input: {
                messages: this.convertMessages(messages),
            },
            parameters: {
                max_tokens: this.config.maxTokens ?? 4096,
                temperature: this.config.temperature ?? 0.7,
                result_format: 'message',
            },
        }

        const url = `${this.baseUrl}/services/aigc/text-generation/generation`

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`Qwen API error: ${error}`)
        }

        const data = await response.json() as QwenResponse

        // Handle both text and message format
        const content = data.output.choices?.[0]?.message?.content
            || data.output.text
            || ''

        return {
            content,
            model: this.model,
            usage: {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens: data.usage.total_tokens,
            },
        }
    }

    // ============================================
    // Streaming completion
    // ============================================

    async *stream(messages: Message[]): AsyncGenerator<StreamingChunk> {
        const body: QwenRequest = {
            model: this.model,
            input: {
                messages: this.convertMessages(messages),
            },
            parameters: {
                max_tokens: this.config.maxTokens ?? 4096,
                temperature: this.config.temperature ?? 0.7,
                result_format: 'message',
                incremental_output: true,
            },
        }

        const url = `${this.baseUrl}/services/aigc/text-generation/generation`

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
                'X-DashScope-SSE': 'enable',
            },
            body: JSON.stringify(body),
        })

        if (!response.ok) {
            throw new Error(`Qwen streaming error: ${response.status}`)
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
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const data = line.slice(5).trim()
                    if (!data) continue

                    try {
                        const parsed: QwenStreamEvent = JSON.parse(data)

                        // Get content from either format
                        const text = parsed.output.choices?.[0]?.message?.content
                            || parsed.output.text

                        if (text) {
                            yield { content: text, done: false }
                        }

                        // Check for completion
                        const reason = parsed.output.choices?.[0]?.finish_reason
                            || parsed.output.finish_reason

                        if (reason === 'stop') {
                            yield { done: true }
                            return
                        }
                    } catch {
                        // Skip malformed JSON
                    }
                }
            }
        }

        yield { done: true }
    }

    // ============================================
    // Model info
    // ============================================

    getAvailableModels(): string[] {
        return [
            'qwen-turbo',
            'qwen-plus',
            'qwen-max',
            'qwen-max-longcontext',
            'qwen-vl-plus',
            'qwen-vl-max',
            'qwen2-72b-instruct',
            'qwen2-57b-a14b-instruct',
            'qwen2-7b-instruct',
        ]
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                },
            })
            return response.ok
        } catch {
            return false
        }
    }
}

// ============================================
// Factory
// ============================================

export function createQwen(config: QwenConfig): QwenAdapter {
    return new QwenAdapter(config)
}
