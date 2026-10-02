/**
 * Eine Ruhezeit-Definition (2.82.0 Aufräumen).
 *
 * Vorher galten vier Ruhezeiten nebeneinander: `autonomy.quietHours` 23–7
 * (Autonomie-Schleife), `autonomy.thoughts.quietHours` 22–7 (Planer-Gedanken),
 * ProactiveMessenger 22–7 (fest) und Wahrnehmen `sensing.notify` 22–7. Jetzt
 * liest jeder diese eine Stelle:
 *
 *   autonomy.quietHours { enabled: true, start: 22, end: 7 }
 *
 * `autonomy.thoughts.quietHours` wird nur noch gelesen, wenn der neue Schlüssel
 * fehlt (Rückwärtskompatibilität). `enabled: false` = keine Ruhezeit (-1/-1).
 * /autonomy quiet ändert sie zur Laufzeit für alle (Listener).
 */

export interface QuietHours {
    /** Start hour 0-23; -1 = no quiet hours. */
    start: number
    /** End hour 0-23; -1 = no quiet hours. */
    end: number
}

export const DEFAULT_QUIET_HOURS: Readonly<QuietHours> = Object.freeze({ start: 22, end: 7 })
export const NO_QUIET_HOURS: Readonly<QuietHours> = Object.freeze({ start: -1, end: -1 })

const hour = (value: unknown): number | null => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23 ? value as number : null

/** `autonomy.quietHours` first, then the legacy `autonomy.thoughts.quietHours`, else 22–7. */
export function parseQuietHours(autonomy: any): QuietHours {
    const primary = autonomy?.quietHours
    if (primary && typeof primary === 'object') {
        if (primary.enabled === false) return { ...NO_QUIET_HOURS }
        return { start: hour(primary.start) ?? DEFAULT_QUIET_HOURS.start, end: hour(primary.end) ?? DEFAULT_QUIET_HOURS.end }
    }
    const legacy = autonomy?.thoughts?.quietHours
    if (legacy && typeof legacy === 'object') {
        if (legacy.enabled === false) return { ...NO_QUIET_HOURS }
        return { start: hour(legacy.start) ?? DEFAULT_QUIET_HOURS.start, end: hour(legacy.end) ?? DEFAULT_QUIET_HOURS.end }
    }
    return { ...DEFAULT_QUIET_HOURS }
}

let current: QuietHours = { ...DEFAULT_QUIET_HOURS }
const listeners = new Set<(value: QuietHours) => void>()

export function getQuietHours(): QuietHours {
    return { ...current }
}

/** Sets the one definition and tells every subscriber (planner, loop). */
export function setQuietHours(value: Partial<QuietHours>): QuietHours {
    const start = Number.isInteger(value.start) && value.start! >= -1 && value.start! <= 23 ? value.start! : current.start
    const end = Number.isInteger(value.end) && value.end! >= -1 && value.end! <= 23 ? value.end! : current.end
    current = start < 0 || end < 0 ? { ...NO_QUIET_HOURS } : { start, end }
    for (const listener of listeners) { try { listener({ ...current }) } catch { /* a listener never breaks the others */ } }
    return { ...current }
}

/** Called once by the daemon with `config.autonomy`. */
export function configureQuietHours(autonomy: any): QuietHours {
    return setQuietHours(parseQuietHours(autonomy))
}

export function onQuietHoursChange(listener: (value: QuietHours) => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

/** True when `hourOfDay` lies in the quiet window (wraps midnight; -1 or start=end = never). */
export function isQuietHourOfDay(hourOfDay: number, value: QuietHours = current): boolean {
    const { start, end } = value
    if (start < 0 || end < 0 || start === end) return false
    return start > end ? hourOfDay >= start || hourOfDay < end : hourOfDay >= start && hourOfDay < end
}
