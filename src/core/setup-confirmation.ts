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

export function consumeSetupConfirmation(principal: string, target: string, token: unknown): boolean {
    if (typeof token !== 'string' || !token) return false
    const entry = setupConfirmations.get(token)
    if (!entry) return false
    if (entry.expiresAt <= Date.now()) { setupConfirmations.delete(token); return false }
    if (entry.principal !== principal || entry.target !== target) return false
    setupConfirmations.delete(token)
    return true
}
