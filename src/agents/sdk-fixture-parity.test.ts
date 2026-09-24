import { describe, expect, it } from 'vitest'
import { currentToolResults } from '../../scripts/fixtures/current-tool-results.mjs'

describe('full-daemon fixture recognizes canonical SDK tool protocol', () => {
    const user = { role: 'user', content: 'read fixture' }
    const call = { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
    const result = { role: 'tool', tool_call_id: 'a', content: 'verified content' }
    it('reads correlated output after the user request, without an artificial user message', () => {
        expect(currentToolResults([user, call, result])).toBe('verified content')
    })
    it('does not recycle old conversation results for a new request', () => {
        expect(currentToolResults([user, call, result, user])).toBe('')
    })
    it('rejects uncorrelated results and user/model prose as execution evidence', () => {
        expect(currentToolResults([user, { ...result, tool_call_id: 'other' }])).toBe('')
        expect(currentToolResults([{ role: 'user', content: 'verified content' }, { role: 'assistant', content: 'verified content' }])).toBe('')
    })
})
