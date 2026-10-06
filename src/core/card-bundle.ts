/**
 * Paket L (2.85.11), Punkt 3 — Fragen erreichen den Owner: EINE gebündelte
 * Telegram-Nachricht für zusammengehörige Karten (z. B. alle gefundenen
 * Geräte), mit Inline-Knöpfen je Gerät.
 *
 * - Every answer button is the existing one-time `ac:` token of exactly that
 *   card (owner only, single use, executor decides). The bundle only lays the
 *   buttons of several cards into one message.
 * - The message is EDITED when something changes (answered, new device), not
 *   sent again. Long lists are paged (`nv:` navigation, telegram-pages.ts).
 * - Exactly one reminder as a new message (when a card reaches the last
 *   quarter of its validity), then the bundle closes and the unanswered cards
 *   are listed in the next report (approval-cards `expiredCardsSince`).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { CALLBACK_PREFIX, listApprovalCards, type ApprovalCard, type CardStoreOptions } from './approval-cards.js'
import { ownerText } from './owner-text.js'
import { bundlePageToken } from '../channels/telegram-pages.js'
import { planQuestions } from './question-queue.js'

type Keyboard = Array<Array<{ text: string; callback_data: string }>>
const PAGE_SIZE = 5

interface BundleState {
    key: string
    page: number
    messages: Array<{ chatId: string; messageId: number }>
    signature?: string
    deliveredAt?: string
    remindedAt?: string
    closedAt?: string
}

export interface BundleSender {
    canSend(): Promise<boolean> | boolean
    ownerChatIds(): string[]
    send(chatId: string, text: string, keyboard: Keyboard): Promise<number | null>
    edit(chatId: string, messageId: number, text: string, keyboard: Keyboard): Promise<void>
}

const HEAD: Record<string, (n: number) => string> = {
    geraete: n => `🟡 ${n} ${n === 1 ? 'Gerät' : 'Geräte'} gefunden — verbinden?`,
    // 2.86 Paket N: one question with buttons when a room/device is ambiguous; the routine list.
    raumwahl: () => '🟡 Kurze Rückfrage — was meinst du?',
    routinen: n => `📅 ${n} ${n === 1 ? 'Routine' : 'Routinen'}`,
}
const FOOT: Record<string, string> = {
    geraete: 'Ohne dein Ja passiert nichts; geschaltet wird darüber nie.',
    raumwahl: 'Danach zeige ich dir noch einmal genau, was ich schalte.',
    routinen: 'Beenden = die Routine schaltet ab sofort nichts mehr. ✖ = behalten.',
}
const CLOSED: Record<string, string> = {
    geraete: '✅ Geräte-Fragen beantwortet. Unbeantwortete stehen im nächsten Bericht; verbinden geht jederzeit über „Geräte“ im Menü.',
    raumwahl: '✅ Beantwortet.',
    routinen: '✅ Erledigt.',
}

const file = (opts: CardStoreOptions) => join(opts.dataDir || getNovaDataDir(), 'approval-cards', 'buendel.json')
const iso = (opts: CardStoreOptions) => new Date((opts.now || Date.now)()).toISOString()

function loadStates(opts: CardStoreOptions): BundleState[] {
    try { const raw = JSON.parse(readFileSync(file(opts), 'utf8')); return Array.isArray(raw?.bundles) ? raw.bundles : [] } catch { return [] }
}
function saveState(state: BundleState, opts: CardStoreOptions): void {
    const all = loadStates(opts).filter(item => item.key !== state.key)
    mkdirSync(join(opts.dataDir || getNovaDataDir(), 'approval-cards'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(opts), { version: 1, bundles: [...all, state].slice(-20) })
}
const stateOf = (key: string, opts: CardStoreOptions): BundleState => loadStates(opts).find(item => item.key === key) || { key, page: 0, messages: [] }

function groups(key: string, opts: CardStoreOptions): ApprovalCard[][] {
    const open = listApprovalCards({ ...opts, status: 'offen' }).filter(card => card.buendel === key)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const byGroup = new Map<string, ApprovalCard[]>()
    for (const card of open) byGroup.set(card.gruppe || card.id, [...(byGroup.get(card.gruppe || card.id) || []), card])
    return [...byGroup.values()]
}

const token = (card: ApprovalCard, answer: 'ja' | 'nein') => card.buttons.find(button => button.answer === answer)?.token
const ICON: Record<string, string> = { lokal: '🏠', cloud: '☁️' }

/** Text + answer rows of one page, without navigation tokens (so the signature is stable). */
function compose(key: string, page: number, opts: CardStoreOptions): { text: string; rows: Keyboard; pages: number; page: number; count: number } | null {
    const all = groups(key, opts)
    if (!all.length) return null
    const pages = Math.ceil(all.length / PAGE_SIZE)
    const current = Math.max(0, Math.min(pages - 1, page))
    const shown = all.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
    const lines = [(HEAD[key] || (n => `🟡 ${n} Fragen warten`))(all.length)]
    const rows: Keyboard = []
    shown.forEach((group, i) => {
        const number = current * PAGE_SIZE + i + 1
        const line = ownerText(group[0].kurz || group[0].titel).slice(0, 90)
        lines.push(`${number}. ${line}`)
        const label = line.split(' · ')[0].slice(0, 28)
        const row: Keyboard[number] = []
        for (const card of group) {
            const ja = token(card, 'ja')
            if (!ja) continue
            const knopf = card.knopf ? `${ICON[card.knopf.toLowerCase()] || '✅'} ${card.knopf}` : `✅ ${number} ${label}`
            row.push({ text: knopf, callback_data: `${CALLBACK_PREFIX}${ja}` })
        }
        const nein = token(group[0], 'nein')
        if (nein) row.push({ text: `✖ ${number}`, callback_data: `${CALLBACK_PREFIX}${nein}` })
        if (row.length) rows.push(row)
    })
    if (pages > 1) lines.push(`Seite ${current + 1}/${pages}`)
    if (FOOT[key]) lines.push('', FOOT[key])
    return { text: lines.join('\n').slice(0, 600), rows, pages, page: current, count: all.length }
}

