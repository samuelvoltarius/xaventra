/**
 * Nova - MiniMax LLM Provider
 *
 * Supports MiniMax M3, M2.7, M2.5, M2.1, M2 series
 * API: https://api.minimax.io/v1 (OpenAI-compatible)
 */

import { recordModelCall } from '../model-perf-db.js'

// ============================================
// Windows-1252 Mojibake Repair
// MiniMax API double-encodes text: UTF-8 bytes are treated as Windows-1252
// characters and then re-encoded as UTF-8. This causes ü → Ã¼, ☕ → â˜•, etc.
// ============================================

// Windows-1252 specific mappings (bytes 0x80-0x9F that differ from Latin-1)
const CP1252_BYTES: Record<number, number> = {
    0x20AC: 0x80, // €
    0x201A: 0x82, // ‚
    0x0192: 0x83, // ƒ
    0x201E: 0x84, // „
    0x2026: 0x85, // …
    0x2020: 0x86, // †
    0x2021: 0x87, // ‡
    0x02C6: 0x88, // ˆ
    0x2030: 0x89, // ‰
    0x0160: 0x8A, // Š
    0x2039: 0x8B, // ‹
    0x0152: 0x8C, // Œ
    0x017D: 0x8E, // Ž
    0x2018: 0x91, // '
    0x2019: 0x92, // '
    0x201C: 0x93, // "
    0x201D: 0x94, // "
    0x2022: 0x95, // •
    0x2013: 0x96, // –
    0x2014: 0x97, // —
    0x02DC: 0x98, // ˜
    0x2122: 0x99, // ™
    0x0161: 0x9A, // š
    0x203A: 0x9B, // ›
    0x0153: 0x9C, // œ
    0x017E: 0x9E, // ž
    0x0178: 0x9F, // Ÿ
}

function repairCp1252Mojibake(text: string): string {
    if (!text) return text
    // Quick check: does the string contain any non-ASCII characters that might be mojibake?
    if (!/[-￿]/.test(text)) return text

    const bytes: number[] = []
    for (const char of text) {
        const cp = char.codePointAt(0)!
        if (cp < 0x80) {
            bytes.push(cp)                          // ASCII unchanged
        } else if (cp >= 0x80 && cp <= 0xFF) {
            bytes.push(cp)                          // Latin-1 range: byte = codepoint
        } else if (CP1252_BYTES[cp] !== undefined) {
            bytes.push(CP1252_BYTES[cp])            // Windows-1252 specific char → its byte
        } else {
            // Character outside cp1252 range — keep as-is (encode to UTF-8 bytes)
            for (const b of Buffer.from(char, 'utf8')) bytes.push(b)
        }
    }

    try {
        const repaired = Buffer.from(bytes).toString('utf-8')
        // Only use repaired version if it's valid UTF-8 (no replacement chars)
        if (!repaired.includes('�')) return repaired
    } catch { /* keep original */ }

    return text
}

// ============================================
// Types
// ============================================

export interface MiniMaxMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
    // Vision: optional inline image (base64). MiniMax-M3 is multimodal and
    // accepts the OpenAI image_url format on the /chat/completions endpoint.
    image?: { data: string; mimeType: string }
}

export interface MiniMaxConfig {
    apiKey: string
    model?: string
    baseUrl?: string
}

export interface MiniMaxCompletionResult {
    content: string
    reasoning?: string
    model: string
    tokensUsed?: number
    promptTokens?: number
    completionTokens?: number
    stopReason?: string
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
}

// ============================================
// Constants
// ============================================

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1'

// ============================================
// MiniMax LLM Adapter
// ============================================

export class MiniMaxLLM {
    private apiKey: string
    private baseUrl: string
    private currentModel: string

    constructor(config: MiniMaxConfig) {
        this.apiKey = config.apiKey
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
        this.currentModel = config.model ?? 'MiniMax-M3'
    }

    setModel(model: string): void {
        this.currentModel = model
    }

    getModel(): string {
        return this.currentModel
    }

async complete(
        messages: MiniMaxMessage[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string; tools?: any[]; toolChoice?: 'auto' | 'required' } = {}
    ): Promise<MiniMaxCompletionResult> {
        // Use OpenAI endpoint — this is what worked for "schreib Sample Two" (3 tool rounds)
        // Anthropic endpoint: tool_choice:{type:"any"} was ignored, returned text anyway
        // OpenAI endpoint with tool_choice:"auto": model picks tools when intent is clear
        return this.completeOpenAI(messages, options)
    }

