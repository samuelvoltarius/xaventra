import { describe, expect, it, vi } from 'vitest'
import { ALL_TOOLS } from './complete-registry.js'
import { ToolRegistry, registerBuiltinTools } from './registry.js'
import { sshTool } from './ssh-tool.js'

// 2.90.1 (Codekarte D2): ssh_command existed three times - the registered one without `confirm` and identity
// (the owner's /freigabe code for the SSH self-heal could never be passed), the complete one in ssh-tool.ts
// (imported, not registered) and a third in registry.ts. remember/recall in registry.ts (CLI, llm/base) were
// stubs that stored nothing. One way each.
describe('one way per tool across both registries', () => {
    it('the runtime registers the complete ssh_command with confirm', () => {
        const registered = ALL_TOOLS.filter(tool => tool.name === 'ssh_command')
        expect(registered).toHaveLength(1)
        expect(registered[0].handler).toBe(sshTool.handler)
        expect(registered[0].parameters.map(parameter => parameter.name)).toContain('confirm')
    })

    it.each(['ssh_command', 'remember', 'recall'])('registry.ts %s has the parameters of the runtime tool', name => {
        const registry = new ToolRegistry()
        registerBuiltinTools(registry)
        const legacy = registry.getAll().find(tool => tool.name === name)!
        const runtime = ALL_TOOLS.find(tool => tool.name === name)!
        expect(legacy.parameters.map(parameter => parameter.name)).toEqual(runtime.parameters.map(parameter => parameter.name))
    })

    it('registry.ts remember stores through the runtime tool, not a stub', async () => {
        const runtime = ALL_TOOLS.find(tool => tool.name === 'remember')!
        const spy = vi.spyOn(runtime, 'handler').mockResolvedValue({ success: true, id: 'mem-1' })
        const registry = new ToolRegistry()
        registerBuiltinTools(registry)
        const result = await registry.getAll().find(tool => tool.name === 'remember')!.handler({ content: 'Bello ist ein Hund' })
        expect(spy).toHaveBeenCalledWith({ content: 'Bello ist ein Hund' })
        expect(result).toEqual({ success: true, id: 'mem-1' })
        spy.mockRestore()
    })
})
