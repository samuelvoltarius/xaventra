import { describe, expect, it } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'
import { createTaskContract, validateTaskCompletion } from './task-contract.js'

describe('live read_file budget regression', () => {
    it('does not compare the complete prompt with the default answer budget', () => {
        const kernel = new ExecutionKernel('Lies die Datei probe.txt')
        kernel.verify('read_file', { success: true, content: 'unknown-canary' })
        const result = kernel.validateCompletion('unknown-canary', {
            tokens: 5380, outputTokens: 47,
        } as any)
        expect(result.success).toBe(true)
    })

    it('still rejects excessive output and an explicit total-token ceiling', () => {
        const contract = createTaskContract('hello', { kind: 'none', requiresTool: false }, [], {
            budget: { maxOutputTokens: 100, maxTokens: 1000 } as any,
        })
        expect(validateTaskCompletion(contract, { response: 'hello', tokens: 101, outputTokens: 101 } as any).success).toBe(false)
        expect(validateTaskCompletion(contract, { response: 'hello', tokens: 1001, outputTokens: 1 } as any).success).toBe(false)
    })
})
