/**
 * Nova Request Tracer
 *
 * Assigns unique trace IDs to each incoming message for log correlation.
 * Lightweight — no external dependencies.
 */

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TraceStage {
    name: string
    elapsedMs: number
    durationMs: number
}

export interface RequestTrace {
    traceId: string
    channel: string
    userId: string
    startTime: number
    contentPreview: string
    lastStepAt: number
    stages: TraceStage[]
}

// Active traces (cleared after completion)
const activeTraces = new Map<string, RequestTrace>()
const completedTraces: Array<RequestTrace & { durationMs: number }> = []
const traceContext = new AsyncLocalStorage<string>()
const MAX_COMPLETED_TRACES = 200

/**
 * Start a new trace for an incoming message.
 * Returns the trace ID.
 */
export function startTrace(channel: string, userId: string, content: string): string {
    const traceId = randomUUID().slice(0, 8)
    activeTraces.set(traceId, {
        traceId,
        channel,
        userId,
        startTime: Date.now(),
        contentPreview: content.slice(0, 80),
        lastStepAt: Date.now(),
        stages: [],
    })
    return traceId
}

/**
 * End a trace and log timing.
 */
export function endTrace(traceId: string): void {
    const trace = activeTraces.get(traceId)
    if (!trace) return
    const durationMs = Date.now() - trace.startTime
    completedTraces.push({ ...trace, stages: [...trace.stages], durationMs })
    if (completedTraces.length > MAX_COMPLETED_TRACES) completedTraces.shift()
    console.log(`[Trace:${traceId}] ${trace.channel}/${trace.userId} — ${durationMs}ms — "${trace.contentPreview}"`)
    activeTraces.delete(traceId)
}

/**
 * Get trace info (for injecting into logs).
 */
export function getTrace(traceId: string): RequestTrace | undefined {
    return activeTraces.get(traceId)
}

/**
 * Get all active trace IDs (for debugging stuck requests).
 */
export function getActiveTraces(): RequestTrace[] {
    return Array.from(activeTraces.values())
}

/**
 * Log a step within a trace.
 */
export function traceLog(traceId: string, step: string): void {
    const trace = activeTraces.get(traceId)
    if (!trace) return
    const elapsed = Date.now() - trace.startTime
    const durationMs = Date.now() - trace.lastStepAt
    trace.lastStepAt = Date.now()
    trace.stages.push({ name: step, elapsedMs: elapsed, durationMs })
    console.debug(`[Trace:${traceId}][+${elapsed}ms] ${step}`)
}

export function runWithTrace<T>(traceId: string, fn: () => T): T {
    return traceContext.run(traceId, fn)
}

export function traceStep(step: string): void {
    const traceId = traceContext.getStore()
    if (traceId) traceLog(traceId, step)
}

export function getTraceStats(): {
    completed: number
    active: number
    averageMs: number
    p95Ms: number
    slowestStages: Array<{ name: string; averageMs: number; samples: number }>
} {
    const durations = completedTraces.map(t => t.durationMs).sort((a, b) => a - b)
    const stageTotals = new Map<string, { total: number; samples: number }>()
    for (const trace of completedTraces) {
        for (const stage of trace.stages) {
            const current = stageTotals.get(stage.name) ?? { total: 0, samples: 0 }
            current.total += stage.durationMs
            current.samples++
            stageTotals.set(stage.name, current)
        }
    }
    return {
        completed: completedTraces.length,
        active: activeTraces.size,
        averageMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
        p95Ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0,
        slowestStages: Array.from(stageTotals, ([name, value]) => ({
            name,
            averageMs: Math.round(value.total / value.samples),
            samples: value.samples,
        })).sort((a, b) => b.averageMs - a.averageMs).slice(0, 10),
    }
}
