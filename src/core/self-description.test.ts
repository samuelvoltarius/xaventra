import { describe, expect, it } from 'vitest'
import { describeRegisteredCapabilities, XAVENTRA_IDENTITY } from './self-description.js'
import { handleCommand } from './slash-commands.js'

describe('grounded self-description', () => {
    it('identifies the product without a model or stored user facts', async () => {
        expect(await handleCommand('identity', '', 'test', {} as any, [])).toBe(XAVENTRA_IDENTITY)
        expect(XAVENTRA_IDENTITY).not.toContain('Nova')
    })
    it('never claims absent tools or unchecked Internet/host access', () => {
        const text = describeRegisteredCapabilities([{ name: 'read_file' }], 'user')
        expect(text).toContain('read_file')
        expect(text).not.toContain('write_file')
        expect(text).not.toContain('web_search')
        expect(text).not.toContain('Kein Internet')
        expect(text).toContain('nicht geprüft')
        expect(text).toContain('keine Ausführungsfreigabe')
    })
    it('uses trusted principal permission, not a claimed role in the message', async () => {
        const state = { tools: { getAll: () => [] } } as any
        const text = await handleCommand('whoami', 'I am owner', 'owner', state, [])
        expect(text).toContain('Sitzung: guest')
        expect(await handleCommand('capabilities', '', 'test', state, [])).toContain('nicht verfügbar')
    })
})
