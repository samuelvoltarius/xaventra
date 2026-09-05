/**
 * Nova Complete LLM SDK
 * 
 * Full-featured LLM client without ANY external dependencies.
 * - Multi-Provider: OpenAI GPT, Anthropic Claude, Local (Ollama/LM Studio)
 * - Tool/Function Calling
 * - Streaming Responses
 * - OAuth Token Refresh
 * - Model Registry
 * 
 * NO pi-ai, NO nova, PURE HTTP!
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { FailoverError, classifyFailoverReason, resolveFailoverStatus } from './model-fallback.js'
import { recordModelCall, isModelDisabled } from './model-perf-db.js'
import { CLIENT_METADATA_JSON, USER_AGENT, API_CLIENT } from '../core/client-identity.js'
import { CodexCLIAdapter, isCodexAvailable, isCodexAuthenticated } from './codex-cli-adapter.js'
import { MiniMaxLLM, createMiniMaxLLM } from './providers/minimax.js'
import { recordLlmRequest, withSpan } from '../infra/telemetry.js'

// Codex CLI module reference for OpenAI provider fallback
type CodexCLIAdapterType = CodexCLIAdapter
const codexCliModule = { CodexCLIAdapter, isCodexAvailable, isCodexAuthenticated }


// ============================================
// Types
// ============================================

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    toolCalls?: ToolCall[]
    toolCallId?: string
    image?: { data: string; mimeType: string }  // Base64 image for vision
}

export interface ToolCall {
    id: string
    name: string
    arguments: Record<string, unknown>
}

export interface ToolDefinition {
    name: string
    description: string
    parameters: {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required?: string[]
    }
}

export interface LLMResponse {
    content: string
    reasoning?: string
    toolCalls?: ToolCall[]
    finishReason?: 'stop' | 'tool_calls' | 'length' | 'error'
    usage?: {
        promptTokens: number
        completionTokens: number
        totalTokens: number
    }
}

export interface LLMCallOptions {
    toolChoice?: 'auto' | 'required'
    maxTokens?: number
    /** Per-attempt deadline for latency-sensitive background work. */
    timeoutMs?: number
    /** Maximum local candidates to try. Omit for the normal failover chain. */
    maxAttempts?: number
}

export interface StreamChunk {
    content?: string
    toolCall?: Partial<ToolCall>
    done: boolean
}

export interface ProviderConfig {
    provider: 'claude' | 'openai' | 'local' | 'minimax'
    model: string
    apiKey?: string
    accessToken?: string
    refreshToken?: string
    projectId?: string
    maxTokens?: number
    temperature?: number
    baseUrl?: string  // For local and OpenAI-compatible providers
}

// ============================================
// Model Registry
// ============================================

export const MODEL_REGISTRY = {
    openai: {
        'auto': { maxTokens: 8192, contextWindow: 128000 },
        'o3-mini': { maxTokens: 4096, contextWindow: 128000 },
        'o3': { maxTokens: 4096, contextWindow: 200000 },
    },
    claude: {
        // Claude 4.6 (Feb 2026) — 1M context in beta
        'claude-sonnet-4-6': { maxTokens: 8192, contextWindow: 1000000 },
        'claude-sonnet-4-6-thinking': { maxTokens: 8192, contextWindow: 1000000 },
        'claude-opus-4-6': { maxTokens: 8192, contextWindow: 1000000 },
        'claude-opus-4-6-thinking': { maxTokens: 8192, contextWindow: 1000000 },
        // Claude 4.5 (legacy)
        'claude-sonnet-4-5': { maxTokens: 8192, contextWindow: 200000 },
        'claude-sonnet-4-5-thinking': { maxTokens: 8192, contextWindow: 200000 },
        'claude-opus-4-5': { maxTokens: 4096, contextWindow: 200000 },
        'claude-opus-4-5-thinking': { maxTokens: 4096, contextWindow: 200000 },
    },
    minimax: {
        // MiniMax M3 — 1M context, MSA sparse attention, frontier coding
        'MiniMax-M3': { maxTokens: 8192, contextWindow: 1000000 },
        // MiniMax M2.7 series — 204800 context
        'MiniMax-M2.7': { maxTokens: 8192, contextWindow: 204800 },
        'MiniMax-M2.7-highspeed': { maxTokens: 8192, contextWindow: 204800 },
        // MiniMax M2.5 series — 204800 context
        'MiniMax-M2.5': { maxTokens: 8192, contextWindow: 204800 },
        'MiniMax-M2.5-highspeed': { maxTokens: 8192, contextWindow: 204800 },
        // MiniMax M2.1 series — 204800 context
        'MiniMax-M2.1': { maxTokens: 8192, contextWindow: 204800 },
        'MiniMax-M2.1-highspeed': { maxTokens: 8192, contextWindow: 204800 },
        // MiniMax M2 — 204800 context
        'MiniMax-M2': { maxTokens: 8192, contextWindow: 204800 },
    },
    local: {
        'gemma3:4b': { maxTokens: 4096, contextWindow: 8192 },
        'functiongemma:latest': { maxTokens: 4096, contextWindow: 8192 },
    },
}


// ============================================
// OAuth Token Management
// ============================================

export class TokenManager {
    private authPath: string
    private tokens: Record<string, {
        access: string
        refresh: string
        expires: number
        projectId?: string
    }> = {}
    private refreshPromise: Promise<void> | null = null  // Mutex for token refresh

    constructor(authPath?: string) {
        if (authPath) {
            this.authPath = authPath
        } else {
            // Project-local auth only (no legacy .pi fallback)
            this.authPath = join(process.cwd(), '.nova-data', 'auth.json')
        }
        this.loadTokens()
    }

    private loadTokens(): void {
        if (existsSync(this.authPath)) {
            const data = JSON.parse(readFileSync(this.authPath, 'utf-8'))
            for (const [key, value] of Object.entries(data)) {
                const v = value as any
                this.tokens[key] = {
                    access: v.access,
                    refresh: v.refresh,
                    expires: v.expires,
                    projectId: v.projectId,
                }
            }
            console.log(`[TokenManager] ✓ ${Object.keys(this.tokens).length} Provider geladen`)
        }
    }

    private saveTokens(): void {
        const data: Record<string, any> = {}
        for (const [key, value] of Object.entries(this.tokens)) {
            data[key] = value
        }
        writeFileSync(this.authPath, JSON.stringify(data, null, 2))
    }

    async getToken(provider: string): Promise<{ token: string; projectId?: string }> {
        if (!this.tokens[provider]) {
            this.loadTokens()
        }
        const creds = this.tokens[provider]
        if (!creds) {
            throw new FailoverError(`Keine Auth für ${provider}. Führe /login aus.`, {
                reason: 'auth',
                provider,
            })
        }

        // Check expiry (5 min buffer) — use mutex to prevent parallel refreshes
        if (Date.now() > creds.expires - 5 * 60 * 1000) {
            if (this.refreshPromise) {
                // Another refresh is already in progress — wait for it
                console.log(`[TokenManager] ⏳ Waiting for ongoing ${provider} token refresh...`)
                await this.refreshPromise
            } else {
                // First caller triggers the refresh, others wait
                this.refreshPromise = this.refreshToken(provider)
                    .finally(() => { this.refreshPromise = null })
                await this.refreshPromise
            }
        }

        return { token: creds.access, projectId: creds.projectId }
    }

