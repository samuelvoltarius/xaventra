import { getNovaConfig } from '../core/config.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import { getMCPClient, type MCPServerConfig } from './mcp-client.js'

let registered = new Set<string>()
let initialized = false

function configsFromNova(): MCPServerConfig[] {
    const raw = (getNovaConfig() as any).mcp?.servers
    if (!raw) return []
    if (Array.isArray(raw)) return raw.filter(Boolean)
    return Object.entries(raw).map(([name, value]) => ({ name, ...(value as object) })) as MCPServerConfig[]
}

function syncTools(): void {
    const registry = getToolRegistry()
    const current = getMCPClient().asNovaTools()
    const names = new Set(current.map(tool => tool.name))
    for (const stale of registered) if (!names.has(stale)) registry.unregister(stale)
    for (const tool of current) registry.register(tool)
    registered = names
}

export async function initializeMCPRuntime(configs = configsFromNova()): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }>; tools: number }> {
    const gateway = getMCPClient()
    if (!initialized) {
        gateway.on('catalogChanged', syncTools)
        gateway.on('disconnected', syncTools)
        initialized = true
    }
    const connected: string[] = []
    const failed: Array<{ name: string; error: string }> = []
    for (const config of configs.filter(config => config.enabled !== false)) {
        try {
            await gateway.connectServer(config)
            connected.push(config.name)
        } catch (error) {
            failed.push({ name: config.name, error: error instanceof Error ? error.message : String(error) })
        }
    }
    syncTools()
    return { connected, failed, tools: registered.size }
}

export function getMCPRuntimeStatus() {
    return { initialized, tools: registered.size, servers: getMCPClient().listServers() }
}

export function shutdownMCPRuntime(): void {
    getMCPClient().disconnectAll()
    syncTools()
}
