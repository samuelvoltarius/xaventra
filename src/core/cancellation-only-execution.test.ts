import { describe, expect, it } from 'vitest'
import { capabilityGateApplies, isCancellationOnlyExecution } from './message-pipeline.js'

// 2.88.2 (live 07.10.2026): the daemon entry gives EVERY normal message an execution
// object that only carries the /cancel abort signal. Pipeline stages that exclude real
// agent contracts with `!execution` (learning question, connect question, projects,
// read-only fast path) therefore never ran in production — in any channel.

describe('a cancellation-only execution is a normal user message', () => {
    it('recognises the daemon entry wrapper', () => {
        expect(isCancellationOnlyExecution({ abortSignal: new AbortController().signal })).toBe(true)
        expect(isCancellationOnlyExecution(undefined)).toBe(false)
    })
    it('a real contract stays a contract (Gegenprobe)', () => {
        expect(isCancellationOnlyExecution({ abortSignal: new AbortController().signal, allowedTools: ['read_file'] })).toBe(false)
        expect(isCancellationOnlyExecution({ requestId: 'r1' })).toBe(false)
        expect(isCancellationOnlyExecution({ abortSignal: new AbortController().signal, systemAuthored: true })).toBe(false)
    })
    it('the learning gate runs for a wrapped user message', () => {
        const execution = { abortSignal: new AbortController().signal }
        expect(capabilityGateApplies({ isSystemAuthored: false, image: false, execution: true, desktopCancellationOnly: isCancellationOnlyExecution(execution) })).toBe(true)
    })
})