    private async refreshToken(provider: string): Promise<void> {
        const creds = this.tokens[provider]
        if (!creds?.refresh) throw new Error(`Kein Refresh-Token für ${provider}`)

        console.log(`[TokenManager] Refresh ${provider}...`)

        if (provider === 'local') {
            // Local providers use API keys, no refresh needed
            console.log(`[TokenManager] ⚠️ Local provider does not support token refresh`)
        }
        // Anthropic and OpenAI use API keys, no refresh needed
    }

    setApiKey(provider: string, apiKey: string): void {
        this.tokens[provider] = {
            access: apiKey,
            refresh: '',
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
        }
    }

    hasProvider(provider: string): boolean {
        return provider in this.tokens
    }
}

// ============================================
// Base Provider Class
// ============================================

abstract class LLMProvider extends EventEmitter {
    protected config: ProviderConfig
    protected tokenManager: TokenManager

    constructor(config: ProviderConfig, tokenManager: TokenManager) {
        super()
        this.config = config
        this.tokenManager = tokenManager
    }

    abstract complete(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse>
    abstract stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>
}

// ============================================
// Retry Logic (ported from pi-ai, tuned for rate limits)
// ============================================

const MAX_RETRIES = 5          // More retries for 429 errors
const BASE_DELAY_MS = 5000     // 5 seconds base (was 1s)

interface RetryInfo {
    shouldRetry: boolean
    errorType: 'rate_limit' | 'server_error' | 'network' | 'none'
    suggestedDelay?: number
}

function analyzeError(status: number, errorText: string): RetryInfo {
    // True rate limit (429)
    if (status === 429 || /resource.?exhausted|rate.?limit|quota/i.test(errorText)) {
        return { shouldRetry: true, errorType: 'rate_limit' }
    }

    // Server errors (transient, should retry quickly)
    if (status === 500 || status === 502 || status === 503 || status === 504) {
        return {
            shouldRetry: true,
            errorType: 'server_error',
            suggestedDelay: 2000  // Only 2s for server errors
        }
    }

    // Overloaded/unavailable (might be rate limit or server issue)
    if (/overloaded|service.?unavailable/i.test(errorText)) {
        return { shouldRetry: true, errorType: 'server_error', suggestedDelay: 3000 }
    }

    return { shouldRetry: false, errorType: 'none' }
}

// Legacy wrapper for backward compatibility
function isRetryableError(status: number, errorText: string): boolean {
    return analyzeError(status, errorText).shouldRetry
}

function extractRetryDelay(errorText: string): number | undefined {
    // Pattern: "Your quota will reset after Xs" or "reset after XhYmZs"
    const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i)
    if (durationMatch) {
        const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0
        const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0
        const seconds = parseFloat(durationMatch[3])
        if (!Number.isNaN(seconds)) {
            return Math.ceil(((hours * 60 + minutes) * 60 + seconds) * 1000 + 1000)
        }
    }
    // Pattern: "Please retry in Xs"
    const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i)
    if (retryInMatch?.[1]) {
        const value = parseFloat(retryInMatch[1])
        if (!Number.isNaN(value) && value > 0) {
            return Math.ceil((retryInMatch[2].toLowerCase() === 'ms' ? value : value * 1000) + 1000)
        }
    }
    return undefined
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================
// Legacy Cloud Provider (kept for OAuth token-based API access)
// ============================================

class LegacyCloudProvider extends LLMProvider {
    // Fallback endpoints: daily sandbox → autopush → prod (Issue #22522)
    private readonly ENDPOINTS = [
        'https://api.openai.com/v1',
        'https://api.openai.com/v1',
        'https://api.openai.com/v1',
    ]
    private readonly CLOUD_HEADERS = {
        'User-Agent': USER_AGENT,
        'X-Api-Client': API_CLIENT,
        'Client-Metadata': CLIENT_METADATA_JSON,
    }

