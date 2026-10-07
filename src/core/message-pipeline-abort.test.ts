import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    AgentDeadlineError,
    agentFailureDisposition,
    runWithAbortDeadline,
} from './message-pipeline.js'

afterEach(() => { vi.useRealTimers() })

describe('agent deadline and cancellation', () => {
    it('aborts the signal handed to the agent when the deadline fires and clears the timer', async () => {
        vi.useFakeTimers()
        let seen: AbortSignal | undefined
        const pending = runWithAbortDeadline(signal => {
            seen = signal
            return new Promise<string>(() => { /* a hung agent */ })
        }, { timeoutMs: 1000 })
        const outcome = pending.catch(error => error)
        await vi.advanceTimersByTimeAsync(1000)
        const error = await outcome
        expect(error).toBeInstanceOf(AgentDeadlineError)
        expect(seen?.aborted).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('links the execution abort signal to the agent signal', async () => {
        const parent = new AbortController()
        let seen: AbortSignal | undefined
        const pending = runWithAbortDeadline(signal => {
            seen = signal
            return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('AbortError: hard cancel'))))
        }, { timeoutMs: 60_000, parentSignal: parent.signal })
        parent.abort()
        await expect(pending).rejects.toBeTruthy()
        expect(seen?.aborted).toBe(true)
        expect(agentFailureDisposition(new Error('AbortError: hard cancel'), parent.signal)).toBe('cancelled')
    })

    it('clears the timer when the agent finishes in time', async () => {
        vi.useFakeTimers()
        await expect(runWithAbortDeadline(async () => 'done', { timeoutMs: 1000 })).resolves.toBe('done')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('never uses the plain LLM fallback for timeouts or aborts', () => {
        expect(agentFailureDisposition(new AgentDeadlineError('late'))).toBe('timeout')
        expect(agentFailureDisposition(new Error('AbortError: hard cancel'))).toBe('cancelled')
        const domAbort = new Error('The operation was aborted'); domAbort.name = 'AbortError'
        expect(agentFailureDisposition(domAbort)).toBe('cancelled')
        expect(agentFailureDisposition(new Error('provider 500'))).toBe('fallback')
        const source = readFileSync(fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)), 'utf8')
        const catchBlock = source.slice(source.lastIndexOf('agentFailureDisposition(err'))
        expect(catchBlock.indexOf('agentFailureDisposition(err')).toBeLessThan(catchBlock.indexOf('state.llm.complete('))
    })

    it('passes a linked abort signal to every runNovaAgent call', () => {
        const source = readFileSync(fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)), 'utf8')
        const calls = source.split('runNovaAgent({').slice(1)
        expect(calls.length).toBeGreaterThanOrEqual(3)
        for (const call of calls) {
            const args = call.slice(0, call.indexOf('memory:'))
            expect(args).toContain('abortSignal: agentSignal')
        }
        expect(source).not.toContain("reject(new Error('[Timeout] runNovaAgent exceeded 300s'))")
    })
})
