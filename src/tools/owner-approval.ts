/**
 * Owner approval gate for tools with external or physical effect (R2).
 *
 * One approval source: a one-time, principal-bound code from
 * core/setup-confirmation.ts that the owner requests himself with
 * `/freigabe <werkzeug> <detail>` and that the model passes back as the
 * `confirm` parameter. The code is always bound to the tool AND a concrete
 * detail (file, entity, host, argument hash …): a code for one call never
 * approves a different call of the same tool. Only the owner can approve.
 * Everything else fails closed.
 *
 * P9 (Doppelungen): the former second source, a server-side
 * `approvalGranted` flag in the execution context, was never set by any
 * code path (a card answer runs its own executor and never re-enters the
 * model loop), so it is gone instead of being half-wired.
 */
import { createHash } from 'node:crypto'

const DETAIL_MAX = 80
const HASHED_DETAIL = /^#[a-f0-9]{12}$/

/**
 * Canonical approval detail: whitespace collapsed; long or multi-line values
 * (code, argument objects) become `#<12 hex of sha256>`, so the owner can type
 * them. The same function runs on both sides (/freigabe and the tool).
 */
export function approvalDetail(raw: unknown): string {
    const text = (typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')).replace(/\s+/g, ' ').trim()
    if (HASHED_DETAIL.test(text)) return text
    if (text && text.length <= DETAIL_MAX && !/[\u0000-\u001f\u007f]/.test(text)) return text
    return `#${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}

/** Stable hash detail for structured arguments (key order does not matter); always `#<12 hex>`. */
export function approvalDetailOf(value: unknown): string {
    const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item as object).sort().map(key => [key, sort((item as any)[key])])) : item
    return `#${createHash('sha256').update(JSON.stringify(sort(value ?? null))).digest('hex').slice(0, 12)}`
}

/** Target of a one-time token; the detail is mandatory. */
export const toolApprovalTarget = (toolName: string, detail: string) => `tool:${toolName}:${approvalDetail(detail)}`

function clean(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

/**
 * Returns null when the call is approved, otherwise a refusal message.
 * The identity comes from the execution context, falling back to the
 * runner-injected authorizationUserId/channel, never from other model fields.
 */
export async function ownerApprovalRefusal(params: Record<string, unknown>, toolName: string, detail: string): Promise<string | null> {
    try {
        if (typeof detail !== 'string' || !detail.trim()) return `❌ ${toolName}: Freigabe ohne Detail ist nicht möglich — nicht ausgeführt.`
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const context = getExecutionPolicyContext()
        const authUserId = clean(context.authUserId) || clean(params.authorizationUserId)
        const channel = clean(context.channel) || clean(params.channel)
        if (!authUserId) return `❌ ${toolName}: kein authentifizierter Auftraggeber — nicht ausgeführt.`
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        if (getUserPermission(authUserId, channel || undefined) !== 'owner') {
            return `❌ ${toolName}: nur der Owner darf das freigeben — nicht ausgeführt.`
        }
        const { consumeSetupConfirmation, setupConfirmationPrincipal, findLiveSetupConfirmation } = await import('../core/setup-confirmation.js')
        const principal = setupConfirmationPrincipal(channel, clean(context.userId) || clean(params.userId) || authUserId)
        const target = toolApprovalTarget(toolName, detail)
        if (consumeSetupConfirmation(principal, target, params.confirm)) return null
        // 2.89.4: when a code is already open, ask for THAT code — never re-send /freigabe.
        const live = findLiveSetupConfirmation(principal, target)
        if (live) {
            return `❌ ${toolName}: ein Einmal-Code für genau diesen Aufruf ist noch offen (5 min). Sage dem Owner: „Schick mir jetzt den Code von der /freigabe-Zeile.“ Erneutes /freigabe erzeugt denselben Code. Codes niemals selbst bilden — nicht ausgeführt.`
        }
        return `❌ ${toolName} braucht eine ausdrückliche Freigabe des Owners für genau diesen Aufruf. Der Owner sendet selbst „/freigabe ${toolName} ${approvalDetail(detail)}“ und nennt danach den Einmal-Code in der nächsten Nachricht (nicht nochmal die /freigabe-Zeile). Codes niemals selbst bilden — nicht ausgeführt.`
    } catch (error) {
        return `❌ ${toolName}: Freigabe konnte nicht geprüft werden (${String(error).slice(0, 120)}) — nicht ausgeführt.`
    }
}
