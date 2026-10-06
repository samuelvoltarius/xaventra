/**
 * 2.87 Paket P: Kurzantworten am Telefon und im App-Anruf.
 *
 * Einfache Sprachfragen (Uhrzeit, Datum, „läuft alles?“, Wetter wenn ein
 * Werkzeug dafür eingerichtet ist) brauchen keine große Modellrunde. Schalten
 * geht schon heute deterministisch an /geraete (Vorschau-Karte, Policy
 * unverändert); hier kommt nur die gesprochene Rückfrage dazu.
 *
 * Ein gesprochenes „ja“ gilt NUR als Freigabe, wenn
 *   1. der Anruf als Owner authentifiziert ist (App-Anruf mit Owner-Ticket —
 *      ein Telefonanruf ist es nie: Rufnummern lassen sich fälschen), und
 *   2. die Karte noch offen ist und GENAU die Aktion beschreibt, die gerade
 *      vorgelesen wurde (Art, Titel, Vorschlag, Aktion unverändert).
 * Sonst bleibt die Karte in App und Telegram.
 */
import type { VoiceAnswerStream } from './voice-call.js'

export interface VoiceCardView {
    id: string
    status: string
    art: string
    titel: string
    vorschlag: string
    aktion: { kind: string; ref: string }
    expiresAt: string
}

export interface VoiceQuickDeps {
    now: () => Date
    timeZone?: string
    /** Kurzer gesprochener Status („läuft alles?“). */
    status?: () => Promise<string>
    /** Wetter aus einem vorhandenen Werkzeug; null = keins eingerichtet. */
    weather?: () => Promise<string | null>
    /** Offene Karten (nur lesen). */
    openCards: () => VoiceCardView[]
    /** Owner-Antwort über denselben Weg wie die App (answerCardFromDesktop). */
    answerCard: (cardId: string, answer: 'ja' | 'nein') => Promise<{ ok: boolean; message: string }>
}

const norm = (text: string) => String(text || '').toLocaleLowerCase('de-DE').normalize('NFKC').replace(/[?!.,:;„“"']+/g, ' ').replace(/\s+/g, ' ').trim()

const TIME = /^(?:(?:sag mir )?(?:bitte )?(?:wie spät ist es|wie spät|wieviel uhr (?:ist es|haben wir)|wie viel uhr (?:ist es|haben wir)|wie viel uhr|wieviel uhr|uhrzeit|wie ist die uhrzeit|was ist die uhrzeit)(?: (?:jetzt|gerade|bitte))?)$/
const DATE = /^(?:(?:welcher|was für ein) (?:tag|wochentag) ist (?:heute|es)|welches datum (?:ist )?(?:heute|haben wir)|der wievielte ist heute|den wievielten haben wir(?: heute)?|welches datum|was ist heute für ein tag)$/
const STATUS = /^(?:läuft alles|laeuft alles|läuft alles gut|ist alles (?:in ordnung|ok|okay|gut)|alles (?:in ordnung|ok|okay|gut)|geht alles|funktioniert alles|wie läuft(?:'s| es)?)(?: bei dir)?$/
const WEATHER = /^(?:wie (?:ist|wird) (?:das|heute das|morgen das)? ?wetter(?: heute| morgen| draußen| draussen)?|wetter(?: heute)?|wie ist es draußen|wie ist es draussen)$/
const YES = /^(?:ja|ja bitte|jawohl|jo|ja mach|ja mach das|ja mach es|mach das|mach es|mach|passt|okay|ok|genau|gerne|ja gerne)$/
const NO = /^(?:nein|nein danke|lieber nicht|nicht|lass es|lass das|abbrechen|nein lass es)$/

function timeText(now: Date, timeZone?: string): string {
    const time = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(now)
    return `Es ist ${time} Uhr.`
}

function dateText(now: Date, timeZone?: string): string {
    const parts = new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...(timeZone ? { timeZone } : {}) }).formatToParts(now)
    const get = (type: string) => parts.find(part => part.type === type)?.value || ''
    return `Heute ist ${get('weekday')}, der ${get('day')}. ${get('month')} ${get('year')}.`
}

/** Kurzantwort oder null (= normale Pipeline). */
export async function quickVoiceAnswer(text: string, deps: VoiceQuickDeps): Promise<string | null> {
    const value = norm(text)
    if (!value) return null
    if (TIME.test(value)) return timeText(deps.now(), deps.timeZone)
    if (DATE.test(value)) return dateText(deps.now(), deps.timeZone)
    if (STATUS.test(value) && deps.status) return await deps.status()
    if (WEATHER.test(value) && deps.weather) return await deps.weather()
    return null
}

function fingerprint(card: VoiceCardView): string {
    return JSON.stringify([card.art, card.titel, card.vorschlag, card.aktion?.kind, card.aktion?.ref])
}

export type VoicePipeline = (text: string, signal: AbortSignal, stream?: VoiceAnswerStream) => Promise<string>

export interface VoiceAnswererOptions {
    pipeline: VoicePipeline
    quick: VoiceQuickDeps
    /** true nur für den App-Anruf mit Owner-Ticket; Telefon = false. */
    ownerAuthenticated: boolean
}

const CARD_HINT = /\s*Bitte auf der Karte Ja oder Nein\.\s*$/

/** Eine Antwortfunktion für VoiceCallSession: Kurzantwort → Bestätigung → Pipeline. */
export function createVoiceAnswerer(options: VoiceAnswererOptions): VoicePipeline {
    let pending: { id: string; fingerprint: string } | null = null
    return async (text, signal, stream) => {
        const value = norm(text)
        const confirm = YES.test(value) ? 'ja' as const : NO.test(value) ? 'nein' as const : null
        if (pending && confirm) {
            const asked = pending
            pending = null
            if (!options.ownerAuthenticated) return 'Ein gesprochenes Ja gilt am Telefon nicht als Freigabe. Bitte bestätige die Karte in der App oder in Telegram.'
            const card = options.quick.openCards().find(item => item.id === asked.id)
            if (!card || card.status !== 'offen') return 'Diese Karte ist schon beantwortet oder abgelaufen. Ich habe nichts geschaltet.'
            if (Date.parse(card.expiresAt) <= options.quick.now().getTime()) return 'Diese Karte ist abgelaufen. Ich habe nichts geschaltet.'
            if (fingerprint(card) !== asked.fingerprint) return 'Die Karte hat sich geändert. Bitte sieh sie dir in der App an und bestätige dort.'
            const result = await options.quick.answerCard(card.id, confirm)
            return result.message
        }
        if (!confirm) pending = null
        const quick = await quickVoiceAnswer(text, options.quick)
        if (quick) return quick

        const before = new Set(options.quick.openCards().filter(card => card.status === 'offen').map(card => card.id))
        const reply = await options.pipeline(text, signal, stream)
        if (signal.aborted) return reply
        const fresh = options.quick.openCards().filter(card => card.status === 'offen' && !before.has(card.id))
        if (fresh.length !== 1 || !CARD_HINT.test(reply)) return reply
        const head = reply.replace(CARD_HINT, '').trim()
        // Auch ohne Owner-Nachweis merken: ein „ja“ danach geht so nie als Zustimmung an die Pipeline.
        pending = { id: fresh[0].id, fingerprint: fingerprint(fresh[0]) }
        if (!options.ownerAuthenticated) return `${head} Die Karte zum Bestätigen liegt in der App und in Telegram.`
        return `${head} Soll ich das machen? Sag ja.`
    }
}
