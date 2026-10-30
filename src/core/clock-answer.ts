/**
 * 2.89.8 (U7): plain time and date questions never wait for the model.
 *
 * Live: "wie spät ist es?" took 90 s and ended in "Das hat zu lange gedauert" because the chat model was busy.
 * The clock is a fact of this machine, not a model opinion - answered from the system clock in the owner's
 * time zone (owner profile > autonomy.briefing.timeZone > Europe/Vienna). Only the WHOLE message counts:
 * a compound request ("wie spät ist es und wie ist das Wetter") still goes to the model.
 */
import { relayQuestionText } from './relay-text.js'

export const DEFAULT_OWNER_TIME_ZONE = 'Europe/Vienna'

export type ClockQuestion = 'zeit' | 'datum'

const FILLER = String.raw`(?: (?:jetzt|gerade|eigentlich|aktuell|genau|bitte|mal|bei dir|noch|denn|so))*`
const TIME_QUESTION = new RegExp(String.raw`^(?:(?:sag|sage) mir |kannst du mir sagen |weißt du |weisst du |bitte )*(?:wie spät|wie spaet|wie viel uhr|wieviel uhr|wie späte|welche uhrzeit|wie spät haben wir|wie viel uhr haben wir|wieviel uhr haben wir|welche zeit)(?: ist es| haben wir)?${FILLER}$`)
const TIME_SHORT = /^(?:uhrzeit|die uhrzeit|zeit|die zeit)(?: jetzt| bitte| gerade)?$/
const DATE_QUESTION = new RegExp(String.raw`^(?:(?:sag|sage) mir |kannst du mir sagen |weißt du |weisst du |bitte )*(?:welcher tag ist (?:heute|es)|welches datum haben wir|welches datum ist (?:heute|es)|welchen tag haben wir|den wievielten haben wir|der wievielte ist (?:heute|es)|welcher wochentag ist (?:heute|es)|was für ein tag ist (?:heute|es)|was fuer ein tag ist (?:heute|es)|welcher monat ist es|wie ist das datum|wie lautet das datum|datum|das datum|datum heute|heutiges datum|das heutige datum)(?: heute)?${FILLER}$`)

function normalize(input: string): string {
    return String(input || '').toLocaleLowerCase('de-DE').normalize('NFKC')
        .replace(/[?!.,:;]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The whole message is one clock question, nothing else. */
export function detectClockQuestion(input: string): ClockQuestion | null {
    const text = normalize(relayQuestionText(input))
    if (!text || text.length > 80) return null
    if (TIME_QUESTION.test(text) || TIME_SHORT.test(text)) return 'zeit'
    if (DATE_QUESTION.test(text)) return 'datum'
    return null
}

export function isValidTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim()) return false
    try { new Intl.DateTimeFormat('de-AT', { timeZone: value }); return true } catch { return false }
}

export function resolveOwnerTimeZone(config: any, profileTimeZone?: string): string {
    for (const candidate of [profileTimeZone, config?.autonomy?.briefing?.timeZone, config?.timezone, config?.timeZone]) {
        if (isValidTimeZone(candidate)) return candidate
    }
    return DEFAULT_OWNER_TIME_ZONE
}

export function answerClockQuestion(kind: ClockQuestion, timeZone: string, now: Date = new Date()): string {
    const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_OWNER_TIME_ZONE
    const time = new Intl.DateTimeFormat('de-AT', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
    const date = new Intl.DateTimeFormat('de-AT', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)
    return kind === 'zeit'
        ? `Es ist ${time} Uhr (${zone}), ${date}.`
        : `Heute ist ${date} (${zone}), ${time} Uhr.`
}
