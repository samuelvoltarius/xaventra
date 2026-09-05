/**
 * Nova - Tool Executor
 * 
 * Unified interface for LLM tool calling across all providers.
 * Handles the complete cycle:
 * 1. Format tools for LLM
 * 2. Detect tool calls in response
 * 3. Execute tools
 * 4. Format results for LLM
 */

import { getToolRegistry, type ToolCall, type ToolResult, type OpenAITool } from './registry.js'

// ============================================
// Types
// ============================================

export interface LLMToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string  // JSON string
    }
}

export interface LLMResponse {
    content: string | null
    toolCalls?: LLMToolCall[]
    finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
}

export interface ToolExecutionResult {
    toolCallId: string
    role: 'tool'
    name: string
    content: string  // JSON string of result
}

// ============================================
// Tool Executor
// ============================================

export class ToolExecutor {
    private isElevatedUser: boolean

    constructor(isElevatedUser = false) {
        this.isElevatedUser = isElevatedUser
    }

    // ============================================
    // Get Tools for LLM
    // ============================================

    /**
     * Get tools in OpenAI format (works for most LLMs).
     */
    getToolsForLLM(): OpenAITool[] {
        return getToolRegistry().toOpenAIFormat()
    }

    /**
     * Get tools in legacy format (function_declarations).
     */
    getToolsForLegacyFormat(): unknown[] {
        return getToolRegistry().getAll().map(tool => ({
            function_declarations: [{
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: 'object',
                    properties: Object.fromEntries(
                        tool.parameters.map(p => [
                            p.name,
                            {
                                type: p.type,
                                description: p.description,
                                ...(p.enum ? { enum: p.enum } : {}),
                            }
                        ])
                    ),
                    required: tool.parameters
                        .filter(p => p.required)
                        .map(p => p.name),
                },
            }],
        }))
    }

    // ============================================
    // Detect & Parse Tool Calls
    // ============================================

    /**
     * Check if response contains tool calls.
     */
    hasToolCalls(response: LLMResponse): boolean {
        return !!response.toolCalls && response.toolCalls.length > 0
    }

    /**
     * Parse tool calls from LLM response (OpenAI format).
     */
    parseToolCalls(llmToolCalls: LLMToolCall[]): ToolCall[] {
        return llmToolCalls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
        }))
    }

    /**
     * Parse tool calls from legacy format response.
     */
    parseLegacyToolCalls(parts: Array<{ functionCall?: { name: string; args: unknown } }>): ToolCall[] {
        return parts
            .filter(p => p.functionCall)
            .map((p, i) => ({
                id: `call_${i}`,
                name: p.functionCall!.name,
                arguments: p.functionCall!.args as Record<string, unknown>,
            }))
    }

    // ============================================
    // Execute Tools
    // ============================================

    /**
     * Execute a single tool call.
     */
    async execute(call: ToolCall): Promise<ToolResult> {
        return getToolRegistry().execute(call, this.isElevatedUser)
    }

    /**
     * Execute multiple tool calls.
     */
    async executeAll(calls: ToolCall[]): Promise<ToolResult[]> {
        return getToolRegistry().executeMultiple(calls, this.isElevatedUser)
    }

    // ============================================
    // Format Results for LLM
    // ============================================

    /**
     * Format results for OpenAI message format.
     */
    formatResultsForLLM(results: ToolResult[]): ToolExecutionResult[] {
        return results.map(r => ({
            toolCallId: r.toolCallId,
            role: 'tool' as const,
            name: r.name,
            content: r.success
                ? JSON.stringify(r.result)
                : JSON.stringify({ error: r.error }),
        }))
    }

    /**
     * Format results for legacy format.
     */
    formatResultsForLegacyFormat(results: ToolResult[]): unknown[] {
        return results.map(r => ({
            functionResponse: {
                name: r.name,
                response: r.success ? r.result : { error: r.error },
            },
        }))
    }

    // ============================================
    // Complete Tool Calling Cycle
    // ============================================

    /**
     * Handle complete tool calling cycle.
     * Returns formatted results to send back to LLM.
     */
    async handleToolCalls(llmToolCalls: LLMToolCall[]): Promise<ToolExecutionResult[]> {
        const calls = this.parseToolCalls(llmToolCalls)
        const results = await this.executeAll(calls)
        return this.formatResultsForLLM(results)
    }

    /**
     * Handle legacy format tool calls.
     */
    async handleLegacyToolCalls(parts: Array<{ functionCall?: { name: string; args: unknown } }>): Promise<unknown[]> {
        const calls = this.parseLegacyToolCalls(parts)
        const results = await this.executeAll(calls)
        return this.formatResultsForLegacyFormat(results)
    }
}

// ============================================
// Example Usage in LLM Provider
// ============================================

/*
// In your LLM provider (e.g., openai.ts):

import { ToolExecutor } from '../tools/executor.js'

async function completeWithTools(messages: Message[], isAdmin = false): Promise<string> {
    const executor = new ToolExecutor(isAdmin)
    
    // First call with tools
    let response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages,
        tools: executor.getToolsForLLM(),
    })
    
    // Handle tool calls in a loop
    while (response.choices[0].finish_reason === 'tool_calls') {
        const toolCalls = response.choices[0].message.tool_calls
        const results = await executor.handleToolCalls(toolCalls)
        
        // Add assistant message and tool results
        messages.push(response.choices[0].message)
        messages.push(...results)
        
        // Continue conversation
        response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages,
            tools: executor.getToolsForLLM(),
        })
    }
    
    return response.choices[0].message.content
}
*/

// ============================================
// Factory
// ============================================

export function createToolExecutor(isElevatedUser = false): ToolExecutor {
    return new ToolExecutor(isElevatedUser)
}

export default { ToolExecutor, createToolExecutor }
