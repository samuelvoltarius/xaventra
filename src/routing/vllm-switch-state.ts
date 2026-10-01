/**
 * Phase 8 — "Modellwechsel läuft": process-wide marker read by the local LLM
 * provider. While a vLLM switch runs, calls to that vLLM endpoint are not
 * attempted (they would hang for minutes); the provider answers with a clear
 * message instead. Other local endpoints stay usable; nothing is moved to the
 * cloud (private stays local — the provider never fails over to cloud).
 *
 * No imports on purpose: the LLM SDK reads this on every call.
 */

export interface ActiveVllmSwitch {
    planId: string
    node: string
    from: string
    to: string
    /** vLLM base URL of the switching node; only this origin is held back. */
    baseUrl?: string
    startedAt: number
    /** Hard end of the hold, even if the runner never clears it (crash safety). */
    until: number
}

let active: ActiveVllmSwitch | null = null

export function setActiveVllmSwitch(value: ActiveVllmSwitch): void { active = { ...value } }

export function clearActiveVllmSwitch(planId?: string): void {
    if (!planId || active?.planId === planId) active = null
}

export function getActiveVllmSwitch(now = Date.now()): ActiveVllmSwitch | null {
    if (active && now > active.until) active = null
    return active ? { ...active } : null
}

function originOf(url: string | undefined): string {
    try { return new URL(String(url || '').replace(/\/+$/, '')).origin.toLowerCase() } catch { return '' }
}

/** true while a switch runs on exactly this endpoint (same origin). */
export function vllmSwitchBlocks(baseUrl: string | undefined, now = Date.now()): boolean {
    const current = getActiveVllmSwitch(now)
    if (!current?.baseUrl) return false
    const origin = originOf(baseUrl)
    return origin !== '' && origin === originOf(current.baseUrl)
}

export function vllmSwitchBusyMessage(now = Date.now()): string {
    const current = getActiveVllmSwitch(now)
    if (!current) return ''
    const minutes = Math.max(1, Math.round((now - current.startedAt) / 60_000))
    return `Modellwechsel am ${current.node} läuft (${current.from} → ${current.to}, seit ${minutes} min, ~15 min ohne lokales LLM). `
        + 'Ich antworte, sobald das Modell wieder bereit ist — private Anfragen gehen in der Zeit nicht in die Cloud.'
}
