/**
 * Paket L (2.85.11), Punkt 4 — Telegram übersichtlich: kurze Nachrichten,
 * Details hinter „Mehr“, Listen seitenweise, ein festes Hauptmenü.
 *
 * Navigation buttons carry `nv:<16 hex>` (19 bytes) and no parameters — like
 * the Knopf-Karten (`ac:`), the server resolves what a token means. Rules:
 * - only the owner (numeric id in allowFrom) may press,
 * - a token is bound to the chat it was sent to,
 * - navigation never executes anything: it only shows stored text or runs a
 *   registered read-only menu view. Approvals stay on `ac:` cards.
 * - tokens expire after 7 days; the store is bounded.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { isCardOwner } from '../core/approval-cards.js'
import { ampelKopf, ownerText, paginate, OWNER_PAGE_CHARS } from '../core/owner-text.js'

export { ampelKopf, ownerText, paginate, OWNER_PAGE_CHARS }

export const NAV_PREFIX = 'nv:'
const TOKEN = /^[a-f0-9]{16}$/
const TTL_MS = 7 * 24 * 60 * 60_000
const MAX_VIEWS = 200
const MAX_TOKENS = 1500

export type Keyboard = Array<Array<{ text: string; callback_data: string }>>
export type MenuAction = 'status' | 'fragen' | 'geraete' | 'bericht' | 'mehr'
export const MENU_ACTIONS: readonly MenuAction[] = ['status', 'fragen', 'geraete', 'bericht', 'mehr']

interface PagesView { id: string; chatId: string; pages: string[]; createdAt: number; menu?: boolean; back?: string; links?: Array<{ label: string; viewId: string }>; separate?: boolean }
type TokenTarget =
    | { kind: 'seite'; viewId: string; index: number }
    | { kind: 'menue'; action: MenuAction }
    | { kind: 'buendel'; key: string; page: number }
interface TokenEntry { token: string; chatId: string; createdAt: number; target: TokenTarget }
interface Store { version: 1; views: PagesView[]; tokens: TokenEntry[] }
export interface PageOptions { dataDir?: string; now?: () => number }

const file = (opts: PageOptions) => join(opts.dataDir || getNovaDataDir(), 'telegram-pages', 'views.json')
const nowOf = (opts: PageOptions) => (opts.now || Date.now)()

function load(opts: PageOptions): Store {
    try {
        const raw = JSON.parse(readFileSync(file(opts), 'utf8'))
        if (raw?.version === 1 && Array.isArray(raw.views) && Array.isArray(raw.tokens)) return raw
    } catch { /* fresh */ }
    return { version: 1, views: [], tokens: [] }
}
function save(store: Store, opts: PageOptions): void {
    const now = nowOf(opts)
    const fresh = <T extends { createdAt: number }>(list: T[]) => list.filter(item => now - item.createdAt <= TTL_MS)
    mkdirSync(join(opts.dataDir || getNovaDataDir(), 'telegram-pages'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(opts), { version: 1, views: fresh(store.views).slice(-MAX_VIEWS), tokens: fresh(store.tokens).slice(-MAX_TOKENS) })
}

const newToken = () => randomBytes(8).toString('hex')
function issue(store: Store, chatId: string, target: TokenTarget, now: number): string {
    const token = newToken()
    store.tokens.push({ token, chatId: String(chatId), createdAt: now, target })
    return `${NAV_PREFIX}${token}`
}

/** Menu row (fixed main menu). Labels without technical words. */
function menuRow(store: Store, chatId: string, counts: { fragen?: number }, now: number): Keyboard {
    const label: Record<MenuAction, string> = { status: 'Status', fragen: `Braucht mich (${Math.max(0, Number(counts.fragen) || 0)})`, geraete: 'Geräte', bericht: 'Bericht', mehr: 'Mehr' }
    return [MENU_ACTIONS.map(action => ({ text: label[action], callback_data: issue(store, chatId, { kind: 'menue', action }, now) }))]
}

export function menuKeyboard(chatId: string, counts: { fragen?: number } = {}, opts: PageOptions = {}): Keyboard {
    const store = load(opts)
    const keyboard = menuRow(store, chatId, counts, nowOf(opts))
    save(store, opts)
    return keyboard
}

function renderPage(store: Store, view: PagesView, index: number, now: number, counts: { fragen?: number }): { text: string; keyboard: Keyboard } {
    const total = view.pages.length
    const i = Math.max(0, Math.min(total - 1, index))
    const keyboard: Keyboard = []
    if (total > 1) {
        const row: Keyboard[number] = []
        if (i > 0) row.push({ text: '◀ Zurück', callback_data: issue(store, view.chatId, { kind: 'seite', viewId: view.id, index: i - 1 }, now) })
        if (i < total - 1) row.push({ text: `Mehr ▶ (${i + 1}/${total})`, callback_data: issue(store, view.chatId, { kind: 'seite', viewId: view.id, index: i + 1 }, now) })
        keyboard.push(row)
    }
    const links = (view.links || []).map(link => ({ text: link.label, callback_data: issue(store, view.chatId, { kind: 'seite', viewId: link.viewId, index: 0 }, now) }))
    for (let j = 0; j < links.length; j += 2) keyboard.push(links.slice(j, j + 2))
    if (view.back) keyboard.push([{ text: '↩ Übersicht', callback_data: issue(store, view.chatId, { kind: 'seite', viewId: view.back, index: 0 }, now) }])
    if (view.menu) keyboard.push(...menuRow(store, view.chatId, counts, now))
    return { text: view.pages[i], keyboard }
}

/** Sections that mean "this needs you" — the overview's top 3 come from here, in this order. */
const BRAUCHT_DICH = ['Wartet auf dich', 'Fragen in der Warteschlange', 'Ohne Antwort abgelaufen', 'Fragen gesammelt'] as const

/**
 * 2.89.4: the report is a short story, not a counter wall — up to three open
 * points as short sentences, one summary sentence, counters at most as one
 * line. Nothing to say = „Alles ruhig“.
 */
export function overviewText(input: { kopf: string; titel: string; sections: Array<{ titel: string; zeilen: string[] }> }): string {
    const braucht = input.sections.filter(section => (BRAUCHT_DICH as readonly string[]).includes(section.titel)).flatMap(section => section.zeilen).filter(Boolean)
    const erledigt = input.sections.filter(section => ['Erledigt', 'Selbst repariert', 'Installiert'].includes(section.titel)).reduce((sum, section) => sum + section.zeilen.length, 0)
    const gelernt = input.sections.filter(section => ['Neu gemerkt', 'Selbst übernommen', 'Ideen', 'Skills'].includes(section.titel)).reduce((sum, section) => sum + section.zeilen.length, 0)
    const ruhige = input.sections.filter(section => ['Zur Info', 'Zurückgehalten', 'Hintergrundprüfungen', 'Lernkurve'].includes(section.titel)).reduce((sum, section) => sum + section.zeilen.length, 0)
    const zaehler = [`Erledigt ${erledigt}`, gelernt ? `gemerkt/ideen ${gelernt}` : '', ruhige ? `ruhig/notiert ${ruhige}` : ''].filter(Boolean).join(' · ')
    if (!braucht.length && !erledigt && !gelernt && !ruhige) {
        return `${input.kopf}\n${input.titel}\n\nAlles ruhig – nichts Neues.`
    }
    if (!braucht.length) {
        return `${input.kopf}\n${input.titel}\n\nAlles ruhig – nichts, das dich gerade braucht.\n${zaehler}`
    }
    const top = braucht.slice(0, 3).map(zeile => `• ${String(zeile).replace(/\s+/g, ' ').trim().slice(0, 140)}`)
    const rest = braucht.length - top.length
    const satz = rest > 0
        ? `Kurz: ${braucht.length === 1 ? '1 Punkt braucht dich' : `${braucht.length} Punkte brauchen dich`} – die ${rest === 1 ? 'weitere steht' : 'weiteren stehen'} in den Abschnitten.`
        : `Kurz: ${braucht.length === 1 ? 'der eine Punkt braucht dich' : 'mehr braucht dich gerade nicht'}.`
    return [input.kopf, input.titel, '', ...top, satz, zaehler].join('\n')
}

/**
 * Paket L: a report as ONE short message — traffic light, title, up to three
 * open points, one summary line — with one button per section (its lines,
 * paged) and the main menu.
 */
export function sectionedView(chatId: string, input: { kopf: string; titel: string; sections: Array<{ titel: string; zeilen: string[] }> }, opts: PageOptions & { counts?: { fragen?: number } } = {}): { text: string; keyboard: Keyboard } {
    const store = load(opts)
    const now = nowOf(opts)
    const overview: PagesView = { id: newToken(), chatId: String(chatId), pages: [], createdAt: now, menu: true, links: [] }
    for (const section of input.sections.slice(0, 12)) {
        const lines = section.zeilen.map(line => `• ${line}`)
        const view: PagesView = { id: newToken(), chatId: String(chatId), pages: capPages(paginate(`${section.titel}\n${lines.join('\n')}`), OWNER_SYSTEM_MAX_PAGES), createdAt: now, back: overview.id }
        store.views.push(view)
        overview.links!.push({ label: `${section.titel} (${section.zeilen.length})`.slice(0, 40), viewId: view.id })
    }
    overview.pages = [overviewText(input).slice(0, OWNER_PAGE_CHARS)]
    store.views.push(overview)
    const rendered = renderPage(store, overview, 0, now, opts.counts || {})
    save(store, opts)
    return rendered
}

/**
 * Stores a long text and returns its first page with „Mehr ▶“ (and the main
 * menu when `menu` is set). A text that fits gets no navigation buttons.
 */
export function pagedView(chatId: string, text: string, opts: PageOptions & { menu?: boolean; counts?: { fragen?: number }; max?: number; kopf?: string; maxPages?: number } = {}): { text: string; keyboard: Keyboard } {
    const body = String(text ?? '').trim()
    const head = opts.kopf ? `${opts.kopf}\n\n` : ''
    const pageMax = Math.max(200, (opts.max || OWNER_PAGE_CHARS) - head.length)
    let pages = paginate(body, pageMax).map((page, i) => i === 0 ? `${head}${page}` : page)
    // 2.86.1 Punkt 1: owner system messages never get more than a few pages — the rest is in the app.
    if (opts.maxPages && opts.maxPages > 0 && pages.length > opts.maxPages) pages = capPages(pages, opts.maxPages, pageMax)
    if (pages.length === 1 && !opts.menu) return { text: pages[0], keyboard: [] }
    const store = load(opts)
    const now = nowOf(opts)
    const view: PagesView = { id: newToken(), chatId: String(chatId), pages, createdAt: now, ...(opts.menu ? { menu: true } : {}) }
    store.views.push(view)
    const rendered = renderPage(store, view, 0, now, opts.counts || {})
    save(store, opts)
    return rendered
}

/** Höchstzahl Telegram-Seiten einer Owner-Systemnachricht (2.86.1). */
export const OWNER_SYSTEM_MAX_PAGES = 3
export const GEKUERZT_HINWEIS = '… gekürzt – den ganzen Text findest du in der App.'

/** Keeps the first `maxPages` pages; the last one ends with a note where the rest is. */
export function capPages(pages: readonly string[], maxPages: number, pageMax = OWNER_PAGE_CHARS): string[] {
    if (pages.length <= maxPages) return [...pages]
    const kept = pages.slice(0, maxPages)
    const lines = kept[maxPages - 1].split('\n')
    while (lines.length > 1 && lines.join('\n').length + 1 + GEKUERZT_HINWEIS.length > pageMax) lines.pop()
    const last = lines.join('\n')
    kept[maxPages - 1] = `${last.length + 1 + GEKUERZT_HINWEIS.length > pageMax ? last.slice(0, Math.max(0, pageMax - GEKUERZT_HINWEIS.length - 2)) : last}\n${GEKUERZT_HINWEIS}`
    return kept
}

/** „Details“ under a card: shows the full evidence as a separate message (the card keeps its buttons). */
export function detailsButton(chatId: string, text: string, opts: PageOptions = {}): { text: string; callback_data: string } {
    const store = load(opts)
    const now = nowOf(opts)
    const view: PagesView = { id: newToken(), chatId: String(chatId), pages: capPages(paginate(String(text ?? '')), OWNER_SYSTEM_MAX_PAGES), createdAt: now, separate: true }
    store.views.push(view)
    const data = issue(store, chatId, { kind: 'seite', viewId: view.id, index: 0 }, now)
    save(store, opts)
    return { text: 'Details', callback_data: data }
}

/** Paket L: the last report overview, for the menu entry „Bericht“. */
export function rememberLastReport(report: { titel: string; kopf: string; sections: Array<{ titel: string; zeilen: string[] }> }, opts: PageOptions = {}): void {
    mkdirSync(join(opts.dataDir || getNovaDataDir(), 'telegram-pages'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(join(opts.dataDir || getNovaDataDir(), 'telegram-pages', 'last-report.json'), { version: 1, at: new Date(nowOf(opts)).toISOString(), ...report })
}
export function lastReport(opts: PageOptions = {}): { titel: string; kopf: string; sections: Array<{ titel: string; zeilen: string[] }> } | null {
    try { const raw = JSON.parse(readFileSync(join(opts.dataDir || getNovaDataDir(), 'telegram-pages', 'last-report.json'), 'utf8')); return Array.isArray(raw?.sections) ? raw : null } catch { return null }
}

/** A bundle page button (card-bundle.ts) — navigation only, the answers stay on `ac:` tokens. */
export function bundlePageToken(chatId: string, key: string, page: number, opts: PageOptions = {}): string {
    const store = load(opts)
    const data = issue(store, chatId, { kind: 'buendel', key, page }, nowOf(opts))
    save(store, opts)
    return data
}

export interface NavPresser { userId: string; ownerIds: readonly string[]; chatId: string }
export interface NavResult {
    ok: boolean
    message?: string
    /** Edit the pressed message in place. */
    edit?: { text: string; keyboard: Keyboard }
    /** Show as a new message (details of a card: the card keeps its buttons). */
    send?: { text: string; keyboard: Keyboard }
    /** Menu entry: the caller runs the read-only view (`runMenu`). */
    menu?: MenuAction
    /** Bundle page: the caller re-renders the bundle (card-bundle.ts). */
    bundle?: { key: string; page: number }
}

export function pressNav(data: string, presser: NavPresser, opts: PageOptions & { counts?: { fragen?: number } } = {}): NavResult {
    const raw = String(data ?? '')
    const token = raw.startsWith(NAV_PREFIX) ? raw.slice(NAV_PREFIX.length) : ''
    if (!TOKEN.test(token)) return { ok: false, message: 'Unbekannter Knopf.' }
    if (!isCardOwner(presser?.userId, presser?.ownerIds || [])) return { ok: false, message: '🔒 Nur der Owner.' }
    const store = load(opts)
    const now = nowOf(opts)
    const entry = store.tokens.find(item => item.token === token)
    if (!entry || now - entry.createdAt > TTL_MS) return { ok: false, message: 'Knopf abgelaufen — bitte Menü neu öffnen (/menu).' }
    if (String(presser.chatId) !== entry.chatId) return { ok: false, message: '🔒 Dieser Knopf gehört zu einem anderen Chat.' }
    const target = entry.target
    if (target.kind === 'menue') return MENU_ACTIONS.includes(target.action) ? { ok: true, menu: target.action } : { ok: false, message: 'Unbekannter Knopf.' }
    if (target.kind === 'buendel') return { ok: true, bundle: { key: target.key, page: target.page } }
    const view = store.views.find(item => item.id === target.viewId && item.chatId === entry.chatId)
    if (!view) return { ok: false, message: 'Inhalt nicht mehr vorhanden.' }
    const rendered = renderPage(store, view, target.index, now, opts.counts || {})
    save(store, opts)
    // the first page of a separate view (card details) comes as a new message; its pages then edit that one
    return view.separate && target.index === 0 && entry.target.kind === 'seite' && !view.back ? { ok: true, send: rendered } : { ok: true, edit: rendered }
}

// ---------------------------------------------------------------------------
// main menu views (read only)
// ---------------------------------------------------------------------------

export type MenuProvider = (ctx: { chatId: string }) => Promise<{ titel: string; text: string; kritisch?: number; fragen?: number }>
const providers = new Map<MenuAction, MenuProvider>()
export function registerMenuProvider(action: MenuAction, provider: MenuProvider): void {
    if (!MENU_ACTIONS.includes(action) || typeof provider !== 'function') throw new Error('Ungültiger Menü-Eintrag')
    providers.set(action, provider)
}
export function hasMenuProvider(action: MenuAction): boolean { return providers.has(action) }

/** Runs a read-only menu view and returns the first page with paging + the main menu. */
export async function runMenu(action: MenuAction, chatId: string, opts: PageOptions & { counts?: { fragen?: number } } = {}): Promise<{ text: string; keyboard: Keyboard }> {
    const provider = providers.get(action)
    let view: Awaited<ReturnType<MenuProvider>>
    try { view = provider ? await provider({ chatId }) : { titel: 'Menü', text: 'Dafür gibt es hier noch keine Ansicht.' } }
    catch { view = { titel: 'Menü', text: 'Diese Ansicht ist gerade nicht verfügbar.' } }
    const fragen = view.fragen ?? opts.counts?.fragen ?? 0
    const kopf = `${ampelKopf({ kritisch: view.kritisch, fragen })}\n${view.titel}`
    return pagedView(chatId, ownerText(view.text), { ...opts, menu: true, counts: { fragen }, kopf })
}