    async complete(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse> {
        const { token, projectId } = await this.tokenManager.getToken('local')

        // Convert messages to cloud API format
        const contents = this.convertMessages(messages)

        // Build inner request (like pi-ai does)
        const innerRequest: any = {
            contents,
            generationConfig: {
                temperature: this.config.temperature ?? 0.7,
                maxOutputTokens: this.config.maxTokens ?? 8192,
            },
        }

        // Add tools if provided
        if (tools && tools.length > 0) {
            innerRequest.tools = [{
                functionDeclarations: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    // API expects JSON Schema format: { type: 'object', properties: {...} }
                    parameters: t.parameters.type === 'object' ? t.parameters : {
                        type: 'object',
                        properties: t.parameters.properties || t.parameters,
                        required: t.parameters.required || [],
                    },
                })),
            }]
        }

        // Wrap in outer request (like pi-ai does with buildRequest)
        const requestBody = {
            project: projectId,
            model: this.config.model,
            request: innerRequest,
            requestType: 'agent',
            userAgent: 'nova-core',
            requestId: `nova-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        }

        console.log(`[CloudLLM] Calling ${this.config.model} via cloud API...`)

        // Retry loop for rate limits and transient errors (with endpoint fallback)
        let lastError: Error | null = null
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // Use different endpoint on each retry (like pi-ai)
            const endpoint = this.ENDPOINTS[Math.min(attempt, this.ENDPOINTS.length - 1)]
            const url = `${endpoint}/v1internal:generateContent`

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        ...this.CLOUD_HEADERS,
                    },
                    body: JSON.stringify(requestBody),
                })

                if (response.ok) {
                    const data = await response.json() as any
                    return this.parseResponse(data)
                }

                const errorText = await response.text()

                // Check if retryable using analyzeError
                const errorInfo = analyzeError(response.status, errorText)
                if (attempt < MAX_RETRIES && errorInfo.shouldRetry) {
                    const serverDelay = extractRetryDelay(errorText)
                    const delayMs = serverDelay ?? errorInfo.suggestedDelay ?? BASE_DELAY_MS * Math.pow(2, attempt)
                    const errorLabel = errorInfo.errorType === 'rate_limit' ? 'Rate limited' : 'Server error'
                    console.log(`[CloudLLM] ${errorLabel} (${response.status}), retrying in ${Math.round(delayMs / 1000)}s... (${attempt + 1}/${MAX_RETRIES})`)
                    await sleep(delayMs)
                    continue
                }

                // Max retries exceeded or not retryable - throw FailoverError for model fallback
                const reason = classifyFailoverReason(errorText) ?? 'unknown'
                throw new FailoverError(`Cloud API error ${response.status}: ${errorText.slice(0, 200)}`, {
                    reason,
                    provider: 'local',
                    model: this.config.model,
                    status: response.status,
                })
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err))
                if (attempt < MAX_RETRIES && lastError.message.includes('fetch failed')) {
                    console.log(`[CloudLLM] Network error, retrying... (${attempt + 1}/${MAX_RETRIES})`)
                    await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
                    continue
                }
                throw lastError
            }
        }
        throw lastError ?? new Error('Failed after max retries')
    }

    async *stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk> {
        const { token, projectId } = await this.tokenManager.getToken('local')

        const contents = this.convertMessages(messages)

        const innerRequest: any = {
            contents,
            generationConfig: {
                temperature: this.config.temperature ?? 0.7,
                maxOutputTokens: this.config.maxTokens ?? 8192,
            },
        }

        // Wrap in outer request like pi-ai
        const requestBody = {
            project: projectId,
            model: this.config.model,
            request: innerRequest,
            requestType: 'agent',
            userAgent: 'nova-core',
            requestId: `nova-stream-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        }

        const url = `${this.ENDPOINTS[0]}/v1internal:streamGenerateContent?alt=sse`

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                ...this.CLOUD_HEADERS,
            },
            body: JSON.stringify(requestBody),
        })

        if (!response.ok) throw new Error(`Cloud stream error: ${response.status}`)
        if (!response.body) throw new Error('No response body')

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
                if (line.startsWith('data: ')) {
                    const json = line.slice(6)
                    if (json === '[DONE]') {
                        yield { done: true }
                        return
                    }
                    try {
                        const chunk = JSON.parse(json)
                        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
                        if (text) {
                            yield { content: text, done: false }
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
        }
        yield { done: true }
    }

    private convertMessages(messages: LLMMessage[]): any[] {
        const result: any[] = []

        // Handle system message
        const systemMsg = messages.find(m => m.role === 'system')
        if (systemMsg) {
            result.push({
                role: 'user',
                parts: [{ text: `[SYSTEM]\n${systemMsg.content}\n[/SYSTEM]` }],
            })
            result.push({
                role: 'model',
                parts: [{ text: 'Verstanden. Ich bin Nova ✨ und antworte auf Deutsch.' }],
            })
        }

        // Add other messages (with image support for Vision)
        for (const msg of messages.filter(m => m.role !== 'system')) {
            const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = []

            // Add text content
            if (msg.content) {
                parts.push({ text: msg.content })
            }

            // Add image if present (Vision mode)
            if (msg.image) {
                parts.push({
                    inlineData: {
                        mimeType: msg.image.mimeType,
                        data: msg.image.data,
                    }
                })
                console.log('[CloudLLM] 🖼️ Adding image to request')
            }

            result.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts,
            })
        }

        return result
    }

    private parseResponse(data: any): LLMResponse {
        // Cloudcode API wraps response in a "response" object
        const responseData = data.response || data
        const candidate = responseData.candidates?.[0]
        const parts = candidate?.content?.parts || []

        // Debug log to see what we got
        if (!candidate || parts.length === 0) {
            console.log('[CloudLLM] WARNING: Empty response from API')
            console.log('[CloudLLM] Response structure:', JSON.stringify(data).substring(0, 500))
        }

        let content = ''
        let reasoning = ''
        const toolCalls: ToolCall[] = []

        // DEBUG: Log parts to see if functionCall is present
        console.log(`[CloudLLM] parseResponse: ${parts.length} parts, types: ${parts.map((p: any) => Object.keys(p).join('+')).join(', ')}`)

        for (const part of parts) {
            if (part.text) {
                content += part.text
            }
            // Capture thinking/reasoning output
            // NOTE: thoughtSignature is an OPAQUE ENCRYPTED BLOB for context preservation
            // Only 'thought' and 'thinking' fields contain human-readable reasoning text
            if (part.thought || part.thinking) {
                const thought = part.thought || part.thinking
                if (typeof thought === 'string' && thought.length > 0) {
                    reasoning += thought
                    console.log(`[CloudLLM] 🧠 Reasoning captured: ${thought.length} chars`)
                }
            }
            // Store thoughtSignature for context but do NOT treat as displayable reasoning
            if (part.thoughtSignature) {
                console.log(`[CloudLLM] 📝 thoughtSignature received (${String(part.thoughtSignature).length} chars, opaque — not displayed)`)
            }
            if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {},
                })
            }
        }

        // Detect truncation: API returns MAX_TOKENS when output was cut off
        const apiFinishReason = candidate?.finishReason
        let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop'
        if (toolCalls.length > 0) finishReason = 'tool_calls'
        else if (apiFinishReason === 'MAX_TOKENS' || apiFinishReason === 'length') finishReason = 'length'

        if (finishReason === 'length') {
            console.log(`[CloudLLM] ⚠ Response truncated (MAX_TOKENS) — ${content.length} chars`)
        }

        return {
            content,
            reasoning: reasoning || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finishReason,
        }
    }
}

// ============================================
// Claude Provider
// ============================================

class ClaudeProvider extends LLMProvider {
    async complete(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse> {
        const { token } = await this.tokenManager.getToken('anthropic')

        // Convert messages
        const systemMsg = messages.find(m => m.role === 'system')?.content || ''
        const chatMessages = messages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
            }))

        const requestBody: any = {
            model: this.config.model,
            max_tokens: this.config.maxTokens ?? 8192,
            messages: chatMessages,
        }

        if (systemMsg) {
            requestBody.system = systemMsg
        }

        if (tools && tools.length > 0) {
            requestBody.tools = tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
            }))
        }

        console.log(`[Claude] Calling ${this.config.model}...`)

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
            const error = await response.text()
            throw new Error(`Claude API error ${response.status}: ${error}`)
        }

        const data = await response.json() as any
        return this.parseResponse(data)
    }

    async *stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk> {
        const { token } = await this.tokenManager.getToken('anthropic')

        const systemMsg = messages.find(m => m.role === 'system')?.content || ''
        const chatMessages = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

        const requestBody: any = {
            model: this.config.model,
            max_tokens: this.config.maxTokens ?? 8192,
            messages: chatMessages,
            stream: true,
        }
        if (systemMsg) requestBody.system = systemMsg

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(requestBody),
        })

        if (!response.ok || !response.body) throw new Error(`Claude stream error`)

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
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6))
                        if (data.type === 'content_block_delta') {
                            yield { content: data.delta?.text || '', done: false }
                        }
                    } catch { /* ignore */ }
                }
            }
        }
        yield { done: true }
    }

    private parseResponse(data: any): LLMResponse {
        let content = ''
        const toolCalls: ToolCall[] = []

        for (const block of data.content || []) {
            if (block.type === 'text') {
                content += block.text
            }
            if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: block.input,
                })
            }
        }

        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
        }
    }
}

// ============================================
// MiniMax Provider
// ============================================
class MiniMaxProvider extends LLMProvider {
    private minimaxLLM: any = null
    constructor(config: ProviderConfig, tokenManager: TokenManager) {
        super(config, tokenManager)
    }
    private getMiniMax(): any {
        if (!this.minimaxLLM) {
            this.minimaxLLM = createMiniMaxLLM({
                apiKey: this.config.apiKey || '',
                model: this.config.model,
                baseUrl: this.config.baseUrl || 'https://api.minimax.io/v1',
            })
        }
        return this.minimaxLLM
    }
    async complete(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse> {
        const llm = this.getMiniMax()
        const systemPrompt = messages.find(m => m.role === 'system')?.content as string | undefined
        const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
        }))
        const result = await llm.complete(chatMessages, {
            systemPrompt,
            maxTokens: this.config.maxTokens ?? 8192,
            temperature: this.config.temperature,
            tools,
            toolChoice: options?.toolChoice,
        })
        return {
            content: result.content,
            reasoning: result.reasoning,
            toolCalls: result.toolCalls,
            finishReason: (result.stopReason as any) || 'stop',
            usage: result.tokensUsed ? {
                promptTokens: result.promptTokens ?? 0,
                completionTokens: result.completionTokens ?? 0,
                totalTokens: result.tokensUsed,
            } : undefined,
        }
    }
    async *stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk> {
        const llm = this.getMiniMax()
        const systemPrompt = messages.find(m => m.role === 'system')?.content as string | undefined
        const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
        }))
        for await (const event of llm.stream(chatMessages, {
            systemPrompt,
            maxTokens: this.config.maxTokens ?? 8192,
            temperature: this.config.temperature,
        })) {
            if (event.done) {
                yield { done: true }
            } else {
                yield { content: event.content || '', done: false }
            }
        }
    }
}

