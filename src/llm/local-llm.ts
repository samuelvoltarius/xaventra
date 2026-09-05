import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


/**
 * Local LLM Provider - Ollama / LMStudio / vLLM
 * 
 * Supports local LLMs via OpenAI-compatible API:
 * - Ollama (http://localhost:11434)
 * - LMStudio (http://localhost:1234)
 * - vLLM (http://localhost:8000)
 * - Any OpenAI-compatible API
 */

// ============================================
// Types
// ============================================

export interface LocalLLMConfig {
    baseUrl: string          // e.g., http://localhost:11434
    model: string            // e.g., llama3, mistral, codellama
    apiKey?: string          // Optional for secured endpoints
    name?: string            // Display name
    requestTimeoutMs?: number
}

export interface LocalLLMMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface LocalLLMResponse {
    content: string
    model: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    tokensUsed?: number
    finishReason?: string
}

export interface LocalToolDefinition {
    name: string
    description: string
    parameters: Record<string, unknown>
}

export interface LocalLLMDiscovery {
    name: string
    baseUrl: string
    models: string[]
    source?: 'preset' | 'config' | 'env'
    nodeName?: string
}

const NON_CHAT_MODEL_PATTERN = /(?:^|[-_/])(embed|embedding|rerank|whisper|transcri|tts|speech|vision-encoder)(?:[-_/]|$)/i

export function selectLocalChatModel(models: string[], requestedModel = 'auto'): string | null {
    const available = models.map(model => model.trim()).filter(Boolean)
    if (requestedModel !== 'auto' && available.includes(requestedModel)) return requestedModel

    const chatModels = available.filter(model => !NON_CHAT_MODEL_PATTERN.test(model))
    return chatModels.find(model => model.toLowerCase() === 'qwen')
        || chatModels[0]
        || available[0]
        || null
}

// ============================================
// Preset Configurations
// ============================================

export const LOCAL_LLM_PRESETS: Record<string, Partial<LocalLLMConfig>> = {
    ollama: {
        baseUrl: 'http://localhost:11434',
        name: 'Ollama',
    },
    lmstudio: {
        baseUrl: 'http://localhost:1234',
        name: 'LMStudio',
    },
    vllm: {
        baseUrl: 'http://localhost:8000',
        name: 'vLLM',
    },
    llamacpp: {
        baseUrl: 'http://localhost:8080',
        name: 'llama.cpp',
    },
}

function normalizeBaseUrl(raw: string): string | null {
    const trimmed = raw.trim().replace(/\/+$/, '')
    if (!trimmed) return null
    return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

function getConfiguredLocalEndpoints(): Array<{ name: string; baseUrl: string; source: 'config' | 'env'; nodeName?: string }> {
    const endpoints: Array<{ name: string; baseUrl: string; source: 'config' | 'env'; nodeName?: string }> = []

    const envEndpoints = process.env.NOVA_LOCAL_LLM_ENDPOINTS
    if (envEndpoints) {
        for (const entry of envEndpoints.split(',')) {
            const [namePart, urlPart] = entry.includes('=') ? entry.split('=', 2) : ['', entry]
            const baseUrl = normalizeBaseUrl(urlPart ?? '')
            if (baseUrl) {
                endpoints.push({
                    name: namePart?.trim() || `Local LLM ${baseUrl}`,
                    baseUrl,
                    source: 'env',
                })
            }
        }
    }

    const cfgPath = resolveConfigPath()
    if (!existsSync(cfgPath)) return endpoints

    try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
            nodes?: Array<{
                name?: string
                services?: Record<string, string>
            }>
        }

        for (const node of cfg.nodes ?? []) {
            const services = node.services ?? {}
            for (const key of ['ollama', 'lmstudio', 'lmStudio', 'vllm', 'llamacpp']) {
                const baseUrl = normalizeBaseUrl(services[key] ?? '')
                if (!baseUrl) continue
                endpoints.push({
                    name: `${node.name ?? 'Configured node'} ${key}`,
                    baseUrl,
                    source: 'config',
                    nodeName: node.name,
                })
            }
        }
    } catch (err) {
        console.warn(`[LocalLLM] Could not read configured endpoints: ${err}`)
    }

    return endpoints
}

