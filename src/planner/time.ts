/**
 * Wall-clock helpers for the planner. Times like "07:30" and quiet hours are
 * Alfred's local time (default Europe/Vienna), independent of the process
 * time zone (servers and containers usually run in UTC).
 */

export const DEFAULT_TIME_ZONE = 'Europe/Vienna'
export const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

interface ZonedParts { y: number; m: number; d: number; h: number; mi: number; s: number }

export function isValidTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone })
        return true
    } catch {
        return false
    }
}

export function zonedParts(t: number, timeZone = DEFAULT_TIME_ZONE): ZonedParts {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(t))
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

function zoneOffsetMs(t: number, timeZone: string): number {
    const p = zonedParts(t, timeZone)
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000
}

/** Timestamp of wall-clock h:mi in `timeZone`, dayOffset days after the local date of `now`. */
export function zonedWallTime(now: number, dayOffset: number, h: number, mi: number, timeZone = DEFAULT_TIME_ZONE): number {
    const today = zonedParts(now, timeZone)
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + dayOffset))
    const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi)
    const first = guess - zoneOffsetMs(guess, timeZone)
    return guess - zoneOffsetMs(first, timeZone)
}

/** Smallest daily slot "HH:MM" (local) strictly after `after`. */
export function nextDailySlot(after: number, hhmm: string, timeZone = DEFAULT_TIME_ZONE): number {
    const match = HHMM_PATTERN.exec(hhmm)
    if (!match) throw new Error(`Ungültige Uhrzeit: ${hhmm}`)
    const h = Number(match[1])
    const mi = Number(match[2])
    for (let offset = 0; offset <= 2; offset++) {
        const slot = zonedWallTime(after, offset, h, mi, timeZone)
        if (slot > after) return slot
    }
    return zonedWallTime(after, 3, h, mi, timeZone)
}

export function zonedHour(t: number, timeZone = DEFAULT_TIME_ZONE): number {
    return zonedParts(t, timeZone).h
}

/** Local calendar day "YYYY-MM-DD". */
export function zonedDay(t: number, timeZone = DEFAULT_TIME_ZONE): string {
    const p = zonedParts(t, timeZone)
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** "01.10. 07:30" in local time. */
export function formatZoned(t: number, timeZone = DEFAULT_TIME_ZONE): string {
    const p = zonedParts(t, timeZone)
    const two = (n: number) => String(n).padStart(2, '0')
    return `${two(p.d)}.${two(p.m)}. ${two(p.h)}:${two(p.mi)}`
}
