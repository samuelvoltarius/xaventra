/**
 * Tool Policy — Per-Tool Access Control
 *
 * Controls which tools are available based on channel, user, and config.
 * Supports allow/deny/confirm actions.
 */

import { getDesktopAgentContext } from '../desktop/desktop-agent-context.js'

// ============================================
// Types
// ============================================

export type PolicyAction = 'allow' | 'deny' | 'confirm'

export interface PolicyRule {
    /** Tool name pattern — exact string or glob with * */
    tool: string
    /** Action to take */
    action: PolicyAction
    /** Only apply to these channels (undefined = all) */
    channels?: string[]
    /** Only apply to these users (undefined = all) */
    users?: string[]
    /** Reason for the policy (shown to user on deny) */
    reason?: string
}

export interface ToolPolicy {
    /** Default action when no rule matches. Default: 'allow' */
    defaultAction: PolicyAction
    /** Ordered rules — first match wins */
    rules: PolicyRule[]
}

export const DEFAULT_POLICY: ToolPolicy = {
    defaultAction: 'allow',
    rules: [
        // SSH only on CLI channel
        { tool: 'ssh_*', action: 'deny', channels: ['telegram', 'discord', 'whatsapp'], reason: 'SSH nur über CLI erlaubt' },
        // Desktop tools are denied on EVERY channel (cli/web/api/rest included).
        // They are reachable only through the explicit grant paths in
        // checkTool() or an explicit operator allow rule.
        { tool: 'desktop_*', action: 'deny', reason: 'Desktop-Steuerung nur lokal über den authentifizierten Nova-Desktop-Client oder mit expliziter Owner-Freigabe' },
        // R2 T11: screen and webcam capture are desktop access under another
        // name; same lock (explicit operator allow rule required).
        { tool: 'screen_capture', action: 'deny', reason: 'Bildschirmaufnahme wie Desktop-Steuerung nur mit expliziter Owner-Freigabe' },
        { tool: 'webcam_capture', action: 'deny', reason: 'Webcam-Aufnahme wie Desktop-Steuerung nur mit expliziter Owner-Freigabe' },
        // Self-management requires confirmation
        { tool: 'self_extend', action: 'confirm', reason: 'Self-Extension erfordert Bestätigung' },
        { tool: 'self_manage', action: 'confirm', reason: 'Self-Management erfordert Bestätigung' },
    ],
}

// ============================================
// Policy Evaluation
// ============================================

/**
 * Check if a tool name matches a pattern (supports * glob).
 */
function matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (!pattern.includes('*')) return toolName === pattern

    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return regex.test(toolName)
}

/**
 * Evaluate whether a tool call is allowed by the policy.
 */
export function evaluatePolicy(
    toolName: string,
    context: { channel?: string; userId?: string },
    policy: ToolPolicy = DEFAULT_POLICY
): { action: PolicyAction; reason?: string } {
    for (const rule of policy.rules) {
        if (!matchesPattern(toolName, rule.tool)) continue

        // Check channel restriction
        if (rule.channels) {
            if (!rule.channels.includes(context.channel)) continue
        }

        // Check user restriction
        if (rule.users) {
            if (!rule.users.includes(context.userId)) continue
        }

        return { action: rule.action, reason: rule.reason }
    }

    return { action: policy.defaultAction }
}

// ============================================
// Config Integration
// ============================================

let currentPolicy: ToolPolicy = DEFAULT_POLICY

/** Tools the authenticated Nova Desktop client executes on its own machine. */
const DESKTOP_CLIENT_TOOLS = ['desktop_workspace', 'desktop_control', 'desktop_status', 'desktop_screenshot']

/**
 * Load policy from nova config.
 */
export function loadPolicy(config?: { toolPolicy?: Partial<ToolPolicy> }): void {
    if (config?.toolPolicy) {
        currentPolicy = {
            defaultAction: config.toolPolicy.defaultAction || DEFAULT_POLICY.defaultAction,
            rules: [
                ...(config.toolPolicy.rules || []),
                ...DEFAULT_POLICY.rules,
            ],
        }
        console.log(`[ToolPolicy] Loaded ${currentPolicy.rules.length} rules`)
    }
}

/**
 * Get the current active policy.
 */
export function getPolicy(): ToolPolicy {
    return currentPolicy
}

/**
 * Check a tool call against the current policy.
 */
export function checkTool(
    toolName: string,
    context: { channel?: string; userId?: string; authUserId?: string }
): { allowed: boolean; needsConfirmation: boolean; reason?: string } {
    const owner=process.env.NOVA_DESKTOP_TELEGRAM_OWNER_ID
    const enrolled=owner&&context.authUserId===owner&&/^[1-9][0-9]*$/.test(owner)&&process.env.NOVA_CAPTURE_SOCKET&&process.env.NOVA_CAPTURE_TOKEN_FILE
    const grants:PolicyRule[]=[]
    // Grant 1: the enrolled workstation owner, Telegram only.
    if(enrolled){
        grants.push({tool:'desktop_screenshot',action:'allow',channels:['telegram']})
        if(process.env.NOVA_DESKTOP_INPUT_ENABLED==='1')grants.push({tool:'desktop_input',action:'allow',channels:['telegram']})
    }
    // Grant 2: the authenticated Nova Desktop client (AsyncLocalStorage set by
    // the desktop API after client authentication, not a spoofable channel
    // string alone) for its own client-side tools. Never desktop_input.
    const client=getDesktopAgentContext()
    if(client?.clientId&&client.principalId&&context.channel==='desktop'){
        for(const tool of DESKTOP_CLIENT_TOOLS)grants.push({tool,action:'allow',channels:['desktop']})
    }
    const rules=grants.length ? [
        ...currentPolicy.rules.filter(r=>!DEFAULT_POLICY.rules.includes(r)),
        ...grants,
        ...DEFAULT_POLICY.rules,
    ] : currentPolicy.rules
    const result = evaluatePolicy(toolName, context, {...currentPolicy,rules})

    return {
        allowed: result.action !== 'deny',
        needsConfirmation: result.action === 'confirm',
        reason: result.reason,
    }
}

export default { evaluatePolicy, loadPolicy, getPolicy, checkTool, DEFAULT_POLICY }
