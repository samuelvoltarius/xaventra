import { describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'guest') }))
vi.mock('../users/multi-user-middleware.js', () => perms)

import { MCPClient, mcpNovaToolName } from './mcp-client.js'
import { approvalDetailOf, toolApprovalTarget } from '../tools/owner-approval.js'
import { issueSetupConfirmation, setupConfirmationPrincipal } from '../core/setup-confirmation.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

// P9 Gruppe 4: requireApproval used to check a context flag that no code path ever set,
// so every approval-gated MCP call was refused. Now: the owner's one-time code, bound to
// server + tool + exact arguments.
function clientWith(callTool = vi.fn(async () => ({ content: [] }))) {
    const client = new MCPClient()
    ;(client as any).sessions.set('Home', {
        config: { name: 'Home', transport: 'stdio', requireApproval: true },
        state: { connected: true, tools: [{ name: 'set-light', inputSchema: { type: 'object', properties: { room: { type: 'string' } } } }], resources: [], prompts: [] },
        client: { callTool },
    })
    return { client, callTool }
}
const principal = setupConfirmationPrincipal('telegram', 'owner-1')
const identity = { authorizationUserId: 'owner-1', channel: 'telegram', userId: 'owner-1' }

describe('MCP requireApproval: owner code bound to the exact call', () => {
    it('refuses without a code and never calls the server', async () => {
        const { client, callTool } = clientWith()
        await expect(client.callTool('Home', 'set-light', { room: 'kueche', ...identity })).rejects.toThrow(/requires approval/)
        expect(callTool).not.toHaveBeenCalled()
    })
    it('a former approvalGranted context flag does not approve', async () => {
        const { client, callTool } = clientWith()
        await expect(withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram', approvalGranted: true } as any,
            () => client.callTool('Home', 'set-light', { room: 'kueche' }))).rejects.toThrow(/requires approval/)
        expect(callTool).not.toHaveBeenCalled()
    })
    it('runs with a code for exactly these arguments, once, and strips code and identity before sending', async () => {
        const { client, callTool } = clientWith()
        const name = mcpNovaToolName('Home', 'set-light')
        const code = issueSetupConfirmation(principal, toolApprovalTarget(name, approvalDetailOf({ room: 'kueche' })))
        await client.callTool('Home', 'set-light', { room: 'kueche', confirm: code, ...identity })
        expect(callTool).toHaveBeenCalledWith({ name: 'set-light', arguments: { room: 'kueche' } })
        await expect(client.callTool('Home', 'set-light', { room: 'kueche', confirm: code, ...identity })).rejects.toThrow(/requires approval/)
        expect(callTool).toHaveBeenCalledTimes(1)
    })
    it('a code for other arguments does not approve this call', async () => {
        const { client, callTool } = clientWith()
        const name = mcpNovaToolName('Home', 'set-light')
        const code = issueSetupConfirmation(principal, toolApprovalTarget(name, approvalDetailOf({ room: 'bad' })))
        await expect(client.callTool('Home', 'set-light', { room: 'kueche', confirm: code, ...identity })).rejects.toThrow(/requires approval/)
        expect(callTool).not.toHaveBeenCalled()
    })
    it('offers the confirm parameter only on approval-gated servers', () => {
        const { client } = clientWith()
        const tool = client.asNovaTools()[0]
        expect(tool.name).toBe('mcp__home__set-light')
        expect(tool.parameters.map(item => item.name)).toEqual(['room', 'confirm'])
    })
})
