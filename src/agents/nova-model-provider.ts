import { randomUUID } from 'node:crypto'
import { Usage, type AgentInputItem, type AgentOutputItem, type Model, type ModelProvider, type ModelRequest, type ModelResponse, type StreamEvent } from '@openai/agents'
import { createNovaLLMClient, type LLMMessage, type ToolDefinition } from '../llm/nova-llm-sdk.js'

function contentText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.map(part => {
        if (!part || typeof part !== 'object') return ''
        const item = part as Record<string, unknown>
        return String(item.text || item.refusal || item.transcript || '')
    }).filter(Boolean).join('\n')
}

function inputToMessages(systemInstructions: string | undefined, input: string | AgentInputItem[]): LLMMessage[] {
    const messages: LLMMessage[] = []
    if (systemInstructions) messages.push({ role: 'system', content: systemInstructions })
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input })
        return messages
    }

    for (const raw of input as any[]) {
        if (!raw || typeof raw !== 'object') continue
        if (raw.type === 'message' || raw.role) {
            const role = raw.role === 'system' || raw.role === 'assistant' ? raw.role : 'user'
            messages.push({ role, content: contentText(raw.content) })
        } else if (raw.type === 'function_call') {
            messages.push({
                role: 'assistant',
                content: '',
                toolCalls: [{
                    id: raw.callId || raw.id || randomUUID(),
                    name: raw.name,
                    arguments: JSON.parse(raw.arguments || '{}'),
                }],
            })
        } else if (raw.type === 'function_call_result') {
            messages.push({
                role: 'tool',
                toolCallId: raw.callId,
                content: contentText(raw.output) || JSON.stringify(raw.output),
            })
        }
    }
    return messages
}

function serializedToolsToNova(request: ModelRequest): ToolDefinition[] {
    return request.tools
        .filter(tool => tool.type === 'function')
        .map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as ToolDefinition['parameters'],
        }))
}

export class NovaAgentsModel implements Model {
    constructor(readonly modelName = 'auto') {}

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const client = await createNovaLLMClient({ model: this.modelName, role: 'chat' })
        const response = await client.complete(
            inputToMessages(request.systemInstructions, request.input),
            serializedToolsToNova(request),
            { toolChoice: request.modelSettings.toolChoice === 'required' ? 'required' : 'auto' },
        )

        const output: AgentOutputItem[] = []
        if (response.content) {
            output.push({
                id: `msg_${randomUUID()}`,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: response.content }],
            } as AgentOutputItem)
        }
        for (const call of response.toolCalls || []) {
            output.push({
                id: call.id,
                type: 'function_call',
                callId: call.id,
                name: call.name,
                status: 'completed',
                arguments: JSON.stringify(call.arguments || {}),
            } as AgentOutputItem)
        }

        return {
            usage: new Usage({
                requests: 1,
                inputTokens: response.usage?.promptTokens || 0,
                outputTokens: response.usage?.completionTokens || 0,
                totalTokens: response.usage?.totalTokens || 0,
            }),
            output,
            responseId: `nova_${randomUUID()}`,
            providerData: {
                provider: (client as any).providerId || 'nova-router',
                model: (client as any).modelId || this.modelName,
                node: (client as any).nodeId || (client as any).node,
                local: /(?:vllm|ollama|llama\.cpp|local|internal)/i.test(`${(client as any).providerId || ''} ${(client as any).modelId || ''}`),
            },
        }
    }

    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
        throw new Error('NovaAgentsModel streaming is not enabled; use a non-streaming Agents SDK run')
    }
}

/** Lets the OpenAI Agents loop use Nova's existing local/mesh/cloud model
 * resolver. No OpenAI-hosted model is selected unless Nova itself routes to it. */
export class NovaModelProvider implements ModelProvider {
    getModel(modelName = 'auto'): Model {
        return new NovaAgentsModel(modelName)
    }
}
