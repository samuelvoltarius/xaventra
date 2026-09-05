/**
 * Nova MCP Gateway
 *
 * Canonical MCP client for stdio and Streamable HTTP servers. The official
 * SDK owns protocol negotiation, schema validation, list-changed
 * notifications and reconnection semantics. Nova owns policy, namespacing,
 * audit, user/node OAuth scope and Tool-Evidence validation.
 */

import { EventEmitter } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { NovaTool } from '../tools/complete-registry.js'

export interface MCPTool {
    name: string
    description: string
    inputSchema: {
        type: 'object'
        properties?: Record<string, Record<string, unknown>>
        required?: string[]
        [key: string]: unknown
    }
    outputSchema?: Record<string, unknown>
}

export interface MCPResource {
    uri: string
    name: string
    description?: string
    mimeType?: string
}

export interface MCPPrompt {
    name: string
    description?: string
    arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface MCPServerConfig {
    name: string
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    enabled?: boolean
    allowInsecureHttp?: boolean
    allowedTools?: string[]
    deniedTools?: string[]
    requireApproval?: boolean
    reconnect?: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number }
}

export interface MCPServer {
    name: string
    transport: MCPServerConfig['transport']
    tools: MCPTool[]
    resources: MCPResource[]
    prompts: MCPPrompt[]
    connected: boolean
    protocolVersion?: string
    serverVersion?: string
    lastConnectedAt?: string
    lastError?: string
}

interface Session {
    config: MCPServerConfig
    client: Client
    transport: Transport
    state: MCPServer
    reconnectAttempts: number
    reconnectTimer?: ReturnType<typeof setTimeout>
    closing: boolean
}

function safeName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp'
}

function resolveEnv(value: string): string {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, key) => process.env[key] || '')
}

