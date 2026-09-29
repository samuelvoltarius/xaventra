/**
 * Owner approval gate for tools with external or physical effect (R2).
 *
 * Reuses the two existing, model-unforgeable approval sources instead of a
 * new mechanism:
 *  - `approvalGranted` in the server-side execution policy context (the same
 *    flag the MCP client requires), set only by the pipeline after a real
 *    user confirmation;
 *  - a one-time, principal-bound token from core/setup-confirmation.ts with
 *    the target `tool:<name>`, passed back as the `confirm` parameter.
 * Only the owner can approve. Everything else fails closed.
 */

export const toolApprovalTarget = (toolName: string) => `tool:${toolName}`

function clean(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

/**
 * Returns null when the call is approved, otherwise a refusal message.
 * The identity comes from the execution context, falling back to the
 * runner-injected authorizationUserId/channel, never from other model fields.
 */
export async function ownerApprovalRefusal(params: Record<string, unknown>, toolName: string): Promise<string | null> {
    try {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const context = getExecutionPolicyContext()
        const authUserId = clean(context.authUserId) || clean(params.authorizationUserId)
        const channel = clean(context.channel) || clean(params.channel)
        if (!authUserId) return `❌ ${toolName}: kein authentifizierter Auftraggeber — nicht ausgeführt.`
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        if (getUserPermission(authUserId, channel || undefined) !== 'owner') {
            return `❌ ${toolName}: nur der Owner darf das freigeben — nicht ausgeführt.`
        }
        if (context.approvalGranted === true) return null
        const { consumeSetupConfirmation, setupConfirmationPrincipal } = await import('../core/setup-confirmation.js')
        const principal = setupConfirmationPrincipal(channel, clean(context.userId) || clean(params.userId) || authUserId)
        if (consumeSetupConfirmation(principal, toolApprovalTarget(toolName), params.confirm)) return null
        return `❌ ${toolName} braucht eine ausdrückliche Freigabe des Owners (Einmal-Code für "${toolApprovalTarget(toolName)}"). Codes niemals selbst bilden — nicht ausgeführt.`
    } catch (error) {
        return `❌ ${toolName}: Freigabe konnte nicht geprüft werden (${String(error).slice(0, 120)}) — nicht ausgeführt.`
    }
}