// ============================================
// OpenAI Provider
// ============================================

class OpenAIProvider extends LLMProvider {
    private codexAdapter: CodexCLIAdapterType | null = null

    constructor(config: ProviderConfig, tokenManager: TokenManager) {
        super(config, tokenManager)
        // Try to initialize Codex CLI adapter for ChatGPT subscription
        try {
            if (codexCliModule && codexCliModule.isCodexAvailable() && codexCliModule.isCodexAuthenticated()) {
                this.codexAdapter = new codexCliModule.CodexCLIAdapter(config.model)
                console.log('[OpenAI] ✓ Codex CLI adapter loaded — ChatGPT subscription active')
            } else {
                console.log('[OpenAI] ⚠ Codex CLI not available or not authenticated')
            }
        } catch (e) {
            console.log('[OpenAI] ⚠ Codex CLI adapter init error:', (e as Error).message)
        }
    }

    async complete(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        const { token } = await this.tokenManager.getToken('openai')

        // If no API key, use Codex CLI directly
        if (!token || token === 'undefined') {
            if (this.codexAdapter) {
                return this.completeViaCodex(messages)
            }
            throw new Error('No OpenAI API key and Codex CLI not available')
        }

        const requestBody: any = {
            model: this.config.model,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
            })),
            max_tokens: this.config.maxTokens ?? 8192,
            temperature: this.config.temperature ?? 0.7,
        }

        if (tools && tools.length > 0) {
            requestBody.tools = tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            }))
        }

        console.log(`[OpenAI] Calling ${this.config.model}...`)

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            })

            if (!response.ok) {
                const error = await response.text()
                // Fallback to Codex CLI on auth/quota errors
                if ((response.status === 429 || response.status === 401) && this.codexAdapter) {
                    console.log(`[OpenAI] API returned ${response.status}, using Codex CLI proxy`)
                    return this.completeViaCodex(messages)
                }
                throw new Error(`OpenAI API error ${response.status}: ${error}`)
            }

            const data = await response.json() as any
            return this.parseResponse(data)
        } catch (err) {
            // Fallback to Codex CLI on network errors
            if (this.codexAdapter) {
                console.log('[OpenAI] API failed, using Codex CLI:', (err as Error).message?.slice(0, 80))
                return this.completeViaCodex(messages)
            }
            throw err
        }
    }

    private async completeViaCodex(messages: LLMMessage[]): Promise<LLMResponse> {
        if (!this.codexAdapter) throw new Error('Codex CLI not available')

        // Extract system prompt and user message
        const systemMsg = messages.find(m => m.role === 'system')
        const userMsgs = messages.filter(m => m.role === 'user')
        const lastUserMsg = userMsgs[userMsgs.length - 1]?.content || ''

        // Build context from conversation history
        const historyContext = messages
            .filter(m => m.role !== 'system')
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n')

        console.log(`[OpenAI] Using Codex CLI proxy for ${this.config.model}...`)

        const result = await this.codexAdapter.complete(
            historyContext || lastUserMsg,
            {
                systemPrompt: systemMsg?.content,
                model: this.config.model,
                timeoutMs: 120000,
            }
        )

        return {
            content: result.content,
            finishReason: 'stop',
            usage: result.tokensUsed ? {
                promptTokens: result.inputTokens || 0,
                completionTokens: result.outputTokens || 0,
                totalTokens: result.tokensUsed,
            } : undefined,
        }
    }

    async *stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk> {
        const { token } = await this.tokenManager.getToken('openai')

        // If no API key, use Codex CLI directly
        if (!token || token === 'undefined') {
            if (this.codexAdapter) {
                yield* this.streamViaCodex(messages)
                return
            }
            throw new Error('No OpenAI API key and Codex CLI not available')
        }

        const requestBody: any = {
            model: this.config.model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            stream: true,
        }

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            })

            if (!response.ok || !response.body) {
                if ((response.status === 429 || response.status === 401) && this.codexAdapter) {
                    console.log(`[OpenAI] Stream API returned ${response.status}, using Codex CLI`)
                    yield* this.streamViaCodex(messages)
                    return
                }
                throw new Error(`OpenAI stream error ${response.status}`)
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
                            if (content) yield { content, done: false }
                        } catch { /* ignore */ }
                    }
                }
            }
            yield { done: true }
        } catch (err) {
            if (this.codexAdapter) {
                console.log('[OpenAI] Stream failed, using Codex CLI:', (err as Error).message?.slice(0, 80))
                yield* this.streamViaCodex(messages)
                return
            }
            throw err
        }
    }

    private async *streamViaCodex(messages: LLMMessage[]): AsyncGenerator<StreamChunk> {
        if (!this.codexAdapter) throw new Error('Codex CLI not available')

        const systemMsg = messages.find(m => m.role === 'system')
        const userMsgs = messages.filter(m => m.role === 'user')
        const lastUserMsg = userMsgs[userMsgs.length - 1]?.content || ''

        for await (const text of this.codexAdapter.stream(lastUserMsg, {
            systemPrompt: systemMsg?.content,
            model: this.config.model,
        })) {
            yield { content: text, done: false }
        }
        yield { done: true }
    }

    private parseResponse(data: any): LLMResponse {
        const choice = data.choices?.[0]
        const message = choice?.message

        const toolCalls = message?.tool_calls?.map((tc: any) => {
            let args: Record<string, unknown> = {}
            try {
                args = JSON.parse(tc.function.arguments || '{}')
            } catch {
                // Malformed tool-arg JSON must not blow up the whole response.
                console.log(`[NovaLLM] ⚠️ Tool "${tc.function?.name}" had invalid JSON args — using {}`)
            }
            return { id: tc.id, name: tc.function.name, arguments: args }
        })

        return {
            content: message?.content || '',
            toolCalls,
            finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
            usage: data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined,
        }
    }
}

// ============================================
// Nova LLM Client (Main Interface)
// ============================================

export class NovaLLM {
    private tokenManager: TokenManager
    private provider: LLMProvider | null = null
    private currentConfig: ProviderConfig | null = null

    constructor(authPath?: string) {
        this.tokenManager = new TokenManager(authPath)
    }

    get modelId(): string | undefined { return this.currentConfig?.model }
    get providerId(): string | undefined { return this.currentConfig?.provider }

