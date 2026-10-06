/**
 * 2.86 Paket M „Geführt“ — Laufzeit: Knopf-Aktionen (Telegram `gf:` und App)
 * und der geführte Durchlauf im Karten-Takt des Mains.
 *
 * Every action either sends a fixed sentence as a normal request, opens an
 * EXISTING question, shows a read-only view or stores the owner's „Nein
 * danke“. Nothing here switches, installs or connects without the owner's Ja
 * on the usual card.
 */
import { collectChecklist, skipChecklistItem, startChecklistItem, type Checklist, type ChecklistDeps } from './setup-checklist.js'
import { ichKommNichtWeiter, type HilfeAntwort, type HilfeDeps } from './stuck-helper.js'
import { angebotsKopf, beispielTyp, connectedEntries, markBeispieleGesendet, noteConnected, type VerbundenerEintrag } from './example-prompts.js'
import { markTippGesendet, tippAblehnen, tippHeute, tippSchonGesendet, type Tipp } from './daily-tip.js'
import { beispielView, checklistView, hilfeView, tippView, updatePinnedStatus, type GuidedAktion, type GuidedTelegram, type Keyboard, type PinnedFacts } from './telegram-guided.js'
import { loadGuidedState, nowOf, type GuidedOptions } from './guided-store.js'

export interface GuidedDeps extends GuidedOptions {
    checklist?: ChecklistDeps
    hilfe?: HilfeDeps
    /** Connected entries (default: Verbindungen list). */
    verbunden?: () => Promise<VerbundenerEintrag[]>
    /** Open urgent things for the traffic light (default: urgent open thoughts). */
    kritisch?: () => Promise<number> | number
    /** The visible/next question and how many wait (default: question-queue). */
    fragen?: () => Promise<{ frage: { id: string; titel: string } | null; wartend: number }>
    timeZone?: string
    /** Quiet hours right now (default: core/quiet-hours). */
    ruhezeit?: (now: number) => boolean
    /** Redeliver an open card now (default: approval-cards `requestCardRedelivery`). */
    redeliver?: (cardId: string) => boolean
    isMain?: () => boolean
}

export interface GuidedResult {
    ok: boolean
    /** Short answer for the button press (toast). */
    hinweis?: string
    /** A message to show (Telegram: new message, or edit when `ersetzen`). */
    ansicht?: { text: string; keyboard: Keyboard; ersetzen?: boolean }
    /** A sentence to run as a normal owner request. */
    anfrage?: string
    /** The card loop should run now (a question was opened). */
    weiter?: boolean
}

export const APP_SATZ: Record<string, string> = {
    verbindungen: 'Das geht am einfachsten in der App unter „Verbindungen“ – dort ist es ein Knopf.',
    start: 'Das geht am einfachsten in der App unter „Mehr“ → „Erster Start“ – dort ist es ein Knopf.',
    system: 'Das siehst du in der App unter „System“.',
}

const withDir = <T extends GuidedOptions>(deps: GuidedDeps, inner?: T): T => ({ dataDir: deps.dataDir, now: deps.now, ...(inner || {}) }) as T