function redactError(error: unknown): string {
    return String(error instanceof Error ? error.message : error)
        .replace(/(?:bearer|token|authorization|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .slice(0, 500)
}

function assertHttpTarget(config: MCPServerConfig): URL {
    if (!config.url) throw new Error(`MCP server ${config.name}: url is required`)
    const url = new URL(config.url)
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(config.allowInsecureHttp && local)) {
        throw new Error(`MCP server ${config.name}: HTTP transport must use HTTPS (or explicitly allow loopback HTTP)`)
    }
    return url
}

function permitted(config: MCPServerConfig, tool: string): boolean {
    if (config.deniedTools?.includes(tool)) return false
    return !config.allowedTools?.length || config.allowedTools.includes(tool)
}

function parameterType(schema: Record<string, unknown>): 'string' | 'number' | 'boolean' | 'object' {
    const value = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type
    if (value === 'integer' || value === 'number') return 'number'
    if (value === 'boolean') return 'boolean'
    if (value === 'object' || value === 'array') return 'object'
    return 'string'
}

export class MCPClient extends EventEmitter {
    private readonly sessions = new Map<string, Session>()
    private readonly oauthProviders = new Map<string, OAuthClientProvider>()

    registerOAuthProvider(serverName: string, provider: OAuthClientProvider): void {
        this.oauthProviders.set(serverName, provider)
    }

    /** Backwards-compatible stdio connector. */
    async connect(name: string, command: string, args: string[] = []): Promise<MCPServer> {
        return this.connectServer({ name, transport: 'stdio', command, args })
    }

    async connectServer(config: MCPServerConfig): Promise<MCPServer> {
        if (config.enabled === false) throw new Error(`MCP server ${config.name} is disabled`)
        if (this.sessions.has(config.name)) await this.disconnect(config.name)

        let session: Session
        const client = new Client({ name: 'nova', version: process.env.npm_package_version || '2' }, {
            capabilities: {},
            listChanged: {
                tools: { onChanged: () => { void this.refresh(config.name) } },
                resources: { onChanged: () => { void this.refresh(config.name) } },
                prompts: { onChanged: () => { void this.refresh(config.name) } },
            },
        })
        const transport = this.createTransport(config)
        session = {
            config: { ...config },
            client,
            transport,
            reconnectAttempts: 0,
            closing: false,
            state: { name: config.name, transport: config.transport, tools: [], resources: [], prompts: [], connected: false },
        }
        this.sessions.set(config.name, session)
        transport.onclose = () => this.onClosed(config.name)
        transport.onerror = error => this.onTransportError(config.name, error)
        try {
            await client.connect(transport)
            session.state.connected = true
            session.state.lastConnectedAt = new Date().toISOString()
            session.state.protocolVersion = (transport as StreamableHTTPClientTransport).protocolVersion
            const version = client.getServerVersion()
            session.state.serverVersion = version ? `${version.name}/${version.version}` : undefined
            session.reconnectAttempts = 0
            await this.refresh(config.name)
            this.emit('connected', this.snapshot(session.state))
            return this.snapshot(session.state)
        } catch (error) {
            session.state.lastError = redactError(error)
            this.sessions.delete(config.name)
            await transport.close().catch(() => undefined)
            throw new Error(`MCP ${config.name} connection failed: ${session.state.lastError}`)
        }
    }

    private createTransport(config: MCPServerConfig): Transport {
        if (config.transport === 'stdio') {
            if (!config.command) throw new Error(`MCP server ${config.name}: command is required`)
            const env = Object.fromEntries(Object.entries(config.env || {}).map(([key, value]) => [key, resolveEnv(value)]))
            return new StdioClientTransport({
                command: config.command,
                args: config.args || [],
                cwd: config.cwd,
                env: Object.keys(env).length ? env : undefined,
                stderr: 'pipe',
            })
        }
        const headers = Object.fromEntries(Object.entries(config.headers || {}).map(([key, value]) => [key, resolveEnv(value)]))
        return new StreamableHTTPClientTransport(assertHttpTarget(config), {
            authProvider: this.oauthProviders.get(config.name),
            requestInit: Object.keys(headers).length ? { headers } : undefined,
            reconnectionOptions: {
                maxRetries: config.reconnect?.maxRetries ?? 4,
                initialReconnectionDelay: config.reconnect?.initialDelayMs ?? 500,
                maxReconnectionDelay: config.reconnect?.maxDelayMs ?? 30_000,
                reconnectionDelayGrowFactor: 2,
            },
        })
    }

    async refresh(serverName: string): Promise<MCPServer> {
        const session = this.requireSession(serverName)
        const [tools, resources, prompts] = await Promise.all([
            this.collectPages(cursor => session.client.listTools(cursor ? { cursor } : undefined), 'tools'),
            this.hasCapability(session, 'resources') ? this.collectPages(cursor => session.client.listResources(cursor ? { cursor } : undefined), 'resources') : Promise.resolve([]),
            this.hasCapability(session, 'prompts') ? this.collectPages(cursor => session.client.listPrompts(cursor ? { cursor } : undefined), 'prompts') : Promise.resolve([]),
        ])
        session.state.tools = (tools as MCPTool[]).filter(tool => permitted(session.config, tool.name))
        session.state.resources = resources as MCPResource[]
        session.state.prompts = prompts as MCPPrompt[]
        session.state.connected = true
        session.state.lastError = undefined
        this.emit('catalogChanged', this.snapshot(session.state))
        return this.snapshot(session.state)
    }

    private hasCapability(session: Session, capability: 'resources' | 'prompts'): boolean {
        return Boolean(session.client.getServerCapabilities()?.[capability])
    }

    private async collectPages(loader: (cursor?: string) => Promise<any>, key: 'tools' | 'resources' | 'prompts'): Promise<unknown[]> {
        const items: unknown[] = []
        let cursor: string | undefined
        do {
            const page = await loader(cursor)
            items.push(...(page[key] || []))
            cursor = page.nextCursor
        } while (cursor)
        return items
    }

    async listTools(serverName: string): Promise<MCPTool[]> {
        return [...this.requireSession(serverName).state.tools]
    }

    async callTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
        const session = this.requireSession(serverName)
        if (!permitted(session.config, toolName)) throw new Error(`MCP tool denied by server policy: ${serverName}/${toolName}`)
        if (!session.state.tools.some(tool => tool.name === toolName)) throw new Error(`MCP tool not advertised: ${serverName}/${toolName}`)
        if (session.config.requireApproval) {
            const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
            if (!getExecutionPolicyContext().approvalGranted) throw new Error(`MCP tool requires approval: ${serverName}/${toolName}`)
        }
        const result = await session.client.callTool({ name: toolName, arguments: args })
        return { ...result, mcp: { server: serverName, tool: toolName, verifiedTransport: true } }
    }

    async listResources(serverName: string): Promise<MCPResource[]> {
        return [...this.requireSession(serverName).state.resources]
    }

    async readResource(serverName: string, uri: string): Promise<unknown> {
        return this.requireSession(serverName).client.readResource({ uri })
    }

    async listPrompts(serverName: string): Promise<MCPPrompt[]> {
        return [...this.requireSession(serverName).state.prompts]
    }

    async getPrompt(serverName: string, name: string, args: Record<string, string> = {}): Promise<unknown> {
        return this.requireSession(serverName).client.getPrompt({ name, arguments: args })
    }

    asNovaTools(): NovaTool[] {
        return [...this.sessions.values()].flatMap(session => session.state.tools.map(tool => ({
            name: `mcp__${safeName(session.config.name)}__${safeName(tool.name)}`,
            description: `[MCP:${session.config.name}] ${tool.description || tool.name}`,
            category: 'other' as const,
            parameters: Object.entries(tool.inputSchema.properties || {}).map(([name, schema]) => ({
                name,
                type: parameterType(schema),
                description: String(schema.description || name),
                required: tool.inputSchema.required?.includes(name),
            })),
            handler: (params: Record<string, unknown>) => this.callTool(session.config.name, tool.name, params),
        })))
    }

    listServers(): MCPServer[] {
        return [...this.sessions.values()].map(session => this.snapshot(session.state))
    }

    getServer(name: string): MCPServer | undefined {
        const state = this.sessions.get(name)?.state
        return state ? this.snapshot(state) : undefined
    }

    disconnect(serverName: string): void {
        const session = this.sessions.get(serverName)
        if (!session) return
        session.closing = true
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
        this.sessions.delete(serverName)
        void session.transport.close().catch(() => undefined)
        session.state.connected = false
        this.emit('disconnected', this.snapshot(session.state))
    }

    disconnectAll(): void {
        for (const name of [...this.sessions.keys()]) this.disconnect(name)
    }

    private onTransportError(name: string, error: Error): void {
        const session = this.sessions.get(name)
        if (!session) return
        session.state.lastError = redactError(error)
        this.emit('error', { server: name, error: session.state.lastError })
    }

    private onClosed(name: string): void {
        const session = this.sessions.get(name)
        if (!session || session.closing) return
        session.state.connected = false
        this.emit('disconnected', this.snapshot(session.state))
        const max = session.config.reconnect?.maxRetries ?? 4
        if (session.reconnectAttempts >= max) return
        const base = session.config.reconnect?.initialDelayMs ?? 500
        const cap = session.config.reconnect?.maxDelayMs ?? 30_000
        const delay = Math.min(cap, base * (2 ** session.reconnectAttempts++))
        session.reconnectTimer = setTimeout(() => {
            const config = { ...session.config }
            this.sessions.delete(name)
            void this.connectServer(config).catch(error => this.emit('error', { server: name, error: redactError(error) }))
        }, delay)
        if (session.reconnectTimer.unref) session.reconnectTimer.unref()
    }

    private requireSession(name: string): Session {
        const session = this.sessions.get(name)
        if (!session?.state.connected) throw new Error(`MCP server not connected: ${name}`)
        return session
    }

    private snapshot(state: MCPServer): MCPServer {
        return { ...state, tools: state.tools.map(tool => ({ ...tool })), resources: state.resources.map(resource => ({ ...resource })), prompts: state.prompts.map(prompt => ({ ...prompt })) }
    }
}

let mcpClient: MCPClient | null = null
export function getMCPClient(): MCPClient {
    return mcpClient ||= new MCPClient()
}

export default { MCPClient, getMCPClient }
