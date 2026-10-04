import type { NovaTool } from './complete-registry.js'
import { getNovaDataDir } from '../core/data-root.js'
import { environmentAwareness } from '../sensing/awareness.js'

export const environmentInventoryTool: NovaTool = {
    name: 'environment_inventory', category: 'system', parameters: [],
    description: 'Liest bestehende Node-Fähigkeiten, MCP-Verbindungen mit Werkzeugkatalog und Zugang/Freigabe sowie LAN-/Tailnet-Geräte mit Fundzeit und Grenzen der letzten Suche. Startet keinen Scan oder Verbindungsaufbau; trennt Funde, Verbindungen und Ausführungsrechte.',
    handler: async () => {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        const context = getExecutionPolicyContext()
        if (!context.authUserId || getUserPermission(context.authUserId, context.channel) !== 'owner') throw new Error('environment inventory requires the authenticated owner')
        const [{ getMCPClient }, { loadConnections }, { getCapabilityGraph }, { nodesFromCapabilityGraph }, { connectionAwareness }, { getToolRegistry }] = await Promise.all([
            import('../mcp/mcp-client.js'), import('../connections/connection-store.js'), import('../mesh/capability-graph.js'),
            import('../mesh/capability-orchestrator.js'), import('../sensing/connection-awareness.js'), import('./complete-registry.js'),
        ])
        const dataDir = getNovaDataDir()
        const capabilities = connectionAwareness(nodesFromCapabilityGraph(getCapabilityGraph().getSnapshot()),
            getMCPClient().listServers(), loadConnections({ dataDir }),
            new Set(['mesh_delegate', 'mesh_exchange_send', 'mesh_screenshot'].filter(name => Boolean(getToolRegistry().get(name)))))
        const { haInventoryAwareness } = await import('../sensing/ha-inventory.js')
        const [{ getNovaConfig }, { parseSensingConfig }, { resolveHaConnection }] = await Promise.all([
            import('../core/config.js'), import('../sensing/config.js'), import('../sensing/adapters/homeassistant.js'),
        ])
        const rootConfig = getNovaConfig(), sensing = parseSensingConfig((rootConfig as any).autonomy?.sensing)
        const legacyAuthorized = sensing.enabled && sensing.adapters.homeassistant.enabled && Boolean(resolveHaConnection(sensing.adapters.homeassistant, rootConfig))
        return { formatted: capabilities + '\n\n' + haInventoryAwareness(dataDir, Date.now(), legacyAuthorized) + '\n\n' + environmentAwareness(dataDir, 'owner', Date.now(), false) }
    },
}
