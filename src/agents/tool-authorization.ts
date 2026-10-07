import { checkTool } from '../tools/tool-policy.js'
import { isConversationOnly, isHistoryOnlyRequest } from '../core/action-intent.js'

/**
 * Tools a governed read-only run (autonomy self-goals, internal diagnostics, benchmark)
 * may run. 2.89: process_list joins (it only reads the process table); port_scan stays
 * out. The same set decides what such a run is OFFERED (nova-runner) — the model never
 * sees a tool this policy would block (live: 5× port_scan / process_list blocked).
 */
const governedReadOnlyTools: ReadonlySet<string> = new Set([
    'read_file', 'list_directory', 'codebase_search', 'find_files',
    'mesh_status', 'mesh_nodes', 'nova_capabilities', 'nova_introspect', 'health_status',
    'find_capability', 'resolve_capability', 'list_sessions', 'mission_config',
    'list_reminders', 'list_sub_agents', 'nova_trace_stats',
    'blue_asset_inventory', 'environment_inventory', 'mesh_services',
    'process_list',
])

export function isGovernedReadOnlyTool(name: string): boolean {
    return governedReadOnlyTools.has(name)
}

/** One rule for "is this a governed read-only run?" — used for the offer and for execution. */
export function isGovernedReadOnlyRun(input: {
    channel: string
    internal: boolean
    allowedChanges: { readOnly?: boolean; externalSideEffects?: boolean }
}): boolean {
    return (input.channel === 'benchmark' || input.internal)
        && input.allowedChanges.readOnly === true
        && input.allowedChanges.externalSideEffects === false
}

const toolPolicyManagementTools = new Set(['set_tool_policy', 'list_tool_policies'])

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
    if (isConversationOnly(requestText)) throw new Error('Current statement or explanation does not authorize tool execution')
    const policy = checkTool(name, { userId, authUserId, channel: channel.toLowerCase() })
    if (!policy.allowed || policy.needsConfirmation) {
        throw new Error(policy.reason || `Tool ${name} requires authorization or confirmation`)
    }
    // Owner rules from set_tool_policy. 'allow' never widens the role check below;
    // 'deny' and 'confirm' (no confirmation path here) block. The policy tools
    // themselves stay usable so a broad rule cannot lock the owner out.
    if (!toolPolicyManagementTools.has(name)) {
        const { checkToolPolicy } = await import('./agent-patterns.js')
        const custom = checkToolPolicy(name, userId)
        if (custom.action !== 'allow') {
            throw new Error(custom.reason || `Tool policy ${custom.action} blocks ${name}`)
        }
    }
    if (governedReadOnly) {
        if (!isGovernedReadOnlyTool(name)) throw new Error(`Read-only automation policy blocked tool: ${name}`)
        if (['blue_asset_inventory', 'environment_inventory', 'mesh_services'].includes(name)) {
            const { isToolAllowed, getToolRestrictionMessage } = await import('../users/multi-user-middleware.js')
            if (!authUserId || !isToolAllowed(authUserId, name, channel)) throw new Error(getToolRestrictionMessage(authUserId, name, channel))
        }
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