function getDiscoveryCandidates(): Array<{ name: string; baseUrl: string; source: 'preset' | 'config' | 'env'; nodeName?: string }> {
    const candidates: Array<{ name: string; baseUrl: string; source: 'preset' | 'config' | 'env'; nodeName?: string }> = []

    for (const [name, preset] of Object.entries(LOCAL_LLM_PRESETS)) {
        const baseUrl = normalizeBaseUrl(preset.baseUrl ?? '')
        if (!baseUrl) continue
        candidates.push({
            name: preset.name || name,
            baseUrl,
            source: 'preset',
        })
    }

    candidates.push(...getConfiguredLocalEndpoints())

    const seen = new Set<string>()
    return candidates.filter((candidate) => {
        const key = candidate.baseUrl.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

// ============================================
// Local LLM Client
// ============================================

export class LocalLLM {
    private config: LocalLLMConfig
    private available: boolean = false

    constructor(config: LocalLLMConfig) {
        this.config = config
        console.log(`[LocalLLM] Initialized: ${config.name || config.baseUrl} (${config.model})`)
    }

    // ============================================
    // Health Check
    // ============================================

    async checkAvailable(): Promise<boolean> {
        // Try Ollama-style endpoint first
        try {
            const ollamaCheck = await fetch(`${this.config.baseUrl}/api/tags`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            })

            if (ollamaCheck.ok) {
                this.available = true
                console.log(`[LocalLLM] ✅ Ollama available at ${this.config.baseUrl}`)
                return true
            }
        } catch {
            // Network error on Ollama endpoint — fall through to OpenAI check
        }

        // Try OpenAI-compatible endpoint (vLLM, LMStudio, llama.cpp, etc.)
        try {
            const openaiCheck = await fetch(`${this.config.baseUrl}/v1/models`, {
                method: 'GET',
                headers: this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {},
                signal: AbortSignal.timeout(3000),
            })

            if (openaiCheck.ok) {
                this.available = true
                console.log(`[LocalLLM] ✅ OpenAI-compatible API available at ${this.config.baseUrl}`)
                return true
            }
        } catch {
            // Not available
        }

        this.available = false
        console.log(`[LocalLLM] ❌ Not available at ${this.config.baseUrl}`)
        return false
    }

    // ============================================
    // List Available Models
    // ============================================

    async listModels(): Promise<string[]> {
        const discoveryTimeoutMs = Math.max(250, Number(process.env.NOVA_LOCAL_DISCOVERY_TIMEOUT_MS || 1800))
        // Try Ollama endpoint first
        try {
            const response = await fetch(`${this.config.baseUrl}/api/tags`, {
                method: 'GET',
                signal: AbortSignal.timeout(discoveryTimeoutMs),
            })

            if (response.ok) {
                const data = await response.json() as { models?: Array<{ name: string }> }
                return data.models?.map(m => m.name) || []
            }
        } catch {
            // Network error — fall through to OpenAI check
        }

        // Try OpenAI-compatible endpoint (vLLM, LMStudio, llama.cpp, etc.)
        try {
            const response = await fetch(`${this.config.baseUrl}/v1/models`, {
                method: 'GET',
                headers: this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {},
                signal: AbortSignal.timeout(discoveryTimeoutMs),
            })

            if (response.ok) {
                const data = await response.json() as { data?: Array<{ id: string }> }
                return data.data?.map(m => m.id) || []
            }
        } catch {
            // Not available
        }

        return []
    }

    // ============================================
    // Chat Completion (Ollama format)
    // ============================================

    async complete(messages: LocalLLMMessage[], tools: LocalToolDefinition[] = []): Promise<LocalLLMResponse> {
        // Detect API type and use appropriate endpoint
        const isOllama = this.config.baseUrl.includes('11434')

        if (isOllama) {
            return this.completeOllama(messages, tools)
        } else {
            return this.completeOpenAI(messages, tools)
        }
    }

    private async resolveOpenAIModel(force = false): Promise<string | null> {
        if (!force && this.config.model !== 'auto') return this.config.model

        const models = await this.listModels()
        const selected = selectLocalChatModel(models, this.config.model)
        if (!selected) return null
        if (selected !== this.config.model) {
            const previous = this.config.model
            this.setModel(selected)
            console.warn(`[LocalLLM] Model ${previous} is unavailable; using discovered model ${selected}`)
        }
        return selected
    }

    private async completeOllama(messages: LocalLLMMessage[], tools: LocalToolDefinition[]): Promise<LocalLLMResponse> {
        console.log(`[LocalLLM] Calling Ollama: ${this.config.model}`)

        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.config.model,
                messages: messages.map((m: any) => {
                    const msg: any = { role: m.role, content: m.content }
                    // Ollama multimodal: pass base64 images for vision models
                    if (m.image?.data) {
                        msg.images = [m.image.data]
                    }
                    return msg
                }),
                ...(tools.length > 0 && {
                    tools: tools.map(tool => ({ type: 'function', function: tool })),
                }),
                stream: false,
                // Qwen 3.x can otherwise exhaust the fallback deadline in its
                // separate thinking channel and leave message.content empty.
                think: false,
            }),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 55_000),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`Ollama error (${response.status}): ${error}`)
        }

        const data = await response.json() as {
            message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> | string } }> }
            model?: string
            eval_count?: number
            prompt_eval_count?: number
        }

        const toolCalls = (data.message?.tool_calls || []).flatMap((call, index) => {
            const name = call.function?.name
            if (!name) return []
            let args: Record<string, unknown> = {}
            const rawArgs = call.function?.arguments
            if (typeof rawArgs === 'string') {
                try { args = JSON.parse(rawArgs) } catch { args = {} }
            } else if (rawArgs && typeof rawArgs === 'object') args = rawArgs
            return [{ id: `local_${Date.now()}_${index}`, name, arguments: args }]
        })
        return {
            content: data.message?.content || '',
            model: data.model || this.config.model,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            tokensUsed: (data.eval_count || 0) + (data.prompt_eval_count || 0),
            finishReason: 'stop',
        }
    }

    private async completeOpenAI(messages: LocalLLMMessage[], tools: LocalToolDefinition[]): Promise<LocalLLMResponse> {
        console.log(`[LocalLLM] Calling ${this.config.name || this.config.model} at ${this.config.baseUrl}`)

        // vLLM / Qwen requires: system message FIRST, only one system message allowed.
        // Nova may inject multiple system messages (CoreFacts, Observer, Few-Shot) at various
        // positions — merge them all into a single system message at position 0.
        const systemParts = messages
            .filter(m => m.role === 'system')
            .map(m => m.content)
            .filter(Boolean)
        const nonSystem = messages.filter(m => m.role !== 'system')
        const normalizedMessages: LocalLLMMessage[] = systemParts.length > 0
            ? [{ role: 'system', content: systemParts.join('\n\n---\n\n') }, ...nonSystem]
            : nonSystem

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        }
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`
        }

        await this.resolveOpenAIModel()
        const request = () => fetch(`${this.config.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: this.config.model,
                    messages: normalizedMessages,
                    ...(tools.length > 0 && {
                        tools: tools.map(tool => ({ type: 'function', function: tool })),
                    }),
                }),
                signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 55_000), // stay below the caller deadline
            })

        let response = await request()

        if (!response.ok) {
            const error = await response.text()
            const missingModel = response.status === 404 && /model.+(?:does not exist|not found|unknown)/i.test(error)
            if (missingModel) {
                const failedModel = this.config.model
                await this.resolveOpenAIModel(true)
                if (this.config.model !== failedModel) {
                    console.warn(`[LocalLLM] Retrying completion with discovered model ${this.config.model}`)
                    response = await request()
                    if (!response.ok) {
                        const retryError = await response.text()
                        throw new Error(`LLM API error (${response.status}): ${retryError}`)
                    }
                } else {
                    throw new Error(`LLM API error (${response.status}): ${error}`)
                }
            } else {
                throw new Error(`LLM API error (${response.status}): ${error}`)
            }
        }

        const data = await response.json() as {
            choices?: Array<{
                message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }> }
                finish_reason?: string
            }>
            model?: string
            usage?: { total_tokens?: number }
        }

        const toolCalls = (data.choices?.[0]?.message?.tool_calls || []).flatMap((call, index) => {
            const name = call.function?.name
            if (!name) return []
            let args: Record<string, unknown> = {}
            const rawArgs = call.function?.arguments
            if (typeof rawArgs === 'string') {
                try { args = JSON.parse(rawArgs) } catch { args = {} }
            } else if (rawArgs && typeof rawArgs === 'object') args = rawArgs
            return [{ id: call.id || `local_${Date.now()}_${index}`, name, arguments: args }]
        })
        return {
            content: data.choices?.[0]?.message?.content || '',
            model: data.model || this.config.model,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            tokensUsed: data.usage?.total_tokens,
            finishReason: data.choices?.[0]?.finish_reason,
        }
    }

    // ============================================
    // Streaming Completion
    // ============================================

    async *stream(messages: LocalLLMMessage[]): AsyncGenerator<string> {
        const isOllama = this.config.baseUrl.includes('11434')

        if (isOllama) {
            yield* this.streamOllama(messages)
        } else {
            yield* this.streamOpenAI(messages)
        }
    }

    private async *streamOllama(messages: LocalLLMMessage[]): AsyncGenerator<string> {
        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.config.model,
                messages,
                stream: true,
                think: false,
            }),
        })

        if (!response.ok || !response.body) {
            throw new Error(`Ollama stream error: ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })
            const lines = chunk.split('\n').filter(l => l.trim())

            for (const line of lines) {
                try {
                    const data = JSON.parse(line)
                    if (data.message?.content) {
                        yield data.message.content
                    }
                } catch {
                    // Skip invalid lines
                }
            }
        }
    }

    private async *streamOpenAI(messages: LocalLLMMessage[]): AsyncGenerator<string> {
        // Normalize messages: merge system messages to front (vLLM/Qwen requirement)
        const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).filter(Boolean)
        const nonSystem = messages.filter(m => m.role !== 'system')
        const normalizedMessages: LocalLLMMessage[] = systemParts.length > 0
            ? [{ role: 'system', content: systemParts.join('\n\n---\n\n') }, ...nonSystem]
            : nonSystem

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        }
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`
        }

        await this.resolveOpenAIModel()
        const request = () => fetch(`${this.config.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: this.config.model,
                    messages: normalizedMessages,
                    stream: true,
                }),
                signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 55_000),
            })

        let response = await request()

        if (!response.ok) {
            const error = await response.text()
            const missingModel = response.status === 404 && /model.+(?:does not exist|not found|unknown)/i.test(error)
            if (missingModel) {
                const failedModel = this.config.model
                await this.resolveOpenAIModel(true)
                if (this.config.model !== failedModel) {
                    console.warn(`[LocalLLM] Retrying stream with discovered model ${this.config.model}`)
                    response = await request()
                }
            }
        }

        if (!response.ok || !response.body) {
            throw new Error(`OpenAI-compatible stream error: ${response.status}`)
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
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6))
                        const content = data.choices?.[0]?.delta?.content
                        if (content) yield content
                    } catch {
                        // Skip
                    }
                }
            }
        }
    }

    // ============================================
    // Getters
    // ============================================

    isAvailable(): boolean {
        return this.available
    }

    getModel(): string {
        return this.config.model
    }

    setModel(model: string): void {
        this.config.model = model
        console.log(`[LocalLLM] Model changed to: ${model}`)
    }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a local LLM client for Ollama
 */
export function createOllamaClient(model = 'llama3'): LocalLLM {
    return new LocalLLM({
        ...LOCAL_LLM_PRESETS.ollama,
        model,
    } as LocalLLMConfig)
}

/**
 * Create a local LLM client for LMStudio
 */
export function createLMStudioClient(model = 'local-model'): LocalLLM {
    return new LocalLLM({
        ...LOCAL_LLM_PRESETS.lmstudio,
        model,
    } as LocalLLMConfig)
}

/**
 * Create a local LLM client with custom config
 */
export function createLocalLLM(config: LocalLLMConfig): LocalLLM {
    return new LocalLLM(config)
}

// ============================================
// Auto-Detect Local LLMs
// ============================================

/**
 * Scan for available local LLM servers
 */
export async function detectLocalLLMs(): Promise<LocalLLMDiscovery[]> {
    const timeoutMs = Math.max(250, Number(process.env.NOVA_LOCAL_DISCOVERY_TIMEOUT_MS || 1800))
    const probes = getDiscoveryCandidates().map(async candidate => {
        const client = new LocalLLM({
            baseUrl: candidate.baseUrl,
            model: 'test',
            name: candidate.name,
        })
        // listModels is already an availability probe; avoid checkAvailable + listModels
        // doing the same two HTTP requests twice for every candidate.
        const models = await Promise.race([
            client.listModels(),
            new Promise<string[]>(resolve => setTimeout(() => resolve([]), timeoutMs)),
        ])
        if (models.length > 0) {
            return {
                name: candidate.name,
                baseUrl: candidate.baseUrl,
                models,
                source: candidate.source,
                nodeName: candidate.nodeName,
            } satisfies LocalLLMDiscovery
        }
        return null
    })

    const found = (await Promise.all(probes)).filter(Boolean) as LocalLLMDiscovery[]

    if (found.length > 0) {
        console.log(`[LocalLLM] Found ${found.length} local LLM server(s):`)
        for (const f of found) {
            console.log(`  - ${f.name}: ${f.models.length} models (${f.models.slice(0, 3).join(', ')}${f.models.length > 3 ? '...' : ''})`)
        }
    } else {
        console.log(`[LocalLLM] No local LLM servers found`)
    }

    return found
}

export default {
    LocalLLM,
    createOllamaClient,
    createLMStudioClient,
    createLocalLLM,
    detectLocalLLMs,
    LOCAL_LLM_PRESETS,
}
