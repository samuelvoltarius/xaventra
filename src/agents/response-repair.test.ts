import { describe, expect, it, vi } from 'vitest'
import { repairConstrainedResponse } from './response-repair.js'
import { createTaskContract, validateTaskCompletion } from '../core/task-contract.js'

function fixture() {
    const contract = createTaskContract('Return only "CURRENT-29"', { kind: 'none', requiresTool: false })
    const response = 'CURRENT-29 (OLD-28 no longer applies)'
    return { contract, response, validation: validateTaskCompletion(contract, { response }),
        requiresTool: false, startedAt: Date.now(), tokensUsed: 10,
        complete: vi.fn(async () => ({ content: 'CURRENT-29', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } })) }
}
describe('bounded response format repair', () => {
    it('attempts exactly once without tools and requires independent revalidation', async () => {
        const input = fixture()
        const result = await repairConstrainedResponse(input)
        expect(input.validation.success).toBe(false)
        expect(input.complete).toHaveBeenCalledTimes(1)
        expect(input.complete.mock.calls[0][1]).toEqual([])
        expect(input.complete.mock.calls[0][2]).toMatchObject({ maxAttempts: 1, maxTokens: 256, timeoutMs: 8000 })
        expect(result.usage.totalTokens).toBe(105)
        expect(validateTaskCompletion(input.contract, { response: result.content }).success).toBe(true)
    })
    it('keeps repeated invalid output invalid, without retrying it', async () => {
        const input = fixture()
        input.complete.mockResolvedValue({ content: 'CURRENT-29 plus old text', usage: undefined })
        const result = await repairConstrainedResponse(input)
        expect(input.complete).toHaveBeenCalledTimes(1)
        expect(validateTaskCompletion(input.contract, { response: result.content }).success).toBe(false)
    })
    it.each(['policy', 'approval', 'action', 'timeout', 'tokens', 'usd', 'cancelled', 'valid'])(
        'does not repair across %s boundaries', async boundary => {
            const input = fixture()
            if (boundary === 'policy') input.validation.violations.push('execution stopped by policy')
            if (boundary === 'approval') input.validation.awaitingApproval = true
            if (boundary === 'action') input.requiresTool = true
            if (boundary === 'timeout') input.startedAt -= input.contract.budget.timeoutMs
            if (boundary === 'tokens') input.contract.budget.maxTokens = 20
            if (boundary === 'usd') input.contract.budget.maxCostUsd = 0.01
            if (boundary === 'valid') input.validation.success = true
            const signal = boundary === 'cancelled' ? AbortSignal.abort() : undefined
            expect(await repairConstrainedResponse({ ...input, signal })).toBeNull()
            expect(input.complete).not.toHaveBeenCalled()
        })
    it('does not execute or accept a tool call returned by a noncompliant model', async () => {
        const input = fixture()
        const result = await repairConstrainedResponse({ ...input, complete: async () => ({ content: 'CURRENT-29', toolCalls: [{ id: 'evil', name: 'write_file', arguments: {} }] }) })
        expect(result.content).toBe('')
        expect(validateTaskCompletion(input.contract, { response: result.content }).success).toBe(false)
    })
    it('returns promptly when cancelled during a hung provider call', async () => {
        const input = fixture()
        const controller = new AbortController()
        const result = repairConstrainedResponse({ ...input, signal: controller.signal, complete: () => new Promise(() => {}) })
        controller.abort()
        expect(await result).toBeNull()
    })
})
