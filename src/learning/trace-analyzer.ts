/**
 * Nova — Trace Analyzer
 *
 * Reads the last 7 days of traces from .nova-data/traces/*.jsonl
 * and produces routing insights:
 * - Slowest tools (avg latency, error rate)
 * - Best model per task type
 * - Tool cache candidates (same args → same result, reoccurring)
 * - Overall performance summary
 *
 * Insights are written to .nova-data/trace-insights.json
 * and read by L20 / nova_trace_stats tool.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NovaTrace } from './trace.js'

const DATA_DIR = join(process.cwd(), '.nova-data', 'traces')
const INSIGHTS_PATH = join(process.cwd(), '.nova-data', 'trace-insights.json')

// ============================================
// Types
// ============================================

export interface ToolInsight {
    name: string
    callCount: number
    avgLatencyMs: number
    p95LatencyMs: number
    errorRate: number        // 0–1
    avgResultSize: number
    cacheCandidates: number  // times same argsHash appeared
}

export interface ModelInsight {
    modelId: string
    provider: string
    callCount: number
    avgLlmLatencyMs: number
    avgTotalLatencyMs: number
    successRate: number
    taskTypes: Record<string, number>   // taskType → count
}

export interface TraceInsights {
    generatedAt: number
    tracesAnalyzed: number
    periodDays: number

    overall: {
        avgTotalLatencyMs: number
        avgLlmLatencyMs: number
        avgToolLatencyMs: number
        successRate: number
        avgToolCallsPerRequest: number
        avgSelfHealingRetries: number
    }

    tools: ToolInsight[]           // sorted by callCount desc
    models: ModelInsight[]         // sorted by callCount desc

    slowestTools: string[]         // top 5 by avg latency
    mostFailingTools: string[]     // top 5 by error rate
    cacheCandidates: string[]      // tools that repeatedly get same args

    recommendations: string[]      // human-readable suggestions for L20
}

// ============================================
// Loader
// ============================================

function loadTraces(days = 7): NovaTrace[] {
    if (!existsSync(DATA_DIR)) return []

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const traces: NovaTrace[] = []

    try {
        const files = readdirSync(DATA_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .sort()
            .slice(-days) // at most last `days` files

        for (const file of files) {
            const raw = readFileSync(join(DATA_DIR, file), 'utf-8')
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue
                try {
                    const t = JSON.parse(line) as NovaTrace
                    if (t.timestamp >= cutoff) traces.push(t)
                } catch { /* skip malformed line */ }
            }
        }
    } catch { /* ignore */ }

    return traces
}

// ============================================
// Analysis
// ============================================

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1)
    return sorted[idx]
}

