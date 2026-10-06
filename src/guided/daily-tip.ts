/**
 * 2.86 Paket M „Geführt“, Punkt 10 — höchstens ein Tipp am Tag.
 *
 * - Tips only for what is already connected (fixed list per type, no model).
 * - At most one per day (time zone of the reports), never during quiet hours.
 * - The same tip comes again at the earliest after 30 days.
 * - „Nein danke“ stops THIS tip for good: recorded in the decision memory
 *   (`decisions.ts`, source „knopf“, ref `tipp:<id>`); without the Main's
 *   decision memory (worker/test) in guided/state.json as fallback.
 * - The button sends a plain sentence as a normal request (like the example
 *   sentences): reading at once, anything that switches asks with a card.
 */
import { loadGuidedState, nowOf, updateGuidedState, type GuidedOptions } from './guided-store.js'
import type { BeispielTyp } from './example-prompts.js'
import { zonedDay, zonedHour } from '../planner/time.js'

export interface Tipp { id: string; typ: BeispielTyp; text: string; knopf: { label: string; satz: string } }

export const TIPPS: readonly Tipp[] = Object.freeze([
    { id: 'ha-abends-aus', typ: 'homeassistant', text: 'Wusstest du? Du kannst sagen „Jeden Abend um 23 Uhr alles aus“ – ich zeige dir den Ablauf und frage einmal.', knopf: { label: 'Ausprobieren', satz: 'Jeden Abend um 23 Uhr alle Lichter aus' } },
    { id: 'hue-gemuetlich', typ: 'hue', text: 'Wusstest du? „Mach es gemütlich im Wohnzimmer“ dimmt deine Lampen – vorher fragst du kurz mit Ja.', knopf: { label: 'Ausprobieren', satz: 'Mach es gemütlich im Wohnzimmer' } },
    { id: 'steckdose-verbrauch', typ: 'steckdose', text: 'Wusstest du? Ich sage dir, wie viel Strom deine Steckdosen heute gebraucht haben.', knopf: { label: 'Zeig mir das', satz: 'Wie viel Strom haben meine Steckdosen heute gebraucht?' } },
    { id: 'drucker-fertig', typ: 'drucker', text: 'Wusstest du? Ich sag dir Bescheid, sobald der Druck fertig ist.', knopf: { label: 'Einrichten', satz: 'Sag mir Bescheid, wenn der Druck fertig ist' } },
    { id: 'kalender-morgens', typ: 'kalender', text: 'Wusstest du? Ich kann dir jeden Morgen sagen, was heute ansteht.', knopf: { label: 'Einrichten', satz: 'Sag mir jeden Morgen um 7 Uhr, was heute ansteht' } },
    { id: 'mail-paket', typ: 'mail', text: 'Wusstest du? Frag einfach „Wann kommt mein Paket?“ – ich suche die Versandmail.', knopf: { label: 'Ausprobieren', satz: 'Wann kommt mein Paket?' } },
    { id: 'dokumente-suchen', typ: 'dokumente', text: 'Wusstest du? Ich finde Rechnungen und Verträge für dich, auch wenn du den Namen nicht mehr weißt.', knopf: { label: 'Ausprobieren', satz: 'Such meine letzte Stromrechnung' } },
    { id: 'fotos-rueckblick', typ: 'fotos', text: 'Wusstest du? Ich kann dir Fotos von genau diesem Tag vor einem Jahr zeigen.', knopf: { label: 'Zeig mir das', satz: 'Zeig mir Fotos von heute vor einem Jahr' } },
    { id: 'ki-zusammenfassen', typ: 'ki', text: 'Wusstest du? Schick mir einen langen Text, und ich fasse ihn in drei Sätzen zusammen.', knopf: { label: 'Was kannst du?', satz: 'Was kannst du alles?' } },
    { id: 'suche-wetter', typ: 'suche', text: 'Wusstest du? Frag mich nach dem Wetter, Öffnungszeiten oder Neuigkeiten – ich schaue für dich nach.', knopf: { label: 'Ausprobieren', satz: 'Wie wird das Wetter morgen?' } },
])

const REPEAT_MS = 30 * 24 * 60 * 60_000

export interface TippKontext extends GuidedOptions {
    /** Types of what is connected (example-prompts `beispielTyp`). */
    typen: readonly BeispielTyp[]
    timeZone?: string
    /** Quiet hours check for `now` (default: core/quiet-hours in the report time zone). */
    ruhezeit?: (now: number) => boolean
    /** Decision memory lookup (default: decisions.ts, active entry with ref `tipp:<id>`). */
    abgelehnt?: (id: string) => boolean
}

