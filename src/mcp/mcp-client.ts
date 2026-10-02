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
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { NovaTool } from '../tools/complete-registry.js'
import type { ConnectorBinding, ToolAnnotations } from '../connections/connector-policy.js'

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
    /** MCP tool annotations (hints from the server; mapped by connections/connector-policy.ts). */
    annotations?: ToolAnnotations
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
    /** 2.85 Paket A: connector manifest binding → every tool goes through the action policy. */
    connector?: ConnectorBinding
    /** 2.85: plain HTTP only to a private LAN/Tailnet address (local connectors such as Home Assistant). */
    allowLanHttp?: boolean
    /** 2.85: custom fetch (e.g. Home Assistant login: fresh bearer per request). Code only, never from config files. */
    fetch?: FetchLike
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
    /** Connector servers: tools whose calls ask the owner (L2), and refused ones (L3) with the reason. */
    policy?: { ask: Set<string>; never: Map<string, string> }
}

function safeName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp'
}

/** Nova-side tool name of an MCP tool (also the name in `/freigabe`). */
export function mcpNovaToolName(serverName: string, toolName: string): string {
    return `mcp__${safeName(serverName)}__${safeName(toolName)}`
}

/** Runner-injected identity fields and the approval code never reach the MCP server or the bound detail. */
const LOCAL_ONLY_ARGS = new Set(['confirm', 'userId', 'channel', 'authorizationUserId', 'requestText'])

function resolveEnv(value: string): string {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, key) => process.env[key] || '')
}

function redactError(error: unknown): string {
    return String(error instanceof Error ? error.message : error)
        .replace(/(?:bearer|token|authorization|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .slice(0, 500)
}

/** Private LAN/Tailnet hosts (RFC 1918, 100.64/10, link-local names). */
export function isPrivateLanHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (/\.local$/.test(host) && /^[a-z0-9.-]{1,100}$/.test(host)) return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    if (!m) return false
    const [a, b] = [Number(m[1]), Number(m[2])]
    if ([a, b, Number(m[3]), Number(m[4])].some(part => part > 255)) return false
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

function assertHttpTarget(config: MCPServerConfig): URL {
    if (!config.url) throw new Error(`MCP server ${config.name}: url is required`)
    const url = new URL(config.url)
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    const lan = Boolean(config.allowLanHttp && isPrivateLanHost(url.hostname))
    if (url.protocol !== 'https:' && !(config.allowInsecureHttp && local) && !lan) {
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
            ...(config.fetch ? { fetch: config.fetch } : {}),
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
        let visible = (tools as MCPTool[]).filter(tool => permitted(session.config, tool.name))
        if (session.config.connector) {
            // 2.85: one action policy for every connector tool; hidden tools are never advertised.
            const { connectorToolVerdict } = await import('../connections/connector-policy.js')
            const policy = { ask: new Set<string>(), never: new Map<string, string>() }
            visible = visible.filter(tool => {
                const result = connectorToolVerdict(tool, session.config.connector!)
                if (!result.sichtbar) return false
                if (result.verdict.level === 'L3') policy.never.set(tool.name, result.verdict.reason)
                else if (result.verdict.decision !== 'auto') policy.ask.add(tool.name)
                return true
            })
            session.policy = policy
        }
        session.state.tools = visible
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
        let callArgs = args
        const never = session.policy?.never.get(toolName)
        if (never) throw new Error(`MCP tool ${serverName}/${toolName} nicht erlaubt (${never}); ich führe das nicht aus.`)
        if (session.config.connector) {
            const { cloudPrivacyRefusal } = await import('../connections/connector-policy.js')
            const refusal = cloudPrivacyRefusal(Object.fromEntries(Object.entries(args).filter(([key]) => !LOCAL_ONLY_ARGS.has(key))), session.config.connector)
            if (refusal) throw new Error(refusal)
        }
        if (session.config.requireApproval || session.policy?.ask.has(toolName)) {
            // P9: the owner's one-time code, bound to server, tool and the exact arguments
            // (hash detail). The former context flag was never set and is gone.
            callArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !LOCAL_ONLY_ARGS.has(key)))
            const { approvalDetailOf, ownerApprovalRefusal } = await import('../tools/owner-approval.js')
            const refusal = await ownerApprovalRefusal(args, mcpNovaToolName(serverName, toolName), approvalDetailOf(callArgs))
            if (refusal) throw new Error(`MCP tool requires approval: ${serverName}/${toolName}. ${refusal}`)
        }
        if (session.config.connector && callArgs === args) callArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !LOCAL_ONLY_ARGS.has(key)))
        const result = await session.client.callTool({ name: toolName, arguments: callArgs })
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
            name: mcpNovaToolName(session.config.name, tool.name),
            description: `[MCP:${session.config.name}] ${tool.description || tool.name}`,
            category: 'other' as const,
            parameters: [
                ...Object.entries(tool.inputSchema.properties || {}).map(([name, schema]) => ({
                    name,
                    type: parameterType(schema),
                    description: String(schema.description || name),
                    required: tool.inputSchema.required?.includes(name),
                })),
                ...(session.config.requireApproval || session.policy?.ask.has(tool.name)
                    ? [{ name: 'confirm', type: 'string' as const, description: 'Einmal-Freigabecode des Owners für genau diesen Aufruf. Niemals selbst bilden.', required: false }]
                    : []),
            ],
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