    configure(config: ProviderConfig): void {
        this.currentConfig = config

        switch (config.provider) {
            case 'openai':
                this.provider = new OpenAIProvider(config, this.tokenManager)
                break
            case 'claude':
                this.provider = new ClaudeProvider(config, this.tokenManager)
                break
            // Legacy cloud provider removed — OpenAI case is above
            case 'local':
                this.provider = new LocalLLMProvider(config, this.tokenManager)
                break
            case 'minimax':
                this.provider = new MiniMaxProvider(config, this.tokenManager)
                break
            default:
                throw new FailoverError(`Unknown provider: ${config.provider}`, {
                    reason: 'auth',
                    provider: config.provider,
                    model: config.model,
                })
        }

        // Show host when it's a remote (mesh) service — makes debugging easier
        let hostSuffix = ''
        if (config.baseUrl) {
            try {
                const u = new URL(config.baseUrl)
                if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
                    hostSuffix = ` @ ${u.hostname}`
                }
            } catch { /* ignore malformed URL */ }
        }
        console.log(`[NovaLLM] ✓ Configured: ${config.provider}/${config.model}${hostSuffix}`)
    }

    private async completeObserved(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions, failover = false): Promise<LLMResponse> {
        if (!this.provider) throw new Error('LLM nicht konfiguriert. Rufe configure() auf.')
        const provider = this.currentConfig?.provider || 'unknown'
        const model = this.currentConfig?.model || 'unknown'
        const startedAt = Date.now()
        return withSpan('nova.llm.complete', {
            'gen_ai.provider.name': provider,
            'gen_ai.request.model': model,
            'nova.llm.failover': failover,
            'nova.llm.message_count': messages.length,
            'nova.llm.tool_count': tools?.length || 0,
        }, async span => {
            try {
                const response = await this.provider!.complete(messages, tools, options)
                const usage = response.usage
                span.setAttribute('gen_ai.usage.input_tokens', usage?.promptTokens || 0)
                span.setAttribute('gen_ai.usage.output_tokens', usage?.completionTokens || 0)
                recordLlmRequest({
                    model, provider,
                    inputTokens: usage?.promptTokens || 0,
                    outputTokens: usage?.completionTokens || 0,
                    latencyMs: Date.now() - startedAt,
                    success: true,
                    failover,
                })
                return response
            } catch (error) {
                recordLlmRequest({ model, provider, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, success: false, failover })
                throw error
            }
        })
    }

    async complete(messages: LLMMessage[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse> {
        return this.completeObserved(messages, tools, options)
    }

    stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk> {
        if (!this.provider) throw new Error('LLM nicht konfiguriert.')
        return this.provider.stream(messages, tools)
    }

    getAvailableModels(provider: 'claude' | 'openai'): string[] {
        return Object.keys(MODEL_REGISTRY[provider] || {})
    }

    hasProvider(provider: string): boolean {
        return this.tokenManager.hasProvider(provider)
    }

    getCurrentConfig(): ProviderConfig | null {
        return this.currentConfig
    }

    // ============================================
    // Auto-Failover on Rate Limits
    // ============================================

    async completeWithFailover(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        if (!this.provider || !this.currentConfig) {
            throw new Error('LLM nicht konfiguriert.')
        }

        try {
            return await this.completeObserved(messages, tools)
        } catch (error) {
            const errorMsg = String(error)

            // Check for rate limit
            if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
                console.log(`[NovaLLM] Rate limited on ${this.currentConfig.model}, trying failover...`)

                // Try to import model router for failover
                try {
                    const { markRateLimited, getFailoverModel } = await import('../intelligence/model-router.js')

                    markRateLimited(this.currentConfig.model, 60000)
                    const fallbackModel = getFailoverModel(this.currentConfig.model)

                    if (fallbackModel) {
                        console.log(`[NovaLLM] Switching to fallback: ${fallbackModel}`)
                        this.configure({ ...this.currentConfig, model: fallbackModel })
                        return await this.completeObserved(messages, tools, undefined, true)
                    }
                } catch (routerError) {
                    console.log(`[NovaLLM] Model router not available: ${routerError}`)
                }
            }

            // Re-throw if no failover worked
            throw error
        }
    }
}

// ============================================
// Local LLM Provider (Ollama, LMStudio)
// ============================================

// ============================================
// Session-level model failure tracker
// Models that repeatedly fail (OOM, corrupted, crash) are blacklisted for the session.
// Permanent failures (known bad models) are skipped immediately.
// ============================================

const KNOWN_PERMANENT_FAILURES: Record<string, string> = {
    // OOM on MacBookPro 36GB — gemma4:26b needs ~52GB
    'gemma4:26b': 'OOM — model requires more VRAM than available',
    'gemma4:27b': 'OOM — model requires more VRAM than available',
    // Corrupted model file on MacMini
    'gemma4:e4b': 'Corrupted model file — hash mismatch',
    // MLX crash on macOS
    'qwen3.6:27b-nvfp4': 'MLX runtime crash on macOS',
    'qwen3.6:27b-mxfp8': 'Repeated OOM / timeout',
}

// modelKey → { failures, lastReason }
const sessionFailureMap = new Map<string, { failures: number; lastReason: string }>()
const SESSION_BLACKLIST_THRESHOLD = 2

function recordFailure(model: string, reason: string): void {
    const entry = sessionFailureMap.get(model) || { failures: 0, lastReason: '' }
    entry.failures++
    entry.lastReason = reason
    sessionFailureMap.set(model, entry)
    if (entry.failures >= SESSION_BLACKLIST_THRESHOLD) {
        console.log(`[LocalLLM] ⛔ Blacklisting ${model} for session (${entry.failures} failures: ${reason})`)
    }
}

function isBlacklisted(model: string): boolean {
    if (KNOWN_PERMANENT_FAILURES[model]) {
        console.log(`[LocalLLM] ⛔ Skip ${model}: ${KNOWN_PERMANENT_FAILURES[model]}`)
        return true
    }
    // Auto-disabled by ModelPerfDB (persistent failure pattern)
    try {
        if (isModelDisabled(model)) {
            console.log(`[LocalLLM] 🚫 Skip ${model}: auto-disabled by performance history`)
            return true
        }
    } catch { /* perf-db optional */ }
    const entry = sessionFailureMap.get(model)
    return !!entry && entry.failures >= SESSION_BLACKLIST_THRESHOLD
}

export function classifyLocalModelFailure(message: string): 'transient-timeout' | 'hard-failure' | 'soft-failure' {
    if (/timeout|timed out|aborted due to timeout/i.test(message)) return 'transient-timeout'
    const isOOM = /out.of.memory|oom|cuda.*out|memory.*insufficient|model.*too.large/i.test(message)
    const isCrash = /abort|sigkill|killed|process.*exit|mlx.*error|runtime.*error/i.test(message)
    const isCorrupt = /hash.*mismatch|corrupt|invalid.*model|unexpected.*end/i.test(message)
    return isOOM || isCrash || isCorrupt ? 'hard-failure' : 'soft-failure'
}

class LocalLLMProvider extends LLMProvider {
    private baseUrl: string
    private model: string
    private apiKey?: string   // set for external cloud providers (MiniMax, Kimi, DeepSeek, etc.)

    constructor(config: ProviderConfig, tokenManager: TokenManager) {
        super(config, tokenManager)
        // Default to Ollama
        this.baseUrl = (config as any).baseUrl || 'http://localhost:11434'
        this.model = config.model || 'llama3'
        this.apiKey = (config as any).apiKey
    }

    private stripProviderReasoning(content: string): string {
        let cleaned = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
        // Some reasoning templates omit the opening tag but still emit a closing
        // marker. Everything before the final marker is private chain-of-thought.
        const orphanedClose = cleaned.toLowerCase().lastIndexOf('</think>')
        if (orphanedClose >= 0) cleaned = cleaned.slice(orphanedClose + '</think>'.length)
        return cleaned.trim()
    }