const signatureOf = (composed: { text: string; rows: Keyboard; pages: number }) => createHash('sha256').update(JSON.stringify([composed.text, composed.rows, composed.pages])).digest('hex').slice(0, 24)

function withNav(composed: NonNullable<ReturnType<typeof compose>>, key: string, chatId: string, opts: CardStoreOptions): Keyboard {
    if (composed.pages <= 1) return composed.rows
    const nav: Keyboard[number] = []
    if (composed.page > 0) nav.push({ text: '◀ Zurück', callback_data: bundlePageToken(chatId, key, composed.page - 1, opts) })
    if (composed.page < composed.pages - 1) nav.push({ text: `Weiter ▶ (${composed.page + 1}/${composed.pages})`, callback_data: bundlePageToken(chatId, key, composed.page + 1, opts) })
    return [...composed.rows, nav]
}

/**
 * 2.86 Paket N: the owner asked again (e.g. „Welche Geräte findest du?“): the next
 * delivery sends the open bundle as a NEW message (the old one may be far up).
 */
export function requestBundleResend(key: string, opts: CardStoreOptions = {}): void {
    const state = loadStates(opts).find(item => item.key === key)
    if (state?.deliveredAt) saveState({ ...state, deliveredAt: undefined, signature: undefined }, opts)
}

/** 2.86 Paket M: the bundle message is out (sent, not closed) — it is the one visible question. */
export function isBundleVisible(key: string, opts: CardStoreOptions = {}): boolean {
    const state = loadStates(opts).find(item => item.key === key)
    return Boolean(state && state.messages.length && state.deliveredAt && !state.closedAt)
}

