import { randomUUID } from 'node:crypto'
import { Usage, type AgentInputItem, type AgentOutputItem, type Model, type ModelProvider, type ModelRequest, type ModelResponse, type StreamEvent } from '@openai/agents'
import { createNovaLLMClient, type LLMMessage, type ToolDefinition, type LLMResponse, type LLMCallOptions } from '../llm/nova-llm-sdk.js'

export interface NovaCompletionClient {
    complete(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse>
    modelId?: string
    providerId?: string
    nodeId?: string
}

export interface NovaAgentsModelOptions {
    client?: NovaCompletionClient
    initialResponse?: LLMResponse
    maxTokens?: number
    timeoutMs?: number
    beforeCall?: (messages: LLMMessage[], tools: ToolDefinition[]) => Promise<void>
    afterCall?: (response: LLMResponse) => Promise<void>
}

function contentText(content: unknown): string {
    if (typeof content === 'string') return content
    if (content && typeof content === 'object' && !Array.isArray(content)) {
        const item = content as Record<string, unknown>
        return typeof item.text === 'string' ? item.text : ''
    }
    if (!Array.isArray(content)) return ''
    return content.map(part => {
        if (!part || typeof part !== 'object') return ''
        const item = part as Record<string, unknown>
        return String(item.text || item.refusal || item.transcript || '')
    }).filter(Boolean).join('\n')
}

export function inputToMessages(systemInstructions: string | undefined, input: string | AgentInputItem[]): LLMMessage[] {
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
            const picture = Array.isArray(raw.content) ? raw.content.find((part: any) => part.type === 'input_image') : undefined
            const dataUrl = picture?.image?.match(/^data:([^;]+);base64,(.+)$/s)
            messages.push({ role, content: contentText(raw.content), ...(dataUrl ? { image: { mimeType: dataUrl[1], data: dataUrl[2] } } : {}) })
        } else if (raw.type === 'function_call') {
            const call = {
                    id: raw.callId || raw.id || randomUUID(),
                    name: raw.name,
                    arguments: JSON.parse(raw.arguments || '{}'),
                }
            const previous = messages.at(-1)
            if (previous?.role === 'assistant') (previous.toolCalls ||= []).push(call)
            else messages.push({ role: 'assistant', content: '', toolCalls: [call] })
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
    private initialResponse?: LLMResponse
    private correctionUsed = false
    constructor(readonly modelName = 'auto', private readonly options: NovaAgentsModelOptions = {}) {
        this.initialResponse = options.initialResponse
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const client = this.options.client || await createNovaLLMClient({ model: this.modelName, role: 'chat' })
        const messages = inputToMessages(request.systemInstructions, request.input)
        const tools = request.modelSettings.toolChoice === 'none' ? [] : serializedToolsToNova(request)
        const complete = async (input: LLMMessage[]) => {
            if (request.signal?.aborted) throw new Error('AbortError: agent model call cancelled')
            await this.options.beforeCall?.(input, tools)
            if (request.signal?.aborted) throw new Error('AbortError: agent model call cancelled')
            // The existing provider interface has no cancellation signal. Race
            // its result and refuse late output; never dispatch tools after abort.
            let timer: ReturnType<typeof setTimeout> | undefined
            let onAbort: (() => void) | undefined
            try {
                const result = await Promise.race([
                    client.complete(input, tools, {
                        toolChoice: tools.length && request.modelSettings.toolChoice === 'required' ? 'required' : 'auto',
                        maxTokens: this.options.maxTokens ?? request.modelSettings.maxTokens,
                        reasoningEffort: 'none',
                        timeoutMs: this.options.timeoutMs ?? 60_000,
                    }),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error('Timeout: agent model call exceeded deadline')), this.options.timeoutMs ?? 60_000)
                        onAbort = () => reject(new Error('AbortError: agent model call cancelled'))
                        request.signal?.addEventListener('abort', onAbort, { once: true })
                        if (request.signal?.aborted) onAbort()
                    }),
                ])
                if (request.signal?.aborted) throw new Error('AbortError: agent model call cancelled')
                await this.options.afterCall?.(result)
                return result
            } finally {
                if (timer) clearTimeout(timer)
                if (onAbort) request.signal?.removeEventListener('abort', onAbort)
            }
        }
        if (request.signal?.aborted) throw new Error('AbortError: agent model call cancelled')
        let response = this.initialResponse
        this.initialResponse = undefined
        response ||= await complete(messages)
        const responses = [response]
        const offered = new Set(tools.map(tool => tool.name))
        const outsideContract = () => (response!.toolCalls || []).some(call => !offered.has(call.name))
        if (outsideContract()) {
            if (this.correctionUsed || !tools.length) throw new Error('Model requested a tool outside the offered contract')
            this.correctionUsed = true
            // Reject the entire unexecuted batch. No registry fallback, shell
            // grant, tool error text or model-generated command enters authority.
            response = await complete([...messages, {
                role: 'system',
                content: 'The previous proposed tool batch was not executed because it contained a tool absent from this turn. Replan using ONLY the function tools supplied with this request. For a URL use an available HTTP/search tool. Do not invent tools or expand permissions. Return the requested results after tool execution.',
            }])
            responses.push(response)
            if (outsideContract()) throw new Error('Model repeated a tool outside the offered contract after one correction')
        }
        if (request.signal?.aborted) throw new Error('AbortError: agent model call cancelled')

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
            const callId = call.id || randomUUID()
            output.push({
                id: callId,
                type: 'function_call',
                callId,
                name: call.name,
                status: 'completed',
                arguments: JSON.stringify(call.arguments || {}),
            } as AgentOutputItem)
        }

        return {
            usage: new Usage({
                requests: responses.length,
                inputTokens: responses.reduce((sum, item) => sum + (item.usage?.promptTokens || 0), 0),
                outputTokens: responses.reduce((sum, item) => sum + (item.usage?.completionTokens || 0), 0),
                totalTokens: responses.reduce((sum, item) => sum + (item.usage?.totalTokens || 0), 0),
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
    private readonly models = new Map<string, Model>()
    constructor(private readonly options: NovaAgentsModelOptions = {}) {}
    getModel(modelName = 'auto'): Model {
        if (!this.models.has(modelName)) this.models.set(modelName, new NovaAgentsModel(modelName, this.options))
        return this.models.get(modelName)!
    }
}