    // ============================================
    // Shared message preprocessing (used by both complete() and stream())
    // Qwen3.5/vLLM chat template requirements:
    //   1. Exactly one system message at position 0
    //   2. tool role messages must keep role='tool' with tool_call_id (not mapped to 'user')
    //   3. assistant messages with tool_calls need the tool_calls array
    //   4. No consecutive messages of the same role
    //   5. No empty content
    // For Ollama: tool messages are converted to 'user [Tool result]: ...' (Ollama format)
    // ============================================
    private _buildChatMessages(messages: LLMMessage[]): any[] {
        const isOllama = this.baseUrl.includes('11434')

        // Step 1: convert each message preserving tool structure
        const rawMessages = messages.map(m => {
            const msg: any = { role: m.role, content: m.content || '' }

            // Assistant with tool calls — include tool_calls array (OpenAI format)
            if (m.role === 'assistant' && m.toolCalls?.length) {
                msg.tool_calls = m.toolCalls.map(tc => ({
                    id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                    type: 'function',
                    function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
                }))
                if (!msg.content) msg.content = ''
            }

            // Tool result — keep role='tool', add tool_call_id
            if (m.role === 'tool') {
                msg.tool_call_id = m.toolCallId || 'call_unknown'
            }

            // Ollama multimodal images
            if ((m as any).image?.data) {
                msg.images = [(m as any).image.data]
            }
            return msg
        })

        // Step 2: merge all system messages into one at position 0
        const systemParts = rawMessages.filter((m: any) => m.role === 'system').map((m: any) => m.content).filter(Boolean)
        const nonSystem = rawMessages.filter((m: any) => m.role !== 'system')

        // Step 3: deduplicate consecutive same-role messages (Qwen template rejects them)
        const deduped: any[] = []
        for (const msg of nonSystem) {
            const prev = deduped[deduped.length - 1]
            if (prev && prev.role === msg.role && msg.role === 'user') {
                prev.content = prev.content + '\n' + msg.content
            } else if (msg.content || msg.tool_calls || msg.role === 'tool') {
                deduped.push(msg)
            }
        }

        const chatMessages = systemParts.length > 0
            ? [{ role: 'system', content: systemParts.join('\n\n---\n\n') }, ...deduped]
            : deduped

        // For Ollama: convert tool-role messages to user messages (Ollama doesn't support tool role)
        if (isOllama) {
            return chatMessages.map((m: any) => {
                if (m.role === 'tool') {
                    return { role: 'user', content: `[Tool result]: ${m.content}` }
                }
                if (m.role === 'assistant' && m.tool_calls) {
                    return { role: 'assistant', content: m.content || JSON.stringify(m.tool_calls) }
                }
                return { role: m.role, content: m.content || '' }
            })
        }

        return chatMessages
    }

    async complete(
        messages: LLMMessage[],
        tools?: ToolDefinition[],
        options?: LLMCallOptions,
    ): Promise<LLMResponse> {
        const chatMessages = this._buildChatMessages(messages)

        const candidates = await this.getFailoverCandidates()
        let lastError: unknown

        const maxAttempts = Math.max(1, Math.min(candidates.length, options?.maxAttempts ?? candidates.length))
        for (let i = 0; i < maxAttempts; i++) {
            const candidate = candidates[i]

            // Skip session-blacklisted and known-permanently-failing models
            if (isBlacklisted(candidate.model)) continue

            try {
                // vLLM/large models (122B) need longer timeout for heavy system prompts
                const isLargeModel = /122b|70b|34b|32b|27b|35b/i.test(candidate.model)
                const timeout = options?.timeoutMs
                    ? Math.max(250, options.timeoutMs)
                    : i === 0 ? (isLargeModel ? 55_000 : 45_000) : 15_000
                return await this.completeAt(
                    candidate.baseUrl,
                    candidate.model,
                    chatMessages,
                    timeout,
                    candidate.apiKey,
                    tools,
                    undefined,
                    options?.maxTokens,
                )
            } catch (err) {
                lastError = err
                const errMsg = err instanceof Error ? err.message.slice(0, 200) : String(err)
                console.log(`[LocalLLM] ${candidate.model} at ${candidate.baseUrl} failed: ${errMsg}`)

                // Classify failure type for blacklisting
                const failureClass = classifyLocalModelFailure(errMsg)
                if (failureClass === 'hard-failure') {
                    // Hard failures — blacklist immediately (don't waste 2 attempts)
                    recordFailure(candidate.model, errMsg)
                    recordFailure(candidate.model, errMsg) // double to hit threshold
                } else if (failureClass === 'soft-failure') {
                    recordFailure(candidate.model, errMsg)
                }
            }
        }

        throw lastError instanceof Error ? lastError : new Error('No local LLM endpoint available')
    }

    private async getFailoverCandidates(): Promise<Array<{ baseUrl: string; model: string; apiKey?: string }>> {
        const candidates: Array<{ baseUrl: string; model: string; apiKey?: string }> = []

        const isChatModel = (model: string): boolean => {
            const lower = model.toLowerCase()
            // Embedding models — not generative
            if (/embed|nomic|bge|mxbai|e5-|gte-|instructor|minilm/.test(lower)) return false
            // Cloud-tag models go through cloud path, not local fallback
            if (/:cloud\b/.test(lower) || /\bcloud\b/.test(lower)) return false
            if (lower.includes('gemini')) return false
            // Vision-only models — not suitable for pure text tasks as fallback
            if (/^llava[^a-z]|minicpm-v/.test(lower)) return false
            // Voice synthesis models — not text chat
            if (lower.includes('-voice')) return false
            return true
        }

        // Only use localhost if it was confirmed available at startup
        const isLocalhostAvailable = (baseUrl: string): boolean => {
            // An endpoint explicitly supplied to this provider is authoritative.
            // Discovery may finish later than client construction on fast/node-only
            // boots; suppressing the configured endpoint leaves no candidate at all.
            if (baseUrl === this.baseUrl) return true
            if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) return true
            // Check if it's a known-available endpoint
            try {
                const { availableLLMs } = require('../core/llm-factory.js')
                return availableLLMs.some((e: any) => e.endpoint && (e.endpoint.includes('localhost') || e.endpoint.includes('127.0.0.1')))
            } catch { return false }
        }

        if (isChatModel(this.model) && isLocalhostAvailable(this.baseUrl)) {
            candidates.push({ baseUrl: this.baseUrl, model: this.model, apiKey: this.apiKey })
        }

        // Priority 1: model-resolver's best pick (may be on a mesh node or external cloud)
        if (process.env.NOVA_SKIP_MODEL_RESOLVER_INIT !== '1') {
            try {
                const { resolveModel } = await import('../core/model-resolver.js')
                const resolved = await resolveModel('chat')
                if (resolved?.endpoint && isChatModel(resolved.id)) {
                    candidates.push({ baseUrl: resolved.endpoint, model: resolved.id, apiKey: resolved.apiKey })
                    console.log(`[LocalLLM] Resolver candidate: ${resolved.id} @ ${resolved.endpoint}${resolved.apiKey ? ' [ext-key]' : ''}`)
                }
            } catch { /* resolver optional */ }
        }

