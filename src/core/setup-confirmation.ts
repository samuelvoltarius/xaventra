import { randomBytes } from 'node:crypto'

// ============================================
// Self-setup apply confirmations (K2 / INT-6): issued by the server, single
// use, bound to principal + target, short-lived. Never derived from the
// request, never constructible by the model. Shared by `/setup apply` and the
// `self_setup_apply` tool.
// ============================================

const SETUP_CONFIRMATION_TTL_MS = 5 * 60_000
const setupConfirmations = new Map<string, { principal: string; target: string; expiresAt: number }>()

/** Principal key used for binding: channel (case-insensitive) + canonical principal id. */
export function setupConfirmationPrincipal(channel: string | undefined, principalId: string | undefined): string {
    return `${String(channel || 'unknown').trim().toLowerCase()}:${String(principalId || '').trim()}`
}

export const setupActionTarget = (actionId: string) => `action:${actionId}`
export const setupPlanTarget = (generatedAt: string) => `all:${generatedAt}`

export function issueSetupConfirmation(principal: string, target: string): string {
    const now = Date.now()
    for (const [token, entry] of setupConfirmations) {
        if (entry.expiresAt <= now) { setupConfirmations.delete(token); continue }
        // 2.89.4: one code step — a second /freigabe for the same target returns
        // the same live code instead of a new one (the old loop invalidated codes).
        if (entry.principal === principal && entry.target === target) return token
    }
    const token = randomBytes(18).toString('base64url')
    setupConfirmations.set(token, { principal, target, expiresAt: now + SETUP_CONFIRMATION_TTL_MS })
    return token
}

/** Live code for this principal+target, or null. Never creates one. */
export function findLiveSetupConfirmation(principal: string, target: string): string | null {
    const now = Date.now()
    for (const [token, entry] of setupConfirmations) {
        if (entry.expiresAt <= now) { setupConfirmations.delete(token); continue }
        if (entry.principal === principal && entry.target === target) return token
    }
    return null
}

// 2.90.1 (Abnahme 2.90.0, Langtest C): the owner's answer to an approval request
// ("#99c5c5ff8a2f", later "Freigabecode …") is no sentence a route recognises, so
// the tool that asked was missing in exactly that turn. The router asks here which
// tool a message answers. Only a hint for offering the tool — the tool still checks
// owner, principal and the code.
const TOOL_APPROVAL_REQUEST_TTL_MS = 2 * SETUP_CONFIRMATION_TTL_MS
const MIN_DETAIL_MATCH = 6
const toolApprovalRequests = new Map<string, number>()
const toolOfTarget = (target: string): string | null => /^tool:([a-z][a-z0-9_-]{1,79}):/.exec(target)?.[1] ?? null

/** Called when an owner-approval gate refuses: the target `tool:<name>:<detail>` is open for a short while. */
export function noteToolApprovalRequest(target: string): void {
    if (toolOfTarget(target)) toolApprovalRequests.set(target, Date.now() + TOOL_APPROVAL_REQUEST_TTL_MS)
}

/** Tools a message answers: a live one-time code bound to `tool:<name>:…`, or the detail of a just-refused call. */
export function toolsReferencedByApproval(text: string): string[] {
    const value = String(text ?? '')
    if (!value.trim()) return []
    const now = Date.now()
    const names = new Set<string>()
    for (const [token, entry] of setupConfirmations) {
        if (entry.expiresAt <= now) { setupConfirmations.delete(token); continue }
        const name = toolOfTarget(entry.target)
        if (name && value.includes(token)) names.add(name)
    }
    for (const [target, expiresAt] of toolApprovalRequests) {
        if (expiresAt <= now) { toolApprovalRequests.delete(target); continue }
        const name = toolOfTarget(target)
        const detail = name ? target.slice(`tool:${name}:`.length) : ''
        if (name && detail.length >= MIN_DETAIL_MATCH && value.includes(detail)) names.add(name)
    }
    return [...names]
}

export function consumeSetupConfirmation(principal: string, target: string, token: unknown): boolean {
    if (typeof token !== 'string' || !token) return false
    const entry = setupConfirmations.get(token)
    if (!entry) return false
    if (entry.expiresAt <= Date.now()) { setupConfirmations.delete(token); return false }
    if (entry.principal !== principal || entry.target !== target) return false
    setupConfirmations.delete(token)
    return true
}
