/**
 * 2.86 Paket M „Geführt“, Punkt 10 — höchstens ein Tipp am Tag.
 *
 * - Tips only for what is already connected (fixed list per type, no model).
 * - 2.89.4: never a promise about the future („ich sag dir Bescheid, sobald …“),
 *   only what the owner can already ask. Capability-inventory is checked before
 *   a tip is picked — a tip for a printer never goes out without a printer.
 * - At most one per day (time zone of the reports), never during quiet hours.
 * - The same tip comes again at the earliest after 30 days.
 * - „Nein danke“ stops THIS tip for good; „Tipps aus“ stops all of them
 *   (decision memory `tipp:<id>` / `tipp:alle`, fallback guided/state.json).
 * - The button sends a plain sentence as a normal request (like the example
 *   sentences): reading at once, anything that switches asks with a card.
 */
import { loadGuidedState, nowOf, updateGuidedState, type GuidedOptions } from './guided-store.js'
import type { BeispielTyp } from './example-prompts.js'
import { zonedDay, zonedHour } from '../planner/time.js'
import type { CapabilityInventory } from '../learning/capability-inventory.js'

export interface Tipp { id: string; typ: BeispielTyp; text: string; knopf: { label: string; satz: string } }

/** 2.89.4: no promises — only what the owner can ask right now. */
export const TIPPS: readonly Tipp[] = Object.freeze([
    { id: 'ha-abends-aus', typ: 'homeassistant', text: 'Wusstest du? Du kannst sagen „Jeden Abend um 23 Uhr alles aus“ – ich zeige dir den Ablauf und frage einmal.', knopf: { label: 'Ausprobieren', satz: 'Jeden Abend um 23 Uhr alle Lichter aus' } },
    { id: 'hue-gemuetlich', typ: 'hue', text: 'Wusstest du? „Mach es gemütlich im Wohnzimmer“ dimmt deine Lampen – vorher fragst du kurz mit Ja.', knopf: { label: 'Ausprobieren', satz: 'Mach es gemütlich im Wohnzimmer' } },
    { id: 'steckdose-verbrauch', typ: 'steckdose', text: 'Wusstest du? Du kannst fragen, wie viel Strom deine Steckdosen heute gebraucht haben.', knopf: { label: 'Zeig mir das', satz: 'Wie viel Strom haben meine Steckdosen heute gebraucht?' } },
    { id: 'drucker-fertig', typ: 'drucker', text: 'Wusstest du? Du kannst fragen, wie weit der Druck ist und ob der Drucker gerade frei ist.', knopf: { label: 'Zeig mir das', satz: 'Wie weit ist der Druck?' } },
    { id: 'kalender-morgens', typ: 'kalender', text: 'Wusstest du? Du kannst sagen „Sag mir jeden Morgen um 7 Uhr, was heute ansteht“ – ich stelle dir den Ablauf einmal zur Freigabe.', knopf: { label: 'Einrichten', satz: 'Sag mir jeden Morgen um 7 Uhr, was heute ansteht' } },
    { id: 'mail-paket', typ: 'mail', text: 'Wusstest du? Frag einfach „Wann kommt mein Paket?“ – ich suche die Versandmail.', knopf: { label: 'Ausprobieren', satz: 'Wann kommt mein Paket?' } },
    { id: 'dokumente-suchen', typ: 'dokumente', text: 'Wusstest du? Ich finde Rechnungen und Verträge für dich, auch wenn du den Namen nicht mehr weißt.', knopf: { label: 'Ausprobieren', satz: 'Such meine letzte Stromrechnung' } },
    { id: 'fotos-rueckblick', typ: 'fotos', text: 'Wusstest du? Du kannst Fotos von genau diesem Tag vor einem Jahr ansehen lassen.', knopf: { label: 'Zeig mir das', satz: 'Zeig mir Fotos von heute vor einem Jahr' } },
    { id: 'ki-zusammenfassen', typ: 'ki', text: 'Wusstest du? Schick mir einen langen Text, und ich fasse ihn in drei Sätzen zusammen.', knopf: { label: 'Was kannst du?', satz: 'Was kannst du alles?' } },
    { id: 'suche-wetter', typ: 'suche', text: 'Wusstest du? Frag mich nach dem Wetter, Öffnungszeiten oder Neuigkeiten – ich schaue für dich nach.', knopf: { label: 'Ausprobieren', satz: 'Wie wird das Wetter morgen?' } },
])

