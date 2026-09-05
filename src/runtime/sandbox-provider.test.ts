import { describe, expect, it } from 'vitest'
import { SandboxRegistry, type SandboxProvider } from './sandbox-provider.js'

describe('SandboxRegistry', () => {
    it('fails closed and selects only a usable provider', () => {
        const registry = new SandboxRegistry()
        expect(() => registry.confine('node', [], { workspaceRoot: '.', network: false })).toThrow(/SANDBOX_UNAVAILABLE/)
        const fake: SandboxProvider = { name: 'fake', supports: () => true, confine: (command, args) => ({ command: 'fake-run', args: [command, ...args], backend: 'fake', enforcement: 'full' }) }
        registry.register(fake)
        expect(registry.confine('node', ['a'], { workspaceRoot: '.', network: false }).backend).toBe('fake')
    })
})
