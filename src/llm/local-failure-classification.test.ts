import { describe, expect, it } from 'vitest'
import { classifyLocalModelFailure } from './nova-llm-sdk.js'

describe('local model failure classification', () => {
    it('never treats an aborted request timeout as a model crash', () => {
        expect(classifyLocalModelFailure('The operation was aborted due to timeout'))
            .toBe('transient-timeout')
        expect(classifyLocalModelFailure('request timed out after 45000ms'))
            .toBe('transient-timeout')
    })

    it('keeps real crashes and OOMs as hard failures', () => {
        expect(classifyLocalModelFailure('CUDA out of memory')).toBe('hard-failure')
        expect(classifyLocalModelFailure('process exited after SIGKILL')).toBe('hard-failure')
    })
})