/** 2.89.4: no tip may promise future monitoring. */
export const TIPP_VERSPRECHEN = /ich sag\w* dir bescheid|sobald (?:der |das |die )?|ich benachrichtig|ich melde mich, sobald|werde dich (?:an)?rufen/i

/** Printer protocols — a title containing „Drucker“ alone is not a printer. */
const DRUCKER_BELEG = /moonraker|octoprint|prusalink|bambu|klipper|printers?\/|\/printer|drucker:|printer:/
const TOOL_BELEG: Partial<Record<BeispielTyp, RegExp>> = {
    suche: /search|suche|web_search|brave|google_search|browser_search|searx/i,
    ki: /llm|complete|chat/i,
}

/**
 * 2.89.4: is this tip backed by what is really available right now?
 * `typen` (connected entries) is the first gate; `inventory` (capability-inventory)
 * is the second. A missing inventory never invents a capability.
 */
export function tippKann(typ: BeispielTyp, ctx: {
    typen: readonly BeispielTyp[]
    inventory?: CapabilityInventory | null
    /** Connected entry texts (id/title/connectorId) for device evidence. */
    eintraege?: ReadonlyArray<{ id?: string; connectorId?: string; title?: string }>
}): boolean {
    if (!ctx.typen.includes(typ)) return false
    if (typ === 'drucker') {
        // A printer tip needs a real printer connection, not a title match alone.
        const beleg = (ctx.eintraege || []).some(entry => DRUCKER_BELEG.test(`${entry.id || ''} ${entry.connectorId || ''}`.toLowerCase()))
        if (!beleg && ctx.eintraege?.length) return false
    }
    const inv = ctx.inventory
    if (!inv) return true
    if (typ === 'ki') {
        const llm = inv.runtime && inv.runtime.kind !== 'none' && (inv.runtime.reachable !== false)
        const tool = inv.tools.some(name => (TOOL_BELEG.ki as RegExp).test(name))
        return Boolean(llm || tool)
    }
    if (typ === 'suche') {
        return inv.tools.some(name => (TOOL_BELEG.suche as RegExp).test(name))
    }
    return true
}

const REPEAT_MS = 30 * 24 * 60 * 60_000

export interface TippKontext extends GuidedOptions {
    /** Types of what is connected (example-prompts `beispielTyp`). */
    typen: readonly BeispielTyp[]
    /** 2.89.4: connected entry texts for the printer/protocol evidence. */
    eintraege?: ReadonlyArray<{ id?: string; connectorId?: string; title?: string }>
    /** 2.89.4: capability-inventory; default: read live (light). Missing = no extra claim. */
    inventory?: CapabilityInventory | null
    timeZone?: string
    /** Quiet hours check for `now` (default: core/quiet-hours in the report time zone). */
    ruhezeit?: (now: number) => boolean
    /** Decision memory lookup (default: decisions.ts, active entry with ref `tipp:<id>` or `tipp:alle`). */
    abgelehnt?: (id: string) => boolean
    /** 2.89.4: global off switch override („Tipps aus“). */
    aus?: boolean
}

const dayOf = (now: number, timeZone: string) => zonedDay(now, timeZone)
const hourOf = (now: number, timeZone: string) => zonedHour(now, timeZone)

async function defaultQuiet(timeZone: string): Promise<(now: number) => boolean> {
    const { isQuietHourOfDay } = await import('../core/quiet-hours.js')
    return now => isQuietHourOfDay(hourOf(now, timeZone))
}

