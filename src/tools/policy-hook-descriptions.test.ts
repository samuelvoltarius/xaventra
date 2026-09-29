import { beforeAll, describe, expect, it, vi } from 'vitest'

const patterns = vi.hoisted(() => ({ addToolPolicy: vi.fn() }))
vi.mock('../agents/agent-patterns.js', async (original) => ({ ...(await original() as object), addToolPolicy: patterns.addToolPolicy }))

let registry: typeof import('./complete-registry.js')
beforeAll(async () => { registry = await import('./complete-registry.js') }, 120_000)
const tool = (name: string) => registry.ALL_TOOLS.find(entry => entry.name === name)!

describe('R2 UEB-9: set_tool_policy says the rule is not persistent', () => {
    it('reports that the rule only lasts until restart', async () => {
        const result = await tool('set_tool_policy').handler({ pattern: 'x_*', action: 'deny' }) as any
        expect(patterns.addToolPolicy).toHaveBeenCalledTimes(1)
        expect(result.persistent).toBe(false)
        expect(result.message).toMatch(/bis zum nächsten Neustart/)
    })
})

describe('R2 UEB-10: create_hook no longer offers script hooks', () => {
    it('description and parameters do not advertise script as an option', () => {
        const hook = tool('create_hook')
        expect(hook.description).not.toMatch(/webhook, email, script/)
        expect(hook.description).toMatch(/script-Hooks werden abgelehnt/)
        const type = hook.parameters.find(p => p.name === 'type')!
        const target = hook.parameters.find(p => p.name === 'target')!
        expect(type.description).not.toMatch(/script/i)
        expect(target.description).not.toMatch(/script/i)
    })
})
