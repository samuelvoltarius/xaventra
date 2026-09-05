import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteJson, flushAtomicWrites } from './atomic-storage.js'
import { ProactiveMessenger } from './proactive.js'
import { endTrace, getTraceStats, runWithTrace, startTrace, traceStep } from './request-tracer.js'
import { selectContextPolicy } from './context-policy.js'
import { RequestGate } from './request-gate.js'
import { NovaConfigSchema } from './config.js'
import { assessmentFromEvent } from './proactive-policy.js'

const paths: string[] = []
afterEach(async () => Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('next-level infrastructure', () => {
    it('serializes concurrent atomic writes without corrupting JSON', async () => {
        const dir = await mkdtemp(join(process.cwd(), '.nova-atomic-'))
        paths.push(dir)
        const path = join(dir, 'state.json')
        await Promise.all(Array.from({ length: 20 }, (_, value) => atomicWriteJson(path, { value })))
        await flushAtomicWrites()
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 19 })
    })

    it('collects request stages and aggregate latency statistics', async () => {
        const id = startTrace('test', 'user', 'measure this')
        await runWithTrace(id, async () => {
            traceStep('context')
            await Promise.resolve()
            traceStep('agent')
        })
        endTrace(id)
        const stats = getTraceStats()
        expect(stats.completed).toBeGreaterThan(0)
        expect(stats.slowestStages.some(stage => stage.name === 'context')).toBe(true)
    })

    it('deduplicates proactive notifications and enforces a daily budget', async () => {
        const messenger = new ProactiveMessenger({ dailyBudget: 1, quietHoursStart: 0, quietHoursEnd: 0 })
        let sends = 0
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send: async () => { sends++; return true } })
        const message = {
            userId: 'u', channel: 'telegram', content: 'same', priority: 'normal', type: 'notification',
            assessment: assessmentFromEvent({ source: 'test', summary: 'same', severity: 'warning', confidence: 1, dedupeKey: 'test:same' }),
        } as const
        expect(await messenger.send(message)).toBe(true)
        expect(await messenger.send(message)).toBe(false)
        expect(await messenger.send({ ...message, content: 'different' })).toBe(false)
        expect(sends).toBe(1)
    })

    it('does not duplicate queued messages while a channel stays offline', async () => {
        const messenger = new ProactiveMessenger({ quietHoursStart: 0, quietHoursEnd: 0 })
        messenger.registerChannel({ name: 'telegram', isConnected: () => false, send: async () => false })
        const message = {
            userId: 'u', channel: 'telegram', content: 'later', priority: 'normal', type: 'notification',
            assessment: assessmentFromEvent({ source: 'test', summary: 'later', severity: 'warning', confidence: 1, dedupeKey: 'test:later' }),
        } as const
        await messenger.send(message)
        await messenger.processQueue()
        await messenger.processQueue()
        expect(messenger.getStats().queueLength).toBe(1)
    })

    it('keeps simple prompts lean and enables deep context for analysis', () => {
        const fast = selectContextPolicy('Wie spät ist es?')
        expect(fast.mode).toBe('lean')
        expect(fast.cognitiveMode).toBe('fast')
        expect(fast.executionBudget.maxToolCalls).toBe(4)
        const deep = selectContextPolicy('Analysiere die Architektur dieses Projekts und vergleiche alle Komponenten.')
        expect(deep.mode).toBe('deep')
        expect(deep.longTermMemory).toBe(true)
        expect(deep.plannerPaths).toBe(3)
        expect(deep.executionBudget.maxTokens).toBeGreaterThan(fast.executionBudget.maxTokens)
    })

    it('requires fresh evidence for current research without granting autonomy', () => {
        const research = selectContextPolicy('Recherchiere online die neuesten Agent-Frameworks und belege den Vergleich.')
        expect(research.cognitiveMode).toBe('research')
        expect(research.researchRequired).toBe(true)
        expect(research.taskClass).toBe('research')
    })

    it('applies global backpressure and rejects beyond queue capacity', async () => {
        const gate = new RequestGate(1, 1)
        let release!: () => void
        const blocker = gate.run(() => new Promise<void>(resolve => { release = resolve }))
        const queued = gate.run(async () => 'queued')
        await expect(gate.run(async () => 'overflow')).rejects.toThrow('queue capacity')
        release()
        await blocker
        await expect(queued).resolves.toBe('queued')
    })

    it('preserves forward-compatible config sections', () => {
        const config = NovaConfigSchema.parse({ customFutureSection: { enabled: true } })
        expect((config as any).customFutureSection).toEqual({ enabled: true })
        expect(config.performance.preloadProfile).toBe('minimal')
    })

    it('selects context within the lean performance budget', () => {
        const started = performance.now()
        for (let i = 0; i < 10_000; i++) selectContextPolicy('kurze frage?')
        expect(performance.now() - started).toBeLessThan(250)
    })
})
