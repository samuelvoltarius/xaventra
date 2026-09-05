/**
 * Nova — Trace-based Learning (inspired by OpenJarvis)
 *
 * Records every agent invocation as a structured Trace:
 * model used, tool calls with latency, token estimates, success/error.
 * Traces are written as append-only JSONL to .nova-data/traces/<date>.jsonl
 * and analyzed hourly by trace-analyzer.ts to produce routing insights.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface TraceToolCall {
    name: string
    argsHash: string       // SHA-256(JSON.stringify(args)).slice(0,12) — for cache candidate detection
    latencyMs: number
    success: boolean
    errorMessage?: string
    resultSize: number     // chars
}

export interface NovaTrace {
    id: string                   // trace_<timestamp>_<random>
    sessionId: string
    userId: string
    channel: string
    timestamp: number

    // Input
    userMessage: string          // first 300 chars
    messageLength: number
    hasImage: boolean

    // Routing
    modelUsed: string            // e.g. 'gpt-5.3-codex'
    provider: string             // 'openai' | 'ollama' | 'mesh' | 'unknown'
    taskType: string             // 'chat' | 'code' | 'reasoning' | 'search' | 'system'

    // LLM Performance
    llmLatencyMs: number
    inputTokensEst: number       // Math.ceil(messageLength / 4)
    outputTokensEst: number      // Math.ceil(responseLength / 4)
    selfHealingRetries: number

    // Tool Calls
    toolCalls: TraceToolCall[]
    totalToolLatencyMs: number

    // Outcome
    success: boolean
    errorType?: 'quota' | 'auth' | 'timeout' | 'tool_error' | 'loop' | 'general'
    totalLatencyMs: number
    responseLength: number
}

// ============================================
// In-progress trace (mutable during request)
// ============================================

export interface ActiveTrace {
    id: string
    sessionId: string
    userId: string
    channel: string
    startedAt: number
    userMessage: string
    messageLength: number
    hasImage: boolean
    modelUsed: string
    provider: string
    taskType: string
    llmStartedAt?: number
    llmFinishedAt?: number
    toolCalls: TraceToolCall[]
    selfHealingRetries: number
    activeToolStart?: { name: string; argsHash: string; startedAt: number }
}

// ============================================
// Helpers
// ============================================

function hashArgs(args: Record<string, unknown>): string {
    try {
        return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12)
    } catch {
        return 'unknown'
    }
}

function detectTaskType(message: string): string {
    const lower = message.toLowerCase()
    if (/\b(code|script|function|write|implement|build|fix|bug|error)\b/.test(lower)) return 'code'
    if (/\b(search|find|google|web|news|aktuell|current)\b/.test(lower)) return 'search'
    if (/\b(analyze|analyse|why|reason|explain|vergleich|compare)\b/.test(lower)) return 'reasoning'
    if (/\b(ssh|server|deploy|restart|kill|process|system|run)\b/.test(lower)) return 'system'
    return 'chat'
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
}

const DATA_DIR = join(process.cwd(), '.nova-data', 'traces')

function getTracePath(): string {
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    return join(DATA_DIR, `${date}.jsonl`)
}

function writeTrace(trace: NovaTrace): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        appendFileSync(getTracePath(), JSON.stringify(trace) + '\n', 'utf-8')
    } catch (err) {
        console.warn('[Trace] Failed to write trace:', err)
    }
}

// ============================================
// TraceRecorder — singleton
// ============================================

class TraceRecorder {
    private active = new Map<string, ActiveTrace>()

    /** Call at the start of runNovaAgent() */
    start(opts: {
        sessionId: string
        userId: string
        channel: string
        userMessage: string
        hasImage: boolean
        modelUsed: string
        provider: string
    }): string {
        const id = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        this.active.set(id, {
            id,
            sessionId: opts.sessionId,
            userId: opts.userId,
            channel: opts.channel,
            startedAt: Date.now(),
            userMessage: opts.userMessage.slice(0, 300),
            messageLength: opts.userMessage.length,
            hasImage: opts.hasImage,
            modelUsed: opts.modelUsed,
            provider: opts.provider,
            taskType: detectTaskType(opts.userMessage),
            toolCalls: [],
            selfHealingRetries: 0,
        })
        return id
    }

    /** Call just before llmClient.complete() */
    llmCallStart(traceId: string): void {
        const t = this.active.get(traceId)
        if (t) t.llmStartedAt = Date.now()
    }

    /** Call right after llmClient.complete() returns */
    llmCallEnd(traceId: string): void {
        const t = this.active.get(traceId)
        if (t) t.llmFinishedAt = Date.now()
    }

    /** Call just before registry.execute(toolName, args) */
    toolStart(traceId: string, toolName: string, args: Record<string, unknown>): void {
        const t = this.active.get(traceId)
        if (t) {
            t.activeToolStart = { name: toolName, argsHash: hashArgs(args), startedAt: Date.now() }
        }
    }

    /** Call right after tool returns (success or error) */
    toolEnd(traceId: string, success: boolean, resultSize: number, errorMessage?: string): void {
        const t = this.active.get(traceId)
        if (!t?.activeToolStart) return
        const latencyMs = Date.now() - t.activeToolStart.startedAt
        t.toolCalls.push({
            name: t.activeToolStart.name,
            argsHash: t.activeToolStart.argsHash,
            latencyMs,
            success,
            errorMessage,
            resultSize,
        })
        t.activeToolStart = undefined
    }

    /** Increment self-healing retry counter */
    recordRetry(traceId: string): void {
        const t = this.active.get(traceId)
        if (t) t.selfHealingRetries++
    }

    /** Update model if it was switched mid-run */
    updateModel(traceId: string, modelUsed: string, provider: string): void {
        const t = this.active.get(traceId)
        if (t) { t.modelUsed = modelUsed; t.provider = provider }
    }

    /** Call at the very end of runNovaAgent() — writes to disk */
    finish(traceId: string, opts: {
        success: boolean
        responseContent: string
        errorType?: NovaTrace['errorType']
    }): void {
        const t = this.active.get(traceId)
        if (!t) return
        this.active.delete(traceId)

        const now = Date.now()
        const llmLatencyMs = (t.llmStartedAt && t.llmFinishedAt)
            ? t.llmFinishedAt - t.llmStartedAt
            : 0
        const totalToolLatencyMs = t.toolCalls.reduce((s, c) => s + c.latencyMs, 0)

        const trace: NovaTrace = {
            id: t.id,
            sessionId: t.sessionId,
            userId: t.userId,
            channel: t.channel,
            timestamp: t.startedAt,
            userMessage: t.userMessage,
            messageLength: t.messageLength,
            hasImage: t.hasImage,
            modelUsed: t.modelUsed || 'unknown',
            provider: t.provider || 'unknown',
            taskType: t.taskType,
            llmLatencyMs,
            inputTokensEst: estimateTokens(t.userMessage),
            outputTokensEst: estimateTokens(opts.responseContent),
            selfHealingRetries: t.selfHealingRetries,
            toolCalls: t.toolCalls,
            totalToolLatencyMs,
            success: opts.success,
            errorType: opts.errorType,
            totalLatencyMs: now - t.startedAt,
            responseLength: opts.responseContent.length,
        }

        writeTrace(trace)
    }
}

// Process-level singleton
let _recorder: TraceRecorder | null = null

export function getTraceRecorder(): TraceRecorder {
    if (!_recorder) _recorder = new TraceRecorder()
    return _recorder
}