export async function runGuidedAction(aktion: GuidedAktion, ctx: { chatId: string; by: string }, deps: GuidedDeps = {}): Promise<GuidedResult> {
    switch (aktion.art) {
    case 'satz': {
        const text = String(aktion.text || '').trim().slice(0, 200)
        return text ? { ok: true, hinweis: 'Gesendet.', anfrage: text } : { ok: false, hinweis: 'Leerer Satz.' }
    }
    case 'einrichten': {
        invalidateGuidedCache()
        const result = await startChecklistItem(aktion.key, withDir(deps, deps.checklist))
        return { ok: result.ok, hinweis: result.message, weiter: result.ok }
    }
    case 'ueberspringen': {
        invalidateGuidedCache()
        const result = skipChecklistItem(aktion.key, deps)
        const list = await collectChecklist(withDir(deps, deps.checklist))
        return { ok: result.ok, hinweis: result.message, ansicht: { ...checklistView(ctx.chatId, list, deps), ersetzen: true } }
    }
    case 'einrichtung': {
        const list = await collectChecklist(withDir(deps, deps.checklist))
        return { ok: true, ansicht: checklistView(ctx.chatId, list, deps) }
    }
    case 'hilfe': {
        const antwort = await ichKommNichtWeiter(withDir(deps, deps.hilfe))
        return { ok: true, ansicht: hilfeView(ctx.chatId, antwort, deps) }
    }
    case 'tipp-nein': {
        const result = await tippAblehnen(aktion.id, ctx.by, { dataDir: deps.dataDir, now: deps.now, ...(deps.isMain ? { isMain: deps.isMain } : {}) })
        return { ok: result.ok, hinweis: result.ok ? 'Gemerkt.' : result.message, ansicht: result.ok ? { text: `👍 ${result.message}`, keyboard: [], ersetzen: true } : undefined }
    }
    case 'frage-zeigen': {
        let ok: boolean
        if (deps.redeliver) ok = deps.redeliver(aktion.cardId)
        else {
            const { requestCardRedelivery } = await import('../core/approval-cards.js')
            ok = Boolean(requestCardRedelivery(aktion.cardId, { dataDir: deps.dataDir, now: deps.now }))
        }
        return { ok, hinweis: ok ? 'Die Frage kommt gleich noch einmal.' : 'Diese Frage ist schon erledigt.', weiter: ok }
    }
    case 'app':
        return { ok: true, ansicht: { text: `📱 ${APP_SATZ[aktion.bereich] || APP_SATZ.verbindungen}`, keyboard: [] } }
    default:
        return { ok: false, hinweis: 'Unbekannter Knopf.' }
    }
}

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------

async function defaultKritisch(): Promise<number> {
    try {
        const { getThoughtStore, isOpenThought } = await import('../planner/index.js')
        return getThoughtStore().list({ limit: 500 }).filter(item => isOpenThought(item) && item.importance === 'dringend').length
    } catch { return 0 }
}

async function defaultFragen(deps: GuidedOptions): Promise<{ frage: { id: string; titel: string } | null; wartend: number }> {
    try {
        const { listApprovalCards } = await import('../core/approval-cards.js')
        const { orderedOpenQuestions, waitingQuestionCount } = await import('../core/question-queue.js')
        const { isBundleVisible } = await import('../core/card-bundle.js')
        const opts = { dataDir: deps.dataDir, now: deps.now }
        const first = orderedOpenQuestions(listApprovalCards({ ...opts, status: 'offen' }), nowOf(deps))[0]
        return { frage: first ? { id: first.id, titel: first.kurz || first.titel } : null, wartend: waitingQuestionCount({ ...opts, bundleVisible: key => isBundleVisible(key, opts) }) }
    } catch { return { frage: null, wartend: 0 } }
}

export async function collectPinnedFacts(deps: GuidedDeps = {}): Promise<PinnedFacts> {
    let einrichtung: Checklist | null = null
    try { einrichtung = await cached('einrichtung', deps, Boolean(deps.checklist), () => collectChecklist(withDir(deps, deps.checklist))) } catch { einrichtung = null }
    const fragen = deps.fragen ? await deps.fragen() : await defaultFragen(deps)
    const kritisch = deps.kritisch ? await deps.kritisch() : await defaultKritisch()
    return { kritisch, einrichtung, frage: fragen.frage, wartend: fragen.wartend }
}

async function quietNow(deps: GuidedDeps): Promise<boolean> {
    const now = nowOf(deps)
    if (deps.ruhezeit) return deps.ruhezeit(now)
    const { isQuietHourOfDay } = await import('../core/quiet-hours.js')
    const { zonedHour } = await import('../planner/time.js')
    return isQuietHourOfDay(zonedHour(now, deps.timeZone || 'Europe/Vienna'))
}

