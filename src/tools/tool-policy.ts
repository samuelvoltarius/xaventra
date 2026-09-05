/**
 * Tool Policy — Per-Tool Access Control
 *
 * Controls which tools are available based on channel, user, and config.
 * Supports allow/deny/confirm actions.
 */

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
        // Desktop control only on CLI
        { tool: 'desktop_*', action: 'deny', channels: ['telegram', 'discord', 'whatsapp'], reason: 'Desktop-Steuerung nur lokal' },
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
        if (rule.channels && context.channel) {
            if (!rule.channels.includes(context.channel)) continue
        }

        // Check user restriction
        if (rule.users && context.userId) {
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
    context: { channel?: string; userId?: string }
): { allowed: boolean; needsConfirmation: boolean; reason?: string } {
    const result = evaluatePolicy(toolName, context, currentPolicy)

    return {
        allowed: result.action !== 'deny',
        needsConfirmation: result.action === 'confirm',
        reason: result.reason,
    }
}

export default { evaluatePolicy, loadPolicy, getPolicy, checkTool, DEFAULT_POLICY }