function declinedInState(id: string, opts: GuidedOptions): boolean {
    const state = loadGuidedState(opts)
    return Boolean(state.tipp.gezeigt[`nein:${id}`]) || (id !== 'alle' && state.tipp.gezeigt['nein:alle'])
}

/** 2.89.4: global off switch („Tipps aus“) in guided state. */
export function tippsAus(opts: GuidedOptions = {}): boolean {
    return Boolean(loadGuidedState(opts).tipp.gezeigt['nein:alle'])
}

async function defaultDeclined(opts: GuidedOptions): Promise<(id: string) => boolean> {
    let refs = new Set<string>()
    try {
        const { listDecisions } = await import('../core/decisions.js')
        refs = new Set(listDecisions({ dataDir: opts.dataDir }).filter(item => item.status === 'aktiv' && item.quelle.ref?.startsWith('tipp:')).map(item => String(item.quelle.ref)))
    } catch { /* decision memory not available */ }
    return id => refs.has(`tipp:${id}`) || refs.has('tipp:alle') || declinedInState(id, opts)
}

async function defaultInventory(ctx: TippKontext): Promise<CapabilityInventory | null> {
    if (ctx.inventory !== undefined) return ctx.inventory
    try {
        const { capabilityInventory } = await import('../learning/capability-inventory.js')
        return await capabilityInventory({ light: true, ...(ctx.dataDir ? { dataDir: ctx.dataDir } : {}) })
    } catch { return null }
}

/**
 * Today's tip: picks at most one per day (outside quiet hours) and remembers
 * it; later calls on the same day return the same tip (`neu: false`).
 * 2.89.4: only a capability that is really available, never a promise, never
 * while tips are switched off.
 */
export async function tippHeute(ctx: TippKontext): Promise<{ tipp: Tipp; neu: boolean } | null> {
    const now = nowOf(ctx)
    const timeZone = ctx.timeZone || 'Europe/Vienna'
    const today = dayOf(now, timeZone)
    const declined = ctx.abgelehnt || await defaultDeclined(ctx)
    const state = loadGuidedState(ctx)
    if (ctx.aus || tippsAus(ctx) || declined('alle')) return null
    if (state.tipp.tag === today) {
        const tipp = TIPPS.find(item => item.id === state.tipp.id)
        return tipp && !declined(tipp.id) ? { tipp, neu: false } : null
    }
    const quiet = ctx.ruhezeit || await defaultQuiet(timeZone)
    if (quiet(now)) return null
    const inventory = await defaultInventory(ctx)
    const tipp = TIPPS.find(item => !declined(item.id)
        && !TIPP_VERSPRECHEN.test(item.text)
        && tippKann(item.typ, { typen: ctx.typen, inventory, ...(ctx.eintraege ? { eintraege: ctx.eintraege } : {}) })
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

/** „Tipps aus“: no more tips at all (global off switch, decision ref `tipp:alle`). */
export async function tippAlleAblehnen(by: string, opts: GuidedOptions & { isMain?: () => boolean } = {}): Promise<{ ok: boolean; message: string }> {
    let stored = false
    try {
        const { recordDecision } = await import('../core/decisions.js')
        stored = Boolean(recordDecision({
            text: 'Tägliche Tipps nicht mehr zeigen',
            warum: 'Owner hat „Tipps aus“ gewählt',
            quelle: { art: 'knopf', von: String(by).slice(0, 80), kanal: 'tipp', ref: 'tipp:alle' },
            bindend: true, themen: ['tipp'], polaritaet: 'neg', wirkung: 'neutral',
        }, { dataDir: opts.dataDir, now: opts.now, ...(opts.isMain ? { isMain: opts.isMain } : {}) }))
    } catch { stored = false }
    updateGuidedState(state => {
        state.tipp.gezeigt['nein:alle'] = new Date(nowOf(opts)).toISOString()
        state.tipp.id = undefined
    }, opts)
    return { ok: true, message: stored ? 'Gut, ich zeige keine Tipps mehr. Ich habe es mir gemerkt.' : 'Gut, ich zeige keine Tipps mehr.' }
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