/** Today's tip for the app (picks one if due; never in quiet hours). */
export async function currentTip(deps: GuidedDeps = {}, entries?: VerbundenerEintrag[]): Promise<Tipp | null> {
    const list = entries || await (deps.verbunden ? deps.verbunden() : connectedEntries(deps))
    const picked = await tippHeute({ dataDir: deps.dataDir, now: deps.now, typen: list.map(beispielTyp), timeZone: deps.timeZone, ...(deps.ruhezeit ? { ruhezeit: deps.ruhezeit } : {}) })
    return picked?.tipp || null
}

// The connection overview reads devices, accounts and model docks; the minute loop
// does not need it fresher than every few minutes (questions stay live).
const HEAVY_MS = 5 * 60_000
const heavy = new Map<string, { at: number; value: unknown }>()
async function cached<T>(key: string, deps: GuidedDeps, injected: boolean, load: () => Promise<T>): Promise<T> {
    if (injected) return load()
    const now = Date.now()
    const hit = heavy.get(key)
    if (hit && now - hit.at < HEAVY_MS) return hit.value as T
    const value = await load()
    heavy.set(key, { at: now, value })
    return value
}
/** After an owner action (connect, skip) the next pass reads fresh. */
export function invalidateGuidedCache(): void { heavy.clear() }

/**
 * One guided pass on the Main (card loop): example sentences for new
 * connections, at most one tip per day (not in quiet hours), pinned status.
 */
export async function runGuidedTelegramTick(tg: GuidedTelegram, deps: GuidedDeps = {}): Promise<{ beispiele: number; tipp: boolean; angeheftet: number }> {
    const out = { beispiele: 0, tipp: false, angeheftet: 0 }
    if (!(await tg.canSend())) return out
    const chats = tg.ownerChatIds().filter(id => /^\d{1,20}$/.test(id)).slice(0, 3)
    if (!chats.length) return out
    let entries: VerbundenerEintrag[] = []
    try { entries = await cached('verbunden', deps, Boolean(deps.verbunden), () => deps.verbunden ? deps.verbunden() : connectedEntries(deps)) } catch { entries = [] }

    // Punkt 3: three example sentences after each new connection (once) — and, since 2.86,
    // after a device success message (connect-progress → beispieleNachErfolg). The one place that sends them.
    noteConnected(entries, deps)
    const offers = loadGuidedState(deps).beispieleOffen.filter(item => !item.gesendet && nowOf(deps) - Date.parse(item.at) < 24 * 60 * 60_000)
    for (const offer of offers.slice(0, 3)) {
        for (const chatId of chats) {
            const view = beispielView(chatId, angebotsKopf(offer), offer.saetze, deps)
            await tg.send(chatId, view.text, view.keyboard)
        }
        out.beispiele++
    }
    if (offers.length) markBeispieleGesendet(offers.map(item => item.key), deps)

    // Punkt 10: at most one tip per day, never in quiet hours.
    try {
        if (!(await quietNow(deps))) {
            const tipp = await currentTip(deps, entries)
            if (tipp && !tippSchonGesendet(deps)) {
                for (const chatId of chats) {
                    const view = tippView(chatId, tipp, deps)
                    await tg.send(chatId, view.text, view.keyboard)
                }
                markTippGesendet(deps)
                out.tipp = true
            }
        }
    } catch (error) { console.warn(`[Geführt] Tipp: ${String((error as Error)?.message || error).slice(0, 120)}`) }

    // Pinned status message (edited, not resent).
    try { out.angeheftet = await updatePinnedStatus(tg, await collectPinnedFacts(deps), { dataDir: deps.dataDir, now: deps.now, timeZone: deps.timeZone }) }
    catch (error) { console.warn(`[Geführt] Statusnachricht: ${String((error as Error)?.message || error).slice(0, 120)}`) }
    return out
}

export type { HilfeAntwort }
