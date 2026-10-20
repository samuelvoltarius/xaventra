/**
 * 2.89.8 (U3): is the owner waiting for an answer right now?
 *
 * Live: ~190 chat-model timeouts while goal planning, fact checks, learning and summaries
 * competed with the owner's request for the same (often single) model. Background LLM work
 * asks this module and steps aside while an owner turn (Telegram, Desktop, HUD, ...) runs.
 * Only authenticated OWNER turns count - never autonomy/system authored messages, guests or probes.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface TurnToken { active: boolean }

const als = new AsyncLocalStorage<TurnToken>()
let activeTurns = 0
let lastTurnEndedAt = 0
/** After an owner turn ended, background work still waits this long (follow-up questions come in bursts). */
export const OWNER_GRACE_MS = 3_000

export class OwnerBusyError extends Error {
    readonly deferred = true
    constructor(what: string) { super(`Deferred: owner request running (${what})`) }
}

/** Wrap one message turn. It only counts once markOwnerTurn() has confirmed an owner. */
export function runAsPotentialOwnerTurn<T>(fn: () => Promise<T>): Promise<T> {
    const token: TurnToken = { active: false }
    return als.run(token, async () => {
        try { return await fn() } finally {
            if (token.active) { token.active = false; activeTurns = Math.max(0, activeTurns - 1); lastTurnEndedAt = Date.now() }
        }
    })
}

/** Called by the pipeline after authentication. System-authored turns never count. */
export function markOwnerTurn(permission: string | undefined, systemAuthored: boolean): void {
    const token = als.getStore()
    if (!token || token.active || systemAuthored || permission !== 'owner') return
    token.active = true
    activeTurns++
}

export function ownerTurnActive(now = Date.now(), graceMs = OWNER_GRACE_MS): boolean {
    return activeTurns > 0 || (lastTurnEndedAt > 0 && now - lastTurnEndedAt < graceMs)
}

/** Background LLM jobs call this first; it throws OwnerBusyError (not a failure) while the owner is served. */
export function deferWhileOwnerBusy(what: string): void {
    if (ownerTurnActive()) throw new OwnerBusyError(what)
}

/** Tests only. */
export function _resetOwnerActivityForTest(): void { activeTurns = 0; lastTurnEndedAt = 0 }