const dayOf = (now: number, timeZone: string) => zonedDay(now, timeZone)
const hourOf = (now: number, timeZone: string) => zonedHour(now, timeZone)

async function defaultQuiet(timeZone: string): Promise<(now: number) => boolean> {
    const { isQuietHourOfDay } = await import('../core/quiet-hours.js')
    return now => isQuietHourOfDay(hourOf(now, timeZone))
}

function declinedInState(id: string, opts: GuidedOptions): boolean {
    return Boolean(loadGuidedState(opts).tipp.gezeigt[`nein:${id}`])
}

async function defaultDeclined(opts: GuidedOptions): Promise<(id: string) => boolean> {
    let refs = new Set<string>()
    try {
        const { listDecisions } = await import('../core/decisions.js')
        refs = new Set(listDecisions({ dataDir: opts.dataDir }).filter(item => item.status === 'aktiv' && item.quelle.ref?.startsWith('tipp:')).map(item => String(item.quelle.ref)))
    } catch { /* decision memory not available */ }
    return id => refs.has(`tipp:${id}`) || declinedInState(id, opts)
}

/**
 * Today's tip: picks at most one per day (outside quiet hours) and remembers
 * it; later calls on the same day return the same tip (`neu: false`).
 */
export async function tippHeute(ctx: TippKontext): Promise<{ tipp: Tipp; neu: boolean } | null> {
    const now = nowOf(ctx)
    const timeZone = ctx.timeZone || 'Europe/Vienna'
    const today = dayOf(now, timeZone)
    const declined = ctx.abgelehnt || await defaultDeclined(ctx)
    const state = loadGuidedState(ctx)
    if (state.tipp.tag === today) {
        const tipp = TIPPS.find(item => item.id === state.tipp.id)
        return tipp && !declined(tipp.id) ? { tipp, neu: false } : null
    }
    const quiet = ctx.ruhezeit || await defaultQuiet(timeZone)
    if (quiet(now)) return null
    const typen = new Set(ctx.typen)
    const tipp = TIPPS.find(item => typen.has(item.typ) && !declined(item.id)
        && !(state.tipp.gezeigt[item.id] && now - Date.parse(state.tipp.gezeigt[item.id]) < REPEAT_MS))
    if (!tipp) return null
    updateGuidedState(next => { next.tipp = { ...next.tipp, tag: today, id: tipp.id, gezeigt: { ...next.tipp.gezeigt, [tipp.id]: new Date(now).toISOString() } } }, ctx)
    return { tipp, neu: true }
}

/** „Nein danke“: this tip never again (decision memory, fallback local). */
export async function tippAblehnen(id: string, by: string, opts: GuidedOptions & { isMain?: () => boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const tipp = TIPPS.find(item => item.id === id)
    if (!tipp) return { ok: false, message: 'Unbekannter Tipp.' }
    let stored = false
    try {
        const { recordDecision } = await import('../core/decisions.js')
        stored = Boolean(recordDecision({
            text: `Tipp „${tipp.text.replace(/^Wusstest du\?\s*/, '').slice(0, 80)}“ nicht mehr zeigen`,
            warum: 'Owner hat beim Tipp „Nein danke“ gedrückt',
            quelle: { art: 'knopf', von: String(by).slice(0, 80), kanal: 'tipp', ref: `tipp:${tipp.id}` },
            bindend: true, themen: ['tipp', tipp.id, tipp.typ], polaritaet: 'neg', wirkung: 'neutral',
        }, { dataDir: opts.dataDir, now: opts.now, ...(opts.isMain ? { isMain: opts.isMain } : {}) }))
    } catch { stored = false }
    updateGuidedState(state => {
        state.tipp.gezeigt[`nein:${tipp.id}`] = new Date(nowOf(opts)).toISOString()
        if (state.tipp.id === tipp.id) state.tipp.id = undefined
    }, opts)
    return { ok: true, message: stored ? 'Gut, diesen Tipp zeige ich nicht mehr. Ich habe es mir gemerkt.' : 'Gut, diesen Tipp zeige ich nicht mehr.' }
}

export function markTippGesendet(opts: GuidedOptions = {}): void {
    updateGuidedState(state => {
        for (const key of Object.keys(state.tipp.gezeigt)) if (key.startsWith('gesendet:')) delete state.tipp.gezeigt[key]
        state.tipp.gezeigt[`gesendet:${state.tipp.tag || ''}`] = new Date(nowOf(opts)).toISOString()
    }, opts)
}
export function tippSchonGesendet(opts: GuidedOptions = {}): boolean {
    const state = loadGuidedState(opts)
    return Boolean(state.tipp.tag && state.tipp.gezeigt[`gesendet:${state.tipp.tag}`])
}
