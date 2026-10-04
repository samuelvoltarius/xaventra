import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ permission: 'owner', authUserId: 'owner', servers: [] as any[], nodes: [] as any[] }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => ({ authUserId: state.authUserId, channel: 'Desktop' }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => state.permission }))
vi.mock('../core/data-root.js', () => ({ getNovaDataDir: () => 'unused-test-data' }))
vi.mock('../sensing/awareness.js', () => ({ environmentAwareness: () => 'LAN: Gerät gefunden, Typ unbekannt' }))
vi.mock('../mcp/mcp-client.js', () => ({ getMCPClient: () => ({ listServers: () => state.servers }) }))
vi.mock('../connections/connection-store.js', () => ({ loadConnections: () => [] }))
vi.mock('../mesh/capability-graph.js', () => ({ getCapabilityGraph: () => ({ getSnapshot: () => ({ nodes: state.nodes }) }) }))
vi.mock('../mesh/capability-orchestrator.js', () => ({ nodesFromCapabilityGraph: (s: any) => s.nodes }))
vi.mock('./complete-registry.js', () => ({ getToolRegistry: () => ({ get: (name: string) => name === 'mesh_delegate' ? {} : undefined }) }))
import { environmentInventoryTool } from './environment-inventory-tool.js'
import { environmentOverviewResponse } from '../core/tool-evidence-response.js'
beforeEach(() => { state.permission = 'owner'; state.authUserId = 'owner'; state.servers = []; state.nodes = [] })
describe('owner overview integration', () => {
    it('delivers MCP catalog, node capabilities and LAN evidence through the real formatter', async () => {
        state.nodes = [{ name: 'worker', address: 'local', online: true, capabilities: [{ name: 'llm', provider: 'qwen', available: true }] }]
        state.servers = [{ name: 'home', connected: true, tools: [{ name: 'get_devices', description: 'Geräte lesen' }] }]
        const result = await environmentInventoryTool.handler({} as any)
        const text = environmentOverviewResponse([{ toolName: 'environment_inventory', success: true, result }, { toolName: 'mesh_status', success: true, result: 'worker online' }])
        expect(text).toContain('Sprachmodell (qwen)')
        expect(text).toContain('get_devices: Geräte lesen')
        expect(text).toContain('LAN: Gerät gefunden')
        expect(text).toContain('worker online')
    })
    it('denies non-owners and missing authentication before catalog access', async () => {
        state.permission = 'user'
        await expect(environmentInventoryTool.handler({} as any)).rejects.toThrow('authenticated owner')
        state.permission = 'owner'; state.authUserId = ''
        await expect(environmentInventoryTool.handler({} as any)).rejects.toThrow('authenticated owner')
    })
})
