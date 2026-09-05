import { monitorEventLoopDelay } from 'node:perf_hooks'

const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()

export function getRuntimePerformance() {
    const memory = process.memoryUsage()
    return {
        eventLoop: { meanMs: Number((loopDelay.mean / 1e6).toFixed(2)), maxMs: Number((loopDelay.max / 1e6).toFixed(2)) },
        memory: { rssMb: Math.round(memory.rss / 1048576), heapUsedMb: Math.round(memory.heapUsed / 1048576) },
        budgets: { contextLeanMs: 250, eventLoopMaxMs: 100, systemPromptMaxChars: 28_000 },
    }
}