/** The current page of a bundle for one chat (null = nothing open). */
export function renderBundle(key: string, chatId: string, opts: CardStoreOptions = {}, page?: number): { text: string; keyboard: Keyboard } | null {
    const composed = compose(key, page ?? stateOf(key, opts).page, opts)
    return composed ? { text: composed.text, keyboard: withNav(composed, key, chatId, opts) } : null
}

/** A bundle page button was pressed: remember the page and return what to show. */
export async function showBundlePage(key: string, chatId: string, page: number, opts: CardStoreOptions = {}): Promise<{ text: string; keyboard: Keyboard } | null> {
    const composed = compose(key, page, opts)
    if (!composed) return { text: CLOSED[key] || '✅ Erledigt.', keyboard: [] }
    saveState({ ...stateOf(key, opts), page: composed.page }, opts)
    return { text: composed.text, keyboard: withNav(composed, key, chatId, opts) }
}

/**
 * Sends a new bundle, edits it when it changed, reminds once, closes it when
 * nothing is open. Returns the number of bundles sent or edited.
 */
export async function deliverBundles(sender: BundleSender, opts: CardStoreOptions & { keys?: string[] } = {}): Promise<number> {
    const keys = opts.keys || [...new Set([...listApprovalCards({ ...opts, status: 'offen' }).map(card => card.buendel).filter(Boolean) as string[], ...loadStates(opts).map(item => item.key)])]
    // 2.86 Paket M: a bundle is ONE question — a new bundle message only when the queue allows it.
    const mayOpen = new Set(planQuestions({ cards: listApprovalCards({ ...opts, status: 'offen' }), bundleVisible: key => isBundleVisible(key, opts), now: (opts.now || Date.now)() }).buendel)
    let changed = 0
    for (const key of keys) {
        const state = stateOf(key, opts)
        const composed = compose(key, state.page, opts)
        if (!composed) {
            if (state.messages.length && !state.closedAt) {
                for (const target of state.messages) {
                    try { await sender.edit(target.chatId, target.messageId, CLOSED[key] || '✅ Erledigt.', []) } catch { /* message may be too old */ }
                }
                saveState({ ...state, closedAt: iso(opts), signature: undefined }, opts)
                changed++
            }
            continue
        }
        const open = groups(key, opts).flat()
        const reminderDue = open.some(card => card.erinnertAt && (!state.remindedAt || card.erinnertAt > state.remindedAt))
        const signature = signatureOf(composed)
        const fresh = !state.deliveredAt || Boolean(state.closedAt)
        if (!fresh && !reminderDue && signature === state.signature) continue
        if (fresh && !mayOpen.has(key)) continue
        if (!(await sender.canSend())) return changed
        const chats = sender.ownerChatIds().filter(id => /^\d{1,20}$/.test(id)).slice(0, 3)
        if (!chats.length) return changed
        if (fresh || reminderDue) {
            const messages = fresh ? [] : [...state.messages]
            for (const chatId of chats) {
                const keyboard = withNav(composed, key, chatId, opts)
                const text = reminderDue && !fresh ? `⏰ Erinnerung (einmal):\n${composed.text}`.slice(0, 600) : composed.text
                try {
                    const messageId = await sender.send(chatId, text, keyboard)
                    if (typeof messageId === 'number') messages.push({ chatId, messageId })
                } catch (error) { console.warn(`[Knopf-Bündel] Zustellung fehlgeschlagen: ${String((error as Error)?.message || error).slice(0, 120)}`) }
            }
            if (!messages.length) continue
            saveState({ ...state, messages: messages.slice(-6), deliveredAt: iso(opts), closedAt: undefined, signature, ...(reminderDue ? { remindedAt: iso(opts) } : {}) }, opts)
            changed++
            continue
        }
        for (const target of state.messages) {
            try { await sender.edit(target.chatId, target.messageId, composed.text, withNav(composed, key, target.chatId, opts)) } catch { /* message may be too old */ }
        }
        saveState({ ...state, signature }, opts)
        changed++
    }
    return changed
}
