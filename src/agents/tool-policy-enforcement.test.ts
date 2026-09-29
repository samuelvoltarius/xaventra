import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addToolPolicy, removeToolPolicy } from './agent-patterns.js'
import { authorizeToolExecution, type ToolAuthority } from './tool-authorization.js'

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), policy: vi.fn() }))
vi.mock('../users/multi-user-middleware.js', () => ({
    isToolAllowed: mocks.allowed,
    getToolRestrictionMessage: () => 'Role denied',
}))
vi.mock('../tools/tool-policy.js', () => ({ checkTool: mocks.policy }))

const owner: ToolAuthority = { userId: 'alfred', authUserId: '111', channel: 'telegram', requestText: 'zeig mir den Status', governedReadOnly: false }

beforeEach(() => {
    mocks.allowed.mockReset().mockReturnValue(true)
    mocks.policy.mockReset().mockReturnValue({ allowed: true, needsConfirmation: false })
})
afterEach(() => {
    removeToolPolicy('ssh_command')
    removeToolPolicy('*')
    removeToolPolicy('read_file')
})

describe('set_tool_policy is enforced at the execution boundary (R2 MA-6)', () => {
    it('blocks a tool the owner denied', async () => {
        await expect(authorizeToolExecution('ssh_command', { host: 'x' }, owner)).resolves.toBeTruthy()
        addToolPolicy({ pattern: 'ssh_command', action: 'deny', reason: 'vom Owner verboten' })
        await expect(authorizeToolExecution('ssh_command', { host: 'x' }, owner)).rejects.toThrow('vom Owner verboten')
    })

    it('treats confirm as blocking, since this path has no confirmation step', async () => {
        addToolPolicy({ pattern: 'read_file', action: 'confirm' })
        await expect(authorizeToolExecution('read_file', { path: 'a' }, owner)).rejects.toThrow(/confirm/)
    })

    it('an allow rule never widens the role check', async () => {
        addToolPolicy({ pattern: 'ssh_command', action: 'allow' })
        mocks.allowed.mockReturnValue(false)
        await expect(authorizeToolExecution('ssh_command', {}, owner)).rejects.toThrow('Role denied')
    })

    it('a wildcard deny does not lock the policy tools themselves', async () => {
        addToolPolicy({ pattern: '*', action: 'deny' })
        await expect(authorizeToolExecution('read_file', {}, owner)).rejects.toThrow()
        await expect(authorizeToolExecution('list_tool_policies', {}, owner)).resolves.toBeTruthy()
    })

    it('rejects unsupported actions instead of reporting success', () => {
        expect(() => addToolPolicy({ pattern: 'ssh_command', action: 'block' as any })).toThrow(/Unsupported/)
        expect(() => addToolPolicy({ pattern: ' ', action: 'deny' })).toThrow(/pattern/)
    })
})
