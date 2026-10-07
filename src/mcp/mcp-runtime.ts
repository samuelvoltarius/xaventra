import { getNovaConfig } from '../core/config.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import { getMCPClient, type MCPServerConfig } from './mcp-client.js'
import type { ConnectionRecord, ConnectionTestResult } from '../connections/connection-store.js'
import type { LoginDeps } from '../connections/connector-login.js'

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

function ensureListeners(): void {
    if (initialized) return
    const gateway = getMCPClient()
    gateway.on('catalogChanged', syncTools)
    gateway.on('disconnected', syncTools)
    // 2.85: an expired connector login becomes exactly one request to the owner.
    gateway.on('authFailure', ({ server }: { server: string }) => { void onAuthFailure(server) })
    initialized = true
}

/**
 * Without an explicit list (the daemon): `mcp.servers` of the main config plus the
 * connections the owner approved (2.85 Paket A, `connections.json`, status verbunden).
 */
export async function initializeMCPRuntime(configs?: MCPServerConfig[]): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }>; tools: number }> {
    const gateway = getMCPClient()
    ensureListeners()
    const withConnections = configs === undefined
    const connected: string[] = []
    const failed: Array<{ name: string; error: string }> = []
    for (const config of (configs ?? configsFromNova()).filter(config => config.enabled !== false)) {
        try {
            await gateway.connectServer(config)
            connected.push(config.name)
        } catch (error) {
            failed.push({ name: config.name, error: error instanceof Error ? error.message : String(error) })
        }
    }
    if (withConnections) {
        try {
            const { loadConnections } = await import('../connections/connection-store.js')
            const { defaultDeps } = await import('../connections/connect-flow.js')
            const { connectionState } = await import('../connections/connection-state.js')
            const { getNovaDataDir } = await import('../core/data-root.js')
            // 2.89: the one connection truth decides what is connected (a configured HA is REST, never MCP).
            for (const record of loadConnections().filter(item => usesMcpRuntime(item) && connectionState(getNovaDataDir(), { verbindung: item }).zustand === 'verbunden')) {
                try {
                    await connectConnectionRecord(record, defaultDeps())
                    connected.push(serverNameFor(record))
                } catch (error) {
                    failed.push({ name: serverNameFor(record), error: error instanceof Error ? error.message : String(error) })
                }
            }
        } catch { /* no connections */ }
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

// ---------------------------------------------------------------------------
// 2.85 Paket A: connections → MCP server configs (built in code, never from a model)
// ---------------------------------------------------------------------------

/** Gateway server name of a connection (tool names: mcp__<name>__<tool>). */
export function serverNameFor(record: Pick<ConnectionRecord, 'id'>): string { return record.id.slice(2) }

function bindingOf(record: ConnectionRecord) {
    return {
        connectorId: record.connectorId, trust: record.trust, datenklasse: record.datenklasse,
        capabilities: record.capabilities, standard: record.standard, erlaubteWerkzeuge: record.erlaubteWerkzeuge,
        // 2.88: a directory entry that failed the own check (or has an unapproved new version): every tool asks.
        streng: record.trust === 'community' && (record.pruefung === 'unbekannt' || Boolean(record.versionNeu)),
    }
}

/**
 * 2.86.1 (d): a Home Assistant without its MCP server integration is used over the
 * normal HA interface (inventory, hass_* tools) — the MCP runtime leaves it alone.
 */
export function usesMcpRuntime(record: Pick<ConnectionRecord, 'connectorId' | 'weg'>): boolean {
    return record.weg !== 'rest'
}

export async function connectionServerConfig(record: ConnectionRecord, deps: LoginDeps): Promise<MCPServerConfig> {
    const name = serverNameFor(record)
    const connector = bindingOf(record)
    if (record.transport.art === 'http') {
        const config: MCPServerConfig = { name, transport: 'http', url: record.transport.url, allowLanHttp: record.datenklasse === 'lokal', connector }
        if (record.auth === 'token') {
            // e.g. n8n: the owner-entered access token (0600 file) as Bearer header, never in config files.
            const { readConnectionSecrets } = await import('../connections/connection-store.js')
            const { findConnector } = await import('../connections/connector-catalog.js')
            const field = findConnector(record.connectorId)?.zugang?.find(item => item.geheim)
            const secrets = readConnectionSecrets(record.id, deps)
            const vaultId = field ? secrets.zugangRef?.[field.env] : undefined
            if (vaultId) {
                // 2.88: the token stays in the password vault; the broker sets it per request (released host only).
                const { tresorBearerFetch } = await import('../secrets/credential-broker.js')
                config.fetch = tresorBearerFetch(vaultId, { dataDir: deps.dataDir })
            } else {
                const token = field ? secrets.zugang?.[field.env] : undefined
                if (token) config.headers = { Authorization: `Bearer ${token}` }
            }
        } else if (record.auth === 'ha-login') {
            const { haBearerFetch } = await import('../connections/connector-login.js')
            config.fetch = haBearerFetch(record.id, deps)
        } else if (record.auth === 'oauth') {
            const { oauthProviderForConnection } = await import('../connections/connector-login.js')
            getMCPClient().registerOAuthProvider(name, oauthProviderForConnection(record, deps))
        }
        return config
    }
    const { getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const { readConnectionSecrets } = await import('../connections/connection-store.js')
    const env = { ...getDefaultEnvironment(), ...(record.transport.env || {}), ...(readConnectionSecrets(record.id, deps).zugang || {}) }
    return { name, transport: 'stdio', command: record.transport.command, args: [...record.transport.args], env, connector }
}

/** Connect one approved connection and report the test (tools by policy level). */
export async function connectConnectionRecord(record: ConnectionRecord, deps: LoginDeps): Promise<ConnectionTestResult> {
    ensureListeners()
    const server = await getMCPClient().connectServer(await connectionServerConfig(record, deps))
    syncTools()
    const { connectorToolVerdict } = await import('../connections/connector-policy.js')
    const verdicts = server.tools.map(tool => connectorToolVerdict(tool, bindingOf(record)).verdict)
    return {
        ok: server.connected, at: new Date((deps.now || Date.now)()).toISOString(), werkzeuge: server.tools.length,
        lesend: verdicts.filter(verdict => verdict.decision === 'auto').length,
        fragend: verdicts.filter(verdict => verdict.decision === 'ask').length,
        gesperrt: verdicts.filter(verdict => verdict.level === 'L3').length,
    }
}

export function disconnectConnectionRecord(record: Pick<ConnectionRecord, 'id'>): void {
    getMCPClient().disconnect(serverNameFor(record))
    syncTools()
}

async function onAuthFailure(server: string): Promise<void> {
    try {
        const { loadConnections } = await import('../connections/connection-store.js')
        const record = loadConnections().find(item => serverNameFor(item) === server)
        if (!record) return
        const { markLoginExpired } = await import('../connections/connector-login.js')
        const { defaultDeps } = await import('../connections/connect-flow.js')
        await markLoginExpired(record.id, defaultDeps())
    } catch { /* the view shows the error either way */ }
}
