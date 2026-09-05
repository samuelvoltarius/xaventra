#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
    AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError,
    type Agent, type AuthenticateRequest, type CancelNotification, type InitializeRequest,
    type InitializeResponse, type NewSessionRequest, type NewSessionResponse,
    type PromptRequest, type PromptResponse, type Stream,
} from '@agentclientprotocol/sdk'
import { getLifecyclePolicy } from '../core/lifecycle-policy.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import { getMissionWorkspaceManager } from '../runtime/mission-workspace.js'

interface AcpSession {
    id: string
    cwd: string
    controller?: AbortController
    workspaceId?: string
    principalId: string
}

const READ_ONLY_TOOLS = new Set([
    'read_file', 'read_document', 'list_directory', 'find_files', 'codebase_search', 'code_outline',
    'lsp_query', 'runtime_capabilities', 'memory_recall', 'kg_search', 'health_status', 'nova_capabilities',
])

function runtimeVersion(): string {
    try { return String(JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0') }
    catch { return '0.0.0' }
}

function invalid(detail: string): RequestError { return RequestError.invalidParams(undefined, detail) }

export function acpPromptToText(prompt: unknown[]): string {
    return prompt.map((block: any) => {
        if (block?.type === 'text') return String(block.text || '')
        if (block?.type === 'resource_link') return `[resource_link name=${String(block.name || '')} uri=${String(block.uri || '')}]`
        throw invalid('Nova ACP supports text and resource_link prompt blocks only')
    }).join('\n')
}

export function validateAcpSessionRequest(params: NewSessionRequest): string {
    if (!isAbsolute(params.cwd)) throw invalid('session cwd must be absolute')
    const cwd = resolve(params.cwd)
    if (!existsSync(cwd)) throw invalid('session cwd does not exist')
    if ((params.additionalDirectories || []).length) throw invalid('additional directories are not supported')
    if ((params.mcpServers || []).length) throw invalid('per-session MCP servers are not supported; use Nova MCP configuration')
    return cwd
}

export function createNovaAcpAgent(connection: AgentSideConnection): Agent {
    const sessions = new Map<string, AcpSession>()
    const writable = process.env.NOVA_ACP_WRITE === '1'
    const approvalUnregister = getLifecyclePolicy().register({
        id: `acp-approval-${randomUUID()}`, event: 'tool.before', priority: 50, failClosed: true,
        handler: async payload => {
            const principal = payload.context.userId || ''
            if (!principal.startsWith('acp:') || !writable || !payload.toolName) return
            const session = [...sessions.values()].find(item => item.principalId === principal)
            if (!session) return { decision: 'deny', reason: 'ACP session is no longer active' }
            const toolCallId = randomUUID()
            await connection.sessionUpdate({ sessionId: session.id, update: { sessionUpdate: 'tool_call', toolCallId, title: payload.toolName, kind: 'other', status: 'pending', rawInput: payload.input || {} } as any })
            const response = await connection.requestPermission({
                sessionId: session.id,
                toolCall: { toolCallId, title: payload.toolName, kind: 'other', status: 'pending', rawInput: payload.input || {} },
                options: [
                    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                ],
            })
            if (response.outcome.outcome === 'cancelled') return { decision: 'deny', reason: 'ACP permission request cancelled' }
            return response.outcome.optionId === 'allow-once' ? { decision: 'allow' } : { decision: 'deny', reason: 'ACP client rejected tool call' }
        },
    })
    connection.signal.addEventListener('abort', () => {
        approvalUnregister()
        for (const session of sessions.values()) session.controller?.abort()
        sessions.clear()
    }, { once: true })

    return {
        async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
            return {
                protocolVersion: PROTOCOL_VERSION,
                agentInfo: { name: 'nova-acp', version: String((globalThis as any).__novaVersion || runtimeVersion()) },
                agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false }, loadSession: false },
                authMethods: [],
            }
        },
        async authenticate(_params: AuthenticateRequest): Promise<void> {},
        async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
            const cwd = validateAcpSessionRequest(params)
            const id = randomUUID()
            let workspaceId: string | undefined
            if (writable) {
                const workspace = await getMissionWorkspaceManager().create({ missionId: `acp-${id}`, mode: 'worktree', repository: cwd })
                workspaceId = workspace.id
            }
            sessions.set(id, { id, cwd, workspaceId, principalId: `acp:${id}` })
            return { sessionId: id }
        },
        async prompt(params: PromptRequest): Promise<PromptResponse> {
            const session = sessions.get(params.sessionId)
            if (!session) throw invalid(`unknown session: ${params.sessionId}`)
            if (session.controller) throw invalid('a prompt is already in flight for this session')
            const text = acpPromptToText(params.prompt as unknown[])
            if (!text.trim()) throw invalid('empty prompt')
            const controller = new AbortController()
            session.controller = controller
            try {
                const [{ runNovaAgent }, { createNovaLLMClient }] = await Promise.all([import('../agents/nova-runner.js'), import('../llm/nova-llm-sdk.js')])
                const tools = getToolRegistry().getAll().filter(tool => writable
                    ? !['ssh_command', 'send_telegram', 'send_email', 'deploy', 'self_evolve'].includes(tool.name)
                    : READ_ONLY_TOOLS.has(tool.name))
                const result = await runNovaAgent({
                    userId: session.principalId, channel: 'acp', content: text,
                    systemPrompt: `You are Nova through ACP. Workspace: ${session.cwd}. Use tools and return verified results only.`,
                    llm: await createNovaLLMClient({ role: 'code' }), tools, abortSignal: controller.signal, workspaceId: session.workspaceId,
                })
                for (const execution of result.toolExecutions || []) {
                    await connection.sessionUpdate({
                        sessionId: session.id,
                        update: { sessionUpdate: 'tool_call', toolCallId: randomUUID(), title: execution.toolName, kind: 'other', status: execution.success ? 'completed' : 'failed', rawInput: execution.params, rawOutput: execution.result } as any,
                    })
                }
                if (result.content) await connection.sessionUpdate({ sessionId: session.id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.content } } })
                return { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' }
            } catch (error) {
                if (controller.signal.aborted) return { stopReason: 'cancelled' }
                throw error
            } finally {
                session.controller = undefined
            }
        },
        async cancel(params: CancelNotification): Promise<void> { sessions.get(params.sessionId)?.controller?.abort(new Error('ACP client cancelled')) },
    }
}

export function startNovaAcpServer(stream?: Stream): AgentSideConnection {
    const transport = stream || ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    )
    return new AgentSideConnection(connection => createNovaAcpAgent(connection), transport)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/acp/acp-server.js')) {
    startNovaAcpServer()
}
