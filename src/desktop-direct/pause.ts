/**
 * /desktop „Übernehmen“: while Alfred controls a desktop that Xaventra's own
 * desktop_input acts on, the agent's input is paused. Kept free of the gateway so
 * the input tool can ask without loading the gateway.
 */

import { ownerName } from '../memory/owner-profile.js'

const holds = new Map<string, string>()

/** Register a takeover hold (one per session); returns a release function. */
export function holdAgentDesktopInput(holdId: string, desktopId: string): () => void {
    holds.set(holdId, desktopId)
    return () => { holds.delete(holdId) }
}

/** null = agent input allowed; otherwise a short German reason (no ids, no secrets). */
export function agentDesktopInputPauseReason(): string | null {
    if (holds.size === 0) return null
    const desktops = [...new Set(holds.values())].join(', ')
    return `Desktop-Eingabe pausiert: ${ownerName()} hat den Desktop übernommen (${desktops}). Erst nach „Zurückgeben“ oder Sitzungsende wieder möglich.`
}

/** Test helper. */
export function clearAgentDesktopInputHolds(): void {
    holds.clear()
}
