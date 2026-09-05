import { describe, expect, it } from 'vitest'
import { acpPromptToText } from './acp-server.js'

describe('Nova ACP codec', () => {
    it('accepts baseline text and resource links without leaking protocol metadata', () => {
        expect(acpPromptToText([{ type: 'text', text: 'inspect' }, { type: 'resource_link', name: 'readme', uri: 'file:///README.md' }])).toBe('inspect\n[resource_link name=readme uri=file:///README.md]')
        expect(() => acpPromptToText([{ type: 'image', data: 'x' }])).toThrow(/text and resource_link/)
    })
})
