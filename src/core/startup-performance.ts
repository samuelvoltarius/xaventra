import { performance } from 'node:perf_hooks'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { join } from 'node:path'

export interface StartupPhaseSample {
    phase: string
    startedAt: string
    durationMs: number
    status: 'ok' | 'failed'
    detail?: string
}

export interface StartupPerformanceSnapshot {
    startedAt: string
    readyAt?: string
    totalMs?: number
    phases: StartupPhaseSample[]
}

const processStartedAt = new Date().toISOString()
const processStartedTick = performance.now()
const samples: StartupPhaseSample[] = []

function persist(): void {
    try {
        atomicWriteJsonSync(
            join(process.cwd(), '.nova-data', 'startup-performance.json'),
            {
                startedAt: processStartedAt,
                phases: samples,
            } as unknown as Record<string, unknown>,
        )
    } catch {
        // Startup diagnostics must never delay or break the daemon.
    }
}

export function startStartupPhase(phase: string): (status?: 'ok' | 'failed', detail?: string) => number {
    const startedTick = performance.now()
    const startedAt = new Date().toISOString()
    let finished = false
    return (status = 'ok', detail?: string): number => {
        if (finished) return 0
        finished = true
        const durationMs = Math.round((performance.now() - startedTick) * 10) / 10
        samples.push({ phase, startedAt, durationMs, status, detail })
        console.log(`[Startup] ${phase}: ${status} in ${durationMs}ms${detail ? ` (${detail})` : ''}`)
        persist()
        return durationMs
    }
}

export function markStartupReady(): StartupPerformanceSnapshot {
    const totalMs = Math.round((performance.now() - processStartedTick) * 10) / 10
    const snapshot: StartupPerformanceSnapshot = {
        startedAt: processStartedAt,
        readyAt: new Date().toISOString(),
        totalMs,
        phases: [...samples],
    }
    try {
        atomicWriteJsonSync(
            join(process.cwd(), '.nova-data', 'startup-performance.json'),
            snapshot as unknown as Record<string, unknown>,
        )
    } catch { /* diagnostics are best-effort */ }
    console.log(`[Startup] runtime-ready in ${totalMs}ms`)
    return snapshot
}

export function getStartupPerformance(): StartupPerformanceSnapshot {
    return {
        startedAt: processStartedAt,
        totalMs: Math.round((performance.now() - processStartedTick) * 10) / 10,
        phases: [...samples],
    }
}
