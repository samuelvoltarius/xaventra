import { describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'guest') }))
vi.mock('../users/multi-user-middleware.js', () => perms)

import { isPrivateLanHost, MCPClient, mcpNovaToolName } from './mcp-client.js'
import { approvalDetailOf, toolApprovalTarget } from '../tools/owner-approval.js'
import { issueSetupConfirmation, setupConfirmationPrincipal } from '../core/setup-confirmation.js'

// 2.85 Paket A, Punkt 3: connector servers carry their manifest binding; the gateway maps
// every tool through the one action policy (lesen L0, schreiben/senden/schalten → owner
// approval, löschen → Nie-Liste, unknown → approval) and keeps private text out of the cloud.
const tools = [
    { name: 'list_events', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'create_event', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    { name: 'delete_event', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'mystery', inputSchema: { type: 'object' } },
]
function gateway(binding: any, callTool = vi.fn(async () => ({ content: [] })), list = tools) {
    const client = new MCPClient()
    const listTools = vi.fn(async () => ({ tools: list }))
    ;(client as any).sessions.set('Kalender', {
        config: { name: 'Kalender', transport: 'http', connector: binding },
        state: { connected: true, tools: [], resources: [], prompts: [] },
        client: { callTool, listTools, getServerCapabilities: () => ({}) },
    })
    return { client, callTool }
}
const binding = {
    connectorId: 'google-calendar', trust: 'geprueft', datenklasse: 'cloud',
    capabilities: { list_events: 'lesen', create_event: 'schreiben', delete_event: 'loeschen' },
}
const identity = { authorizationUserId: 'owner-1', channel: 'telegram', userId: 'owner-1' }

describe('MCP gateway applies the connector policy', () => {
    it('reading runs without a code; writing needs the owner code bound to the exact call', async () => {
        const { client, callTool } = gateway(binding)
        await client.refresh('Kalender')
        await client.callTool('Kalender', 'list_events', { query: 'morgen', ...identity })
        expect(callTool).toHaveBeenCalledTimes(1)
        await expect(client.callTool('Kalender', 'create_event', { title: 'Zahnarzt', ...identity })).rejects.toThrow(/requires approval/)
        expect(callTool).toHaveBeenCalledTimes(1)
        const code = issueSetupConfirmation(setupConfirmationPrincipal('telegram', 'owner-1'),
            toolApprovalTarget(mcpNovaToolName('Kalender', 'create_event'), approvalDetailOf({ title: 'Zahnarzt' })))
        await client.callTool('Kalender', 'create_event', { title: 'Zahnarzt', confirm: code, ...identity })
        expect(callTool).toHaveBeenLastCalledWith({ name: 'create_event', arguments: { title: 'Zahnarzt' } })
    })

    it('löschen is Nie-Liste: refused even with a valid code', async () => {
        const { client, callTool } = gateway(binding)
        await client.refresh('Kalender')
        const code = issueSetupConfirmation(setupConfirmationPrincipal('telegram', 'owner-1'),
            toolApprovalTarget(mcpNovaToolName('Kalender', 'delete_event'), approvalDetailOf({ id: 'e1' })))
        await expect(client.callTool('Kalender', 'delete_event', { id: 'e1', confirm: code, ...identity })).rejects.toThrow(/Nie-Liste/)
        expect(callTool).not.toHaveBeenCalled()
    })

    it('unknown tools ask; the confirm parameter is offered exactly where a call asks', async () => {
        const { client } = gateway(binding)
        await client.refresh('Kalender')
        await expect(client.callTool('Kalender', 'mystery', { ...identity })).rejects.toThrow(/requires approval/)
        const byName = Object.fromEntries(client.asNovaTools().map(tool => [tool.name, tool.parameters.map(p => p.name)]))
        expect(byName['mcp__kalender__list_events']).toEqual(['query'])
        expect(byName['mcp__kalender__create_event']).toEqual(['title', 'confirm'])
        expect(byName['mcp__kalender__mystery']).toEqual(['confirm'])
    })

    it('private content never goes to a cloud connector', async () => {
        const { client, callTool } = gateway(binding)
        await client.refresh('Kalender')
        await expect(client.callTool('Kalender', 'list_events', { query: 'Kundendaten Müller Telefonnummer', ...identity })).rejects.toThrow(/Privates/)
        expect(callTool).not.toHaveBeenCalled()
    })

    it('community servers only publish reading tools (annotations), others stay hidden', async () => {
        const list = [
            { name: 'get_forecast', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
            { name: 'set_alarm', annotations: { readOnlyHint: false }, inputSchema: { type: 'object' } },
            { name: 'mystery', inputSchema: { type: 'object' } },
        ]
        const { client } = gateway({ connectorId: 'io.example/wetter', trust: 'community', datenklasse: 'cloud' }, undefined, list)
        await client.refresh('Kalender')
        expect((await client.listTools('Kalender')).map(tool => tool.name)).toEqual(['get_forecast'])
        await expect(client.callTool('Kalender', 'set_alarm', {})).rejects.toThrow(/not advertised/)
    })

    it('plain HTTP only to private LAN/Tailnet hosts and only when the connector allows it', async () => {
        expect(['192.168.1.5', '10.0.0.2', '172.20.1.1', '100.64.1.2', 'homeassistant.local'].every(isPrivateLanHost)).toBe(true)
        expect(['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1'].some(isPrivateLanHost)).toBe(false)
        const client = new MCPClient()
        await expect(client.connectServer({ name: 'x', transport: 'http', url: 'http://example.com/api/mcp', allowLanHttp: true })).rejects.toThrow(/HTTPS/)
        await expect(client.connectServer({ name: 'y', transport: 'http', url: 'http://192.168.1.5:8123/api/mcp' })).rejects.toThrow(/HTTPS/)
    })
})