        // Priority 2: configured primary (this.baseUrl / this.model) — skip if already added
        // Include apiKey from config so external providers work without re-resolving
        // Priority 3: other discovered LLMs (llm-factory — legacy fallback)
        try {
            const { availableLLMs } = await import('../core/llm-factory.js')
            const discovered = availableLLMs.filter(entry =>
                entry.endpoint &&
                isLocalhostAvailable(entry.endpoint) &&
                (
                    entry.local ||
                    ['local', 'ollama', 'lmstudio', 'lm-studio', 'vllm', 'llamacpp', 'llama-cpp'].includes(String(entry.provider).toLowerCase())
                ) && isChatModel(entry.model)
            )

            for (const entry of discovered.filter(e => e.model === this.model)) {
                candidates.push({ baseUrl: entry.endpoint!, model: entry.model })
            }
            for (const entry of discovered.filter(e => e.model !== this.model)) {
                candidates.push({ baseUrl: entry.endpoint!, model: entry.model })
            }
        } catch { /* discovery is optional */ }

        const seen = new Set<string>()
        return candidates.filter(candidate => {
            const key = `${candidate.baseUrl}|${candidate.model}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
    }

    private async completeAt(
        baseUrl: string,
        model: string,
        chatMessages: any[],
        timeoutMs = 15_000,
        apiKey?: string,
        tools?: ToolDefinition[],
        taskType?: string,
        maxTokens?: number,
    ): Promise<LLMResponse> {
        const isOllama = baseUrl.includes('11434')

        console.log(`[LocalLLM] Calling ${model} at ${baseUrl}${apiKey ? ' [auth]' : ''}`)
        const callStart = Date.now()

        // Each individual attempt gets its own abort signal so a hung model doesn't
        // block the fallback loop — the outer withTimeout() in nova-runner is the hard cap.
        const signal = AbortSignal.timeout(timeoutMs)

        if (isOllama) {
            // Ollama API — chatMessages already converted by _buildChatMessages()
            const requestBody: any = { model, messages: chatMessages, stream: false }
            if (maxTokens) requestBody.options = { num_predict: maxTokens }
            if (tools?.length) {
                requestBody.tools = tools.map(tool => ({
                    type: 'function',
                    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                }))
            }
            const response = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal,
            })

            if (!response.ok) {
                const error = await response.text()
                throw new Error(`Ollama error (${response.status}): ${error}`)
            }

            const data = await response.json() as any
            const ollamaToolCalls = (data.message?.tool_calls || []).map((call: any, index: number) => ({
                id: call.id || `ollama-tool-${index}`,
                name: call.function?.name || call.name || '',
                arguments: call.function?.arguments || call.arguments || {},
            }))
            const result = {
                content: data.message?.content || '',
                finishReason: ollamaToolCalls.length ? 'tool_calls' as const : 'stop' as const,
                toolCalls: ollamaToolCalls.length ? ollamaToolCalls : undefined,
            }
            recordModelCall(model, taskType || 'chat', Date.now() - callStart, !!result.content)
            return result
        } else {
            // OpenAI-compatible API (LMStudio, vLLM, external cloud providers)
            // Use apiKey from resolver (external providers) or OPENAI_API_KEY env as fallback
            const authKey = apiKey || process.env.OPENAI_API_KEY || ''
            const authHeaders: Record<string, string> = authKey
                ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authKey}` }
                : { 'Content-Type': 'application/json' }

            // Build endpoint — some external APIs already include /v1 in baseUrl
            const endpoint = baseUrl.endsWith('/v1') || baseUrl.includes('/v1/')
                ? `${baseUrl}/chat/completions`
                : `${baseUrl}/v1/chat/completions`

            const requestBody: any = {
                model,
                messages: chatMessages,
                max_tokens: maxTokens || (tools?.length ? 2048 : 4096),
                temperature: 0.2,
            }
            if (tools?.length) {
                requestBody.tools = tools.map(tool => ({
                    type: 'function',
                    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                }))
                requestBody.tool_choice = 'auto'
            }
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify(requestBody),
                signal,
            })

            if (!response.ok) {
                const error = await response.text()
                recordModelCall(model, taskType || 'chat', Date.now() - callStart, false)
                throw new Error(`LLM API error (${response.status}): ${error.slice(0, 200)}`)
            }

            const data = await response.json() as any
            const message = data.choices?.[0]?.message || {}
            const content = this.stripProviderReasoning(message.content || '')
            const toolCalls = (message.tool_calls || []).map((call: any, index: number) => {
                let args: Record<string, unknown> = {}
                try {
                    args = typeof call.function?.arguments === 'string'
                        ? JSON.parse(call.function.arguments || '{}')
                        : (call.function?.arguments || call.arguments || {})
                } catch { /* tool policy and schema validation handle empty args */ }
                return { id: call.id || `local-tool-${index}`, name: call.function?.name || call.name || '', arguments: args }
            })
            recordModelCall(model, taskType || 'chat', Date.now() - callStart, !!content)
            return {
                content,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                finishReason: toolCalls.length ? 'tool_calls' : (data.choices?.[0]?.finish_reason || 'stop'),
            }
        }
    }

    async *stream(messages: LLMMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamChunk> {
        // Use the same message preprocessing as complete() — fixes tool-role handling for vLLM/Qwen
        const chatMessages = this._buildChatMessages(messages)
        const isOllama = this.baseUrl.includes('11434')

        const endpoint = isOllama
            ? `${this.baseUrl}/api/chat`
            : (this.baseUrl.endsWith('/v1') || this.baseUrl.includes('/v1/')
                ? `${this.baseUrl}/chat/completions`
                : `${this.baseUrl}/v1/chat/completions`)

        const authKey = this.apiKey || process.env.OPENAI_API_KEY || ''
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (authKey) headers['Authorization'] = `Bearer ${authKey}`

        // Build request body (include tools if provided — e.g. for vLLM function calling via stream)
        const requestBody: any = { model: this.model, messages: chatMessages, stream: true }
        if (tools && tools.length > 0 && !isOllama) {
            requestBody.tools = tools.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
        })

        if (!response.ok || !response.body) {
            throw new Error(`Local LLM stream error: ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        // Buffer for accumulating tool_call deltas (OpenAI SSE format)
        const toolCallBuffers: Record<number, { id: string; name: string; arguments: string }> = {}
        let lineBuffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            lineBuffer += decoder.decode(value, { stream: true })
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop() || ''

            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed) continue
                try {
                    if (trimmed.startsWith('data: ')) {
                        const json = trimmed.slice(6)
                        if (json === '[DONE]') {
                            // Flush any accumulated tool calls before done
                            for (const tc of Object.values(toolCallBuffers)) {
                                try {
                                    yield { toolCall: { id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments || '{}') }, done: false }
                                } catch { /* incomplete JSON args — skip */ }
                            }
                            yield { done: true }
                            return
                        }
                        const data = JSON.parse(json)
                        const delta = data.choices?.[0]?.delta
                        if (delta?.content) yield { content: delta.content, done: false }
                        // Accumulate tool_call argument deltas (streaming function calls)
                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx: number = tc.index ?? 0
                                if (!toolCallBuffers[idx]) {
                                    toolCallBuffers[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' }
                                }
                                if (tc.id) toolCallBuffers[idx].id = tc.id
                                if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name
                                if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments
                            }
                        }
                    } else if (!trimmed.startsWith(':')) {
                        // Ollama non-SSE format
                        const data = JSON.parse(trimmed)
                        if (data.message?.content) yield { content: data.message.content, done: false }
                        if (data.done === true) {
                            yield { done: true }
                            return
                        }
                    }
                } catch { /* skip invalid / incomplete lines */ }
            }
        }

        // Flush accumulated tool calls (if stream ended without [DONE])
        for (const tc of Object.values(toolCallBuffers)) {
            try {
                yield { toolCall: { id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments || '{}') }, done: false }
            } catch { /* incomplete JSON args */ }
        }
        yield { done: true }
    }
}

// ============================================
// Factory & Global Instance
// ============================================

let novaLLM: NovaLLM | null = null

export function getNovaLLM(): NovaLLM {
    if (!novaLLM) {
        novaLLM = new NovaLLM()
    }
    return novaLLM
}

export async function createNovaLLMClient(config: {
    provider?: 'claude' | 'openai' | 'local' | 'minimax'
    model?: string
    role?: 'chat' | 'vision' | 'code' | 'reasoning' | 'small' | 'embedding'
    baseUrl?: string
    apiKey?: string
    /** Per-run client for concurrent rooms/bots; avoids mutating the legacy singleton. */
    isolated?: boolean
}): Promise<NovaLLM> {
    const llm = config.isolated ? new NovaLLM() : getNovaLLM()

    let model = config.model
    let provider = config.provider
    let baseUrl: string | undefined = config.baseUrl
    let resolvedApiKey: string | undefined = config.apiKey

    // CLOUD PROVIDERS never get hijacked by local discovery — they keep their
    // explicit provider + endpoint no matter what the resolver/discovery says.
    const CLOUD = new Set(['minimax', 'openai', 'anthropic', 'claude', 'openrouter', 'groq'])
    const isCloud = CLOUD.has(String(provider).toLowerCase())

    // Resolve 'auto' or undefined model via the capability scanner — but NOT for cloud providers
    if ((!model || model === 'auto') && !isCloud) {
        try {
            const { resolveModel } = await import('../core/model-resolver.js')
            const role = config.role || (provider === 'openai' ? 'chat' : 'chat')
            const resolved = await resolveModel(role)
            if (resolved) {
                model = resolved.id
                // Auto-detect provider from resolver. CRITICAL: cloud providers
                // (minimax/openai/anthropic) must map to their real provider —
                // NOT 'local'. The old `else provider = 'local'` catch-all turned
                // a resolved MiniMax-M3 into "local/MiniMax-M3", which then hit the
                // local adapter and failed with "No local LLM endpoint available"
                // (broke L6 summaries + orchestrator sub-agents).
                if (!provider || provider === 'local') {
                    const rp = String(resolved.provider).toLowerCase()
                    if (rp === 'openai' || rp === 'openai-codex') provider = 'openai'
                    else if (rp === 'minimax') provider = 'minimax'
                    else if (rp === 'anthropic' || rp === 'claude') provider = 'claude'
                    else provider = 'local'  // ollama / lm-studio / llama-cpp / vllm
                }
                // Use endpoint from resolver (correct host/port)
                if (resolved.endpoint) baseUrl = resolved.endpoint
                // Carry apiKey for external cloud providers
                if (resolved.apiKey) resolvedApiKey = resolved.apiKey
            }
        } catch {
            model = model || 'auto'
        }
    }

    // vLLM/Ollama endpoint hijack — ONLY for genuinely local providers, never cloud
    if (!baseUrl && !isCloud && provider === 'local' && model && model !== 'auto') {
        try {
            const { availableLLMs } = await import('../core/llm-factory.js')
            const match = availableLLMs.find((entry) =>
                entry.model === model &&
                entry.endpoint &&
                (entry.local || ['local', 'ollama', 'lmstudio', 'lm-studio', 'vllm', 'llamacpp', 'llama-cpp'].includes(String(entry.provider).toLowerCase()))
            )
            if (match?.endpoint) baseUrl = match.endpoint
        } catch { /* discovery is optional */ }
    }

    // Cloud providers need an API key. The model-resolver returns the configured
    // primary (e.g. minimax/MiniMax-M3) WITHOUT a key, so callers like L6 summary
    // and orchestrator sub-agents that pass {} would otherwise 401. Fill the key
    // (and base URL) from xaventra.config.json when missing.
    if (!resolvedApiKey && (provider === 'minimax' || provider === 'openai' || provider === 'claude')) {
        try {
            // Use the disk-backed factory config. core/config's singleton is
            // populated only by daemon startup and returns schema defaults in
            // standalone/background workers, which dropped cloud API keys.
            const { getNovaConfig } = await import('../core/llm-factory.js')
            const cfg: any = getNovaConfig()
            const providers = cfg?.providers || {}
            if (provider === 'minimax') {
                resolvedApiKey = providers.minimax?.apiKey || cfg?.apis?.minimax_key
                if (!baseUrl && providers.minimax?.baseUrl) baseUrl = providers.minimax.baseUrl
            } else if (provider === 'openai') {
                resolvedApiKey = cfg?.auth?.openaiApiKey || providers.openai?.apiKey || cfg?.apis?.openai_key
            } else if (provider === 'claude') {
                resolvedApiKey = providers.anthropic?.apiKey || cfg?.apis?.anthropic_key
            }
        } catch { /* config unavailable — provider may still have env-based auth */ }
    }

    // A resolver recommendation is not an availability proof. The configured
    // MiniMax primary can be returned even when no API key is installed. Never
    // issue a doomed cloud request: prefer a recently verified mesh runtime and
    // otherwise fail through local-auto without touching the MiniMax endpoint.
    if (provider === 'minimax' && !resolvedApiKey) {
        let localFallback: { endpoint: string; model: string } | undefined
        try {
            const { getCapabilityGraph } = await import('../mesh/capability-graph.js')
            const now = Date.now()
            const candidates = getCapabilityGraph().getSnapshot().nodes.flatMap(node => node.runtimes.flatMap(runtime => {
                const age = now - Date.parse(runtime.verifiedAt)
                if (runtime.status !== 'running' || !Number.isFinite(age) || age > 5 * 60_000 || !runtime.endpoint) return []
                const chatModel = runtime.models.find(candidate => !/embed|nomic|bge|mxbai|voice/i.test(candidate))
                return chatModel ? [{ endpoint: runtime.endpoint, model: chatModel, score: (node.status === 'online' ? 10 : 0) - age / 10_000 }] : []
            })).sort((a, b) => b.score - a.score)
            localFallback = candidates[0]
        } catch { /* capability graph is optional during very early boot */ }

        provider = 'local'
        model = localFallback?.model || 'auto'
        baseUrl = localFallback?.endpoint
        const state = (globalThis as any).__novaState
        if (state) {
            state.providerHealth = {
                ...(state.providerHealth || {}),
                minimax: { status: 'unavailable', reason: 'missing_api_key', fallback: localFallback || 'local-auto' },
            }
        }
        console.log(`[NovaLLM] MiniMax ohne API-Key übersprungen -> ${localFallback ? `${localFallback.model} @ ${localFallback.endpoint}` : 'local-auto'}`)
    }

    const providerConfig: any = {
        provider: provider || 'local',
        model: model || 'auto',
    }
    if (baseUrl) providerConfig.baseUrl = baseUrl
    if (resolvedApiKey) providerConfig.apiKey = resolvedApiKey

    llm.configure(providerConfig)
    return llm
}

export default {
    NovaLLM,
    getNovaLLM,
    createNovaLLMClient,
    MODEL_REGISTRY,
}