    // ---- Anthropic-compatible endpoint (with thinking + tools) ----
    private async completeAnthropic(
        messages: MiniMaxMessage[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string; tools?: any[]; toolChoice?: 'auto' | 'required' } = {}
    ): Promise<MiniMaxCompletionResult> {
        // Anthropic format: system is separate, messages only user/assistant
        const anthropicMessages = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.content }))

        const requestBody: any = {
            model: this.currentModel,
            max_tokens: options.maxTokens ?? 8192,
            messages: anthropicMessages,
            // Thinking mode — MiniMax M3 reasons before acting (agentic tasks)
            thinking: { type: 'enabled', budget_tokens: 3000 },
        }

        if (options.systemPrompt) {
            requestBody.system = options.systemPrompt
        }

        if (options.tools && options.tools.length > 0) {
            requestBody.tools = options.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: {
                    type: 'object',
                    properties: Array.isArray(t.parameters) ? Object.fromEntries(
                        t.parameters.map((p: any) => [p.name, { type: p.type, description: p.description }])
                    ) : (t.parameters?.properties || {}),
                    required: Array.isArray(t.parameters)
                        ? t.parameters.filter((p: any) => p.required).map((p: any) => p.name)
                        : (t.parameters?.required || []),
                },
            }))
            // Force tool use: model MUST call at least one tool (Anthropic format)
            requestBody.tool_choice = options.toolChoice === 'required' ? { type: 'any' } : { type: 'auto' }
        }

        // Derive Anthropic base URL from OpenAI base URL
        const anthropicBase = this.baseUrl.replace('/v1', '/anthropic/v1')
        console.log(`[MiniMax] Calling ${this.currentModel} at ${anthropicBase} (Anthropic+Thinking)`)

        const response = await fetch(`${anthropicBase}/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.NOVA_MINIMAX_TIMEOUT_MS || 30_000))),
        })

        if (!response.ok) {
            const errText = await response.text()
            console.log(`[MiniMax] Anthropic endpoint failed (${response.status}): ${errText.slice(0, 200)}`)
            console.log(`[MiniMax] Falling back to OpenAI endpoint`)
            return this.completeOpenAI(messages, options)
        }
        const buffer = await response.arrayBuffer()
        const text = Buffer.from(buffer).toString('utf-8')
        const data = JSON.parse(text) as any
        const blocks = (data.content || []).map((b: any) => b.type)
        const hasTools = blocks.includes('tool_use')
        console.log(`[MiniMax] Anthropic: stop_reason=${data.stop_reason} blocks=[${blocks.join(',')}]${hasTools ? ' 🔧 TOOLS!' : ''}`)
        return this.parseAnthropicResponse(data)
    }

    private parseAnthropicResponse(data: any): MiniMaxCompletionResult {
        const content = data.content || []
        let textContent = ''
        let reasoning = ''
        const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []

        for (const block of content) {
            if (block.type === 'thinking') {
                reasoning = block.thinking || ''
            } else if (block.type === 'text') {
                textContent += block.text || ''
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    name: block.name,
                    arguments: block.input || {},
                })
            }
        }

        textContent = repairCp1252Mojibake(textContent.trim())

        const usage = data.usage || {}
        if (toolCalls.length > 0) {
            console.log(`[MiniMax] 🔧 Anthropic tool calls: ${toolCalls.map(t => t.name).join(', ')}`)
        }
        if (reasoning) {
            console.log(`[MiniMax] 🧠 Thinking: ${reasoning.slice(0, 100)}...`)
        }

        return {
            content: textContent,
            reasoning: reasoning || undefined,
            model: this.currentModel,
            tokensUsed: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            stopReason: data.stop_reason,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        }
    }

    // ---- OpenAI-compatible endpoint (simple chat, no thinking) ----
    private async completeOpenAI(
        messages: MiniMaxMessage[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string; tools?: any[]; toolChoice?: 'auto' | 'required' } = {}
    ): Promise<MiniMaxCompletionResult> {
        const builtMessages: Array<{ role: string; content: any }> = []
        if (options.systemPrompt) {
            builtMessages.push({ role: 'system', content: options.systemPrompt })
        }
        let hasVision = false
        for (const m of messages) {
            if (m.image?.data) {
                // OpenAI-style multimodal content: text + image_url (data URL)
                hasVision = true
                builtMessages.push({
                    role: m.role,
                    content: [
                        ...(m.content ? [{ type: 'text', text: m.content }] : []),
                        {
                            type: 'image_url',
                            image_url: { url: `data:${m.image.mimeType};base64,${m.image.data}` },
                        },
                    ],
                })
            } else {
                builtMessages.push({ role: m.role, content: m.content })
            }
        }
        if (hasVision) {
            console.log(`[MiniMax] 🖼️ Vision request — image forwarded to ${this.currentModel}`)
        }

        const requestBody: any = {
            model: this.currentModel,
            max_tokens: options.maxTokens ?? 8192,
            messages: builtMessages,
        }

        if (options.temperature !== undefined) {
            requestBody.temperature = options.temperature
        }

        if (options.tools && options.tools.length > 0) {
            requestBody.tools = options.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: [],
                        ...(typeof t.parameters === 'object' && !Array.isArray(t.parameters) ? t.parameters : {
                            type: 'object',
                            properties: Array.isArray(t.parameters) ? Object.fromEntries(
                                t.parameters.map((p: any) => [p.name, { type: p.type, description: p.description }])
                            ) : {},
                            required: Array.isArray(t.parameters) ? t.parameters.filter((p: any) => p.required).map((p: any) => p.name) : [],
                        }),
                    },
                },
            }))
            requestBody.tool_choice = options.toolChoice ?? 'auto'
        }

        console.log(`[MiniMax] Calling ${this.currentModel} at ${this.baseUrl} (OpenAI)`)

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json; charset=utf-8',
                'Accept': 'application/json; charset=utf-8',
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.NOVA_MINIMAX_TIMEOUT_MS || 30_000))),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`MiniMax API error (${response.status}): ${error}`)
        }

        const buffer = await response.arrayBuffer()
        const text = Buffer.from(buffer).toString('utf-8')
        const data = JSON.parse(text) as any

        if (data?.choices?.[0]?.message?.content) {
            data.choices[0].message.content = repairCp1252Mojibake(data.choices[0].message.content)
        }
        return this.parseResponse(data)
    }

    private parseResponse(data: any): MiniMaxCompletionResult {
        let content = data.choices?.[0]?.message?.content || ''
        const usage = data.usage || {}

        // Extract reasoning from thinking mode (adaptive thinking response)
        // MiniMax returns reasoning_details when thinking is enabled
        let reasoning: string | undefined
        const reasoningDetails = data.choices?.[0]?.message?.reasoning_details
        if (Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
            reasoning = reasoningDetails.map((r: any) => r.text || '').join('\n').trim()
        }

        // Also extract from <think> tags if present in content
        const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i)
        if (thinkMatch && !reasoning) {
            reasoning = thinkMatch[1].trim()
        }
        content = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim()
        content = this.stripResultWrapper(content)

        return {
            content,
            reasoning,
            model: this.currentModel,
            tokensUsed: usage.total_tokens ?? 0,
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            stopReason: data.choices?.[0]?.finish_reason,
            toolCalls: this.extractToolCalls(data),
        }
    }

    private extractToolCalls(data: any): Array<{ name: string; arguments: Record<string, unknown> }> | undefined {
        const raw = data.choices?.[0]?.message?.tool_calls
        if (!raw || !Array.isArray(raw)) return undefined
        return raw.map((tc: any) => {
            const rawArgs = tc.function?.arguments
            let args: Record<string, unknown> = {}
            if (typeof rawArgs === 'string') {
                // LLMs occasionally emit malformed JSON for tool args. A bare
                // JSON.parse would throw and kill the ENTIRE response (losing the
                // tool call). Degrade gracefully to empty args instead.
                try {
                    args = JSON.parse(rawArgs)
                } catch {
                    console.log(`[MiniMax] ⚠️ Tool "${tc.function?.name || tc.name}" hatte ungültiges JSON in arguments — nutze {}`)
                    args = {}
                }
            } else {
                args = rawArgs || tc.arguments || {}
            }
            return {
                name: tc.function?.name || tc.name || '',
                arguments: args,
            }
        })
    }

    private stripResultWrapper(content: string): string {
        return content
            .replace(/^<result>\s*/i, '')
            .replace(/\s*<\/result>\s*$/i, '')
            .trim()
    }

    async *stream(
        messages: MiniMaxMessage[],
        options: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}
    ): AsyncGenerator<{ content?: string; reasoning?: string; done: boolean }> {
        const systemPrompt = options.systemPrompt

        // The OpenAI-compatible /chat/completions endpoint has NO top-level
        // "system" field — it must be a role:'system' message. Prepend it, or
        // Nova's personality/instructions are silently dropped when streaming.
        const streamMessages: Array<{ role: string; content: string }> = []
        if (systemPrompt) {
            streamMessages.push({ role: 'system', content: systemPrompt })
        }
        for (const m of messages) {
            streamMessages.push({ role: m.role, content: m.content })
        }

        const requestBody: any = {
            model: this.currentModel,
            max_tokens: options.maxTokens ?? 8192,
            messages: streamMessages,
            stream: true,
        }

        if (options.temperature !== undefined) {
            requestBody.temperature = options.temperature
        }

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.NOVA_MINIMAX_TIMEOUT_MS || 30_000))),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`MiniMax stream error (${response.status}): ${error}`)
        }

        if (!response.body) {
            throw new Error('MiniMax stream: no response body')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                const json = line.slice(6)
                if (json === '[DONE]') {
                    yield { done: true }
                    return
                }

                try {
                    const event = JSON.parse(json)
                    const text = event.choices?.[0]?.delta?.content
                    if (text) yield { content: text, done: false }
                    if (event.usage) recordModelCall(this.currentModel, 'chat', 0, true)
                } catch {
                    // skip unparseable
                }
            }
        }

        yield { done: true }
    }
}

// ============================================
// Factory
// ============================================

export function createMiniMaxLLM(config: MiniMaxConfig): MiniMaxLLM {
    return new MiniMaxLLM(config)
}

export default { MiniMaxLLM, createMiniMaxLLM }
