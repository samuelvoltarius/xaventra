import { checkTool } from '../tools/tool-policy.js'
import { isHistoryOnlyRequest } from '../core/action-intent.js'

const governedReadOnlyTools = new Set([
    'read_file', 'list_directory', 'codebase_search', 'find_files',
    'mesh_status', 'mesh_nodes', 'nova_capabilities', 'nova_introspect', 'health_status',
    'find_capability', 'resolve_capability', 'list_sessions', 'mission_config',
    'list_reminders', 'list_sub_agents', 'nova_trace_stats',
])

export interface ToolAuthority {
    userId: string
    authUserId: string
    channel: string
    requestText: string
    governedReadOnly: boolean
}

export class ToolAuthorizationError extends Error {}

/** Called at the common execution boundary, including retries and cached calls. */
export async function authorizeToolExecution(
    name: string,
    args: Record<string, unknown>,
    authority: ToolAuthority,
): Promise<Record<string, unknown>> {
    try {
        return await authorize(name, args, authority)
    } catch (error) {
        throw new ToolAuthorizationError(`Tool authorization rejected ${name}: ${String(error)}`)
    }
}

async function authorize(name: string, args: Record<string, unknown>, authority: ToolAuthority): Promise<Record<string, unknown>> {
    const { userId, authUserId, channel, requestText, governedReadOnly } = authority
    if (isHistoryOnlyRequest(requestText)) throw new Error('Current request permits conversation recall only, not tool execution')
    const policy = checkTool(name, { userId, channel: channel.toLowerCase() })
    if (!policy.allowed || policy.needsConfirmation) {
        throw new Error(policy.reason || `Tool ${name} requires authorization or confirmation`)
    }
    if (governedReadOnly) {
        if (!governedReadOnlyTools.has(name)) throw new Error(`Read-only automation policy blocked tool: ${name}`)
    } else {
        const { isToolAllowed, getToolRestrictionMessage } = await import('../users/multi-user-middleware.js')
        // No principal is never a reason to skip authorization. Any import or
        // role-check failure rejects before idempotency, compensation or tools.
        if (!authUserId || !isToolAllowed(authUserId, name, channel)) {
            throw new Error(getToolRestrictionMessage(authUserId, name, channel))
        }
    }
    // Model-supplied arguments cannot impersonate another user or their consent.
    return { ...args, userId, channel, authorizationUserId: authUserId, requestText }
}