export function analyzeTraces(days = 7): TraceInsights {
    const traces = loadTraces(days)

    if (traces.length === 0) {
        return {
            generatedAt: Date.now(),
            tracesAnalyzed: 0,
            periodDays: days,
            overall: { avgTotalLatencyMs: 0, avgLlmLatencyMs: 0, avgToolLatencyMs: 0, successRate: 0, avgToolCallsPerRequest: 0, avgSelfHealingRetries: 0 },
            tools: [], models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: ['Noch keine Trace-Daten vorhanden.'],
        }
    }

    // Overall stats
    const successes = traces.filter(t => t.success).length
    const avgTotalLatencyMs = Math.round(traces.reduce((s, t) => s + t.totalLatencyMs, 0) / traces.length)
    const avgLlmLatencyMs = Math.round(traces.reduce((s, t) => s + t.llmLatencyMs, 0) / traces.length)
    const avgToolLatencyMs = Math.round(traces.reduce((s, t) => s + t.totalToolLatencyMs, 0) / traces.length)
    const avgToolCallsPerRequest = +(traces.reduce((s, t) => s + t.toolCalls.length, 0) / traces.length).toFixed(2)
    const avgSelfHealingRetries = +(traces.reduce((s, t) => s + t.selfHealingRetries, 0) / traces.length).toFixed(2)

    // Tool stats
    const toolMap = new Map<string, { latencies: number[]; errors: number; total: number; resultSizes: number[]; argsHashes: Map<string, number> }>()
    for (const trace of traces) {
        for (const tc of trace.toolCalls) {
            if (!toolMap.has(tc.name)) toolMap.set(tc.name, { latencies: [], errors: 0, total: 0, resultSizes: [], argsHashes: new Map() })
            const tm = toolMap.get(tc.name)!
            tm.latencies.push(tc.latencyMs)
            tm.total++
            if (!tc.success) tm.errors++
            tm.resultSizes.push(tc.resultSize)
            tm.argsHashes.set(tc.argsHash, (tm.argsHashes.get(tc.argsHash) ?? 0) + 1)
        }
    }

    const toolInsights: ToolInsight[] = []
    for (const [name, tm] of toolMap) {
        const sorted = [...tm.latencies].sort((a, b) => a - b)
        const cacheCandidates = [...tm.argsHashes.values()].filter(c => c >= 3).length
        toolInsights.push({
            name,
            callCount: tm.total,
            avgLatencyMs: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
            p95LatencyMs: percentile(sorted, 0.95),
            errorRate: +(tm.errors / tm.total).toFixed(3),
            avgResultSize: Math.round(tm.resultSizes.reduce((s, v) => s + v, 0) / tm.resultSizes.length),
            cacheCandidates,
        })
    }
    toolInsights.sort((a, b) => b.callCount - a.callCount)

    // Model stats
    const modelMap = new Map<string, { llmLatencies: number[]; totalLatencies: number[]; successes: number; total: number; taskTypes: Record<string, number>; provider: string }>()
    for (const trace of traces) {
        const key = trace.modelUsed
        if (!modelMap.has(key)) modelMap.set(key, { llmLatencies: [], totalLatencies: [], successes: 0, total: 0, taskTypes: {}, provider: trace.provider })
        const mm = modelMap.get(key)!
        mm.llmLatencies.push(trace.llmLatencyMs)
        mm.totalLatencies.push(trace.totalLatencyMs)
        mm.total++
        if (trace.success) mm.successes++
        mm.taskTypes[trace.taskType] = (mm.taskTypes[trace.taskType] ?? 0) + 1
    }

    const modelInsights: ModelInsight[] = []
    for (const [modelId, mm] of modelMap) {
        modelInsights.push({
            modelId,
            provider: mm.provider,
            callCount: mm.total,
            avgLlmLatencyMs: Math.round(mm.llmLatencies.reduce((s, v) => s + v, 0) / mm.llmLatencies.length),
            avgTotalLatencyMs: Math.round(mm.totalLatencies.reduce((s, v) => s + v, 0) / mm.totalLatencies.length),
            successRate: +(mm.successes / mm.total).toFixed(3),
            taskTypes: mm.taskTypes,
        })
    }
    modelInsights.sort((a, b) => b.callCount - a.callCount)

    // Derived lists
    const slowestTools = [...toolInsights]
        .filter(t => t.callCount >= 3)
        .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
        .slice(0, 5)
        .map(t => t.name)

    const mostFailingTools = [...toolInsights]
        .filter(t => t.callCount >= 3 && t.errorRate > 0)
        .sort((a, b) => b.errorRate - a.errorRate)
        .slice(0, 5)
        .map(t => t.name)

    const cacheCandidates = toolInsights
        .filter(t => t.cacheCandidates > 0)
        .sort((a, b) => b.cacheCandidates - a.cacheCandidates)
        .slice(0, 5)
        .map(t => t.name)

    // Recommendations for L20
    const recommendations: string[] = []

    if (avgSelfHealingRetries > 0.3) {
        recommendations.push(`Hohe Self-Healing Rate (${avgSelfHealingRetries.toFixed(1)} Retries/Request) — Tool-Prompts oder Beispiele verbessern.`)
    }
    if (slowestTools.length > 0) {
        recommendations.push(`Langsame Tools: ${slowestTools.join(', ')} — Ergebnisse cachen oder Timeouts anpassen.`)
    }
    if (mostFailingTools.length > 0) {
        recommendations.push(`Fehlerhafte Tools: ${mostFailingTools.join(', ')} — Error-Handling oder Fallbacks prüfen.`)
    }
    if (cacheCandidates.length > 0) {
        recommendations.push(`Cache-Kandidaten: ${cacheCandidates.join(', ')} — diese Tools werden oft mit gleichen Args aufgerufen.`)
    }
    if (avgTotalLatencyMs > 10000) {
        recommendations.push(`Hohe Gesamtlatenz (${(avgTotalLatencyMs / 1000).toFixed(1)}s) — Message-Pipeline oder LLM-Routing optimieren.`)
    }
    if (modelInsights.length > 1) {
        const best = modelInsights.sort((a, b) => b.successRate - a.successRate)[0]
        recommendations.push(`Bestes Modell nach Erfolgsrate: ${best.modelId} (${(best.successRate * 100).toFixed(0)}% Erfolg).`)
    }

    return {
        generatedAt: Date.now(),
        tracesAnalyzed: traces.length,
        periodDays: days,
        overall: { avgTotalLatencyMs, avgLlmLatencyMs, avgToolLatencyMs, successRate: +(successes / traces.length).toFixed(3), avgToolCallsPerRequest, avgSelfHealingRetries },
        tools: toolInsights,
        models: modelInsights,
        slowestTools,
        mostFailingTools,
        cacheCandidates,
        recommendations,
    }
}

// ============================================
// Persist + Load insights
// ============================================

export function runTraceAnalysis(): TraceInsights {
    const insights = analyzeTraces(7)
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(INSIGHTS_PATH, JSON.stringify(insights, null, 2))
        console.log(`[TraceAnalyzer] ✅ Insights written (${insights.tracesAnalyzed} traces, ${insights.recommendations.length} recommendations)`)
    } catch (err) {
        console.warn('[TraceAnalyzer] Failed to write insights:', err)
    }
    return insights
}

export function loadTraceInsights(): TraceInsights | null {
    try {
        if (!existsSync(INSIGHTS_PATH)) return null
        return JSON.parse(readFileSync(INSIGHTS_PATH, 'utf-8')) as TraceInsights
    } catch {
        return null
    }
}

// ============================================
// Auto-run every hour (called from daemon)
// ============================================

let _analyzerTimer: NodeJS.Timeout | null = null

export function startTraceAnalyzer(): void {
    if (_analyzerTimer) return
    // Run once after 2min (traces need to accumulate), then every hour
    setTimeout(() => {
        runTraceAnalysis()
        _analyzerTimer = setInterval(runTraceAnalysis, 60 * 60 * 1000)
    }, 2 * 60 * 1000)
    console.log('[TraceAnalyzer] Started — first analysis in 2min, then every hour')
}
